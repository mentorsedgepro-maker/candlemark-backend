import type { FastifyPluginAsync, FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import argon2 from 'argon2';
import { createHash, randomBytes } from 'node:crypto';
import { authenticator } from 'otplib';
import { prisma } from '../../lib/prisma.js';
import { encrypt, decrypt } from '../../lib/crypto.js';
import { audit } from '../../lib/audit.js';
import { env } from '../../config/env.js';
import { sendOtp, checkOtp } from './otp.js';
import { redis } from '../../lib/redis.js';
import { verifyTurnstile, isDisposable, underGlobalLimit } from '../../lib/antiabuse.js';
import { tierOf } from '../tier/tier.js';

authenticator.options = { window: 1 }; // tolerate ±30s clock drift

const RT_DAYS = 30;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const prod = env.NODE_ENV === 'production';
const cookieOpts = {
  path: '/auth', httpOnly: true, sameSite: (prod ? 'none' : 'lax') as 'none' | 'lax',
  secure: prod, maxAge: RT_DAYS * 86400,
};

async function issue(app: FastifyInstance, reply: FastifyReply, u: { id: string; role: string }, ua?: string, persist = true) {
  const raw = randomBytes(48).toString('base64url');
  await prisma.refreshToken.create({
    data: { userId: u.id, tokenHash: sha(raw), userAgent: ua, expiresAt: new Date(Date.now() + (persist ? RT_DAYS : 1) * 864e5) },
  });
  const { maxAge, ...sessionOpts } = cookieOpts;
  reply.setCookie('rt', raw, persist ? cookieOpts : sessionOpts);
  return app.jwt.sign({ sub: u.id, role: u.role });
}

const registerBody = z.object({
  name: z.string().trim().min(2).max(100),
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(8).max(128),
  country: z.string().trim().max(60).optional(),
  captcha: z.string().max(4096).optional(), // Cloudflare Turnstile token
  website: z.string().max(200).optional(),  // honeypot: hidden field, real users leave it empty
});
const loginBody = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1).max(128),
  totp: z.string().regex(/^\d{6}$/).optional(),
  remember: z.boolean().optional(),
});
const codeBody = z.object({ code: z.string().regex(/^\d{6}$/) });

const publicUser = (u: { id: string; email: string; name: string; country: string | null; role: string; totpEnabled: boolean; avatarUrl: string | null }) =>
  ({ id: u.id, email: u.email, name: u.name, country: u.country, role: u.role, totpEnabled: u.totpEnabled, avatarUrl: u.avatarUrl });

export const authRoutes: FastifyPluginAsync = async (app) => {
  // Signups stay in Redis until the email code is confirmed; no User row exists before that.
  const PENDING_TTL = 3600;
  const pendingKey = (email: string) => `reg:pending:${email}`;
  const pendingOtpId = (email: string) => `p:${email}`;
  const registered = (email: string) => ({ needsVerification: true, email });

  app.post('/register', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req, reply) => {
    const b = registerBody.parse(req.body);
    if (b.website) return reply.code(201).send(registered(b.email)); // honeypot tripped: pretend success
    if (!(await verifyTurnstile(b.captcha, req.ip))) return reply.code(400).send({ error: 'CAPTCHA_FAILED' });
    if (isDisposable(b.email)) return reply.code(400).send({ error: 'EMAIL_DOMAIN_NOT_ALLOWED' });
    if (!(await underGlobalLimit('register:hour', 300, 3600))) return reply.code(429).send({ error: 'TRY_AGAIN_LATER' });

    const passwordHash = await argon2.hash(b.password);
    const existing = await prisma.user.findUnique({ where: { email: b.email } });
    if (existing) {
      // Same response as a new signup so the form can't be used to discover registered emails.
      if (existing.status === 'ACTIVE' && !existing.emailVerified) await sendOtp(existing.id, existing.email, 'verify');
      return reply.code(201).send(registered(b.email));
    }

    await redis.set(pendingKey(b.email), JSON.stringify({ name: b.name, country: b.country, passwordHash, ip: req.ip }), 'EX', PENDING_TTL);
    await sendOtp(pendingOtpId(b.email), b.email, 'verify');
    return reply.code(201).send(registered(b.email));
  });

  app.post('/login', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const b = loginBody.parse(req.body);
    const user = await prisma.user.findUnique({ where: { email: b.email } });
    if (!user || !(await argon2.verify(user.passwordHash, b.password))) {
      await audit(user?.id ?? null, 'auth.login_failed', req.ip);
      return reply.code(401).send({ error: 'INVALID_CREDENTIALS' });
    }
    if (user.status !== 'ACTIVE') return reply.code(403).send({ error: 'ACCOUNT_SUSPENDED' });
    if (!user.emailVerified) {
      await sendOtp(user.id, user.email, 'verify');
      return reply.code(403).send({ error: 'EMAIL_NOT_VERIFIED', email: user.email });
    }
    if (user.totpEnabled) {
      if (!b.totp) return reply.code(401).send({ error: 'TOTP_REQUIRED' });
      if (!authenticator.verify({ token: b.totp, secret: decrypt(user.totpSecret!) })) {
        await audit(user.id, 'auth.totp_failed', req.ip);
        return reply.code(401).send({ error: 'INVALID_TOTP' });
      }
    }
    await audit(user.id, 'auth.login', req.ip);
    const accessToken = await issue(app, reply, user, req.headers['user-agent'], b.remember ?? true);
    return { accessToken, user: publicUser(user) };
  });

  const emailBody = z.object({ email: z.string().trim().toLowerCase().email() });
  const otpBody = emailBody.extend({ code: z.string().regex(/^\d{6}$/) });

  app.post('/verify-email', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = otpBody.parse(req.body);

    const pending = await redis.get(pendingKey(body.email));
    if (pending) {
      if (!(await checkOtp(pendingOtpId(body.email), 'verify', body.code))) return reply.code(400).send({ error: 'INVALID_CODE' });
      const p = JSON.parse(pending) as { name: string; country?: string; passwordHash: string; ip?: string };
      let user;
      try {
        user = await prisma.$transaction(async (tx) => {
          const u = await tx.user.create({
            data: { email: body.email, name: p.name, country: p.country, passwordHash: p.passwordHash, emailVerified: true, accounts: { create: { type: 'LIVE' } } },
          });
          await tx.kycProfile.create({ data: { userId: u.id } });
          return u;
        });
      } catch (e) {
        if ((e as { code?: string }).code === 'P2002') return reply.code(400).send({ error: 'INVALID_CODE' }); // already created
        throw e;
      }
      await redis.del(pendingKey(body.email));
      await audit(user.id, 'auth.register', p.ip ?? req.ip);
      await audit(user.id, 'auth.email_verified', req.ip);
      const accessToken = await issue(app, reply, user, req.headers['user-agent']);
      return { accessToken, user: publicUser(user) };
    }

    // Accounts created before this change that never verified
    const user = await prisma.user.findUnique({ where: { email: body.email } });
    if (!user || user.status !== 'ACTIVE' || !(await checkOtp(user.id, 'verify', body.code)))
      return reply.code(400).send({ error: 'INVALID_CODE' });
    const verifiedUser = await prisma.user.update({ where: { id: user.id }, data: { emailVerified: true } });
    await audit(user.id, 'auth.email_verified', req.ip);
    const accessToken = await issue(app, reply, verifiedUser, req.headers['user-agent']);
    return { accessToken, user: publicUser(verifiedUser) };
  });

  app.post('/resend-otp', { config: { rateLimit: { max: 3, timeWindow: '1 minute' } } }, async (req) => {
    const { email } = emailBody.parse(req.body);
    if (await redis.exists(pendingKey(email))) { await sendOtp(pendingOtpId(email), email, 'verify'); return { ok: true }; }
    const user = await prisma.user.findUnique({ where: { email } });
    if (user && user.status === 'ACTIVE' && !user.emailVerified) await sendOtp(user.id, user.email, 'verify');
    return { ok: true };
  });

  app.post('/forgot-password', { config: { rateLimit: { max: 3, timeWindow: '1 minute' } } }, async (req) => {
    const { email } = emailBody.parse(req.body);
    const user = await prisma.user.findUnique({ where: { email } });
    if (user && user.status === 'ACTIVE') await sendOtp(user.id, user.email, 'reset');
    return { ok: true };
  });

  app.post('/reset-password', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = otpBody.extend({ password: z.string().min(8).max(128) }).parse(req.body);
    const user = await prisma.user.findUnique({ where: { email: body.email } });
    if (!user || user.status !== 'ACTIVE' || !(await checkOtp(user.id, 'reset', body.code)))
      return reply.code(400).send({ error: 'INVALID_CODE' });
    await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await argon2.hash(body.password), emailVerified: true } });
    await prisma.refreshToken.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } });
    await audit(user.id, 'auth.password_reset', req.ip);
    return { ok: true };
  });

  app.post('/refresh', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const raw = req.cookies.rt;
    if (!raw) return reply.code(401).send({ error: 'NO_REFRESH' });
    const t = await prisma.refreshToken.findUnique({ where: { tokenHash: sha(raw) }, include: { user: true } });
    if (!t || t.expiresAt < new Date()) return reply.code(401).send({ error: 'INVALID_REFRESH' });
    if (t.user.status !== 'ACTIVE') return reply.code(403).send({ error: 'ACCOUNT_SUSPENDED' });
    if (t.revokedAt) {
      await prisma.refreshToken.updateMany({ where: { userId: t.userId, revokedAt: null }, data: { revokedAt: new Date() } });
      await audit(t.userId, 'auth.refresh_reuse', req.ip);
      return reply.code(401).send({ error: 'INVALID_REFRESH' });
    }
    await prisma.refreshToken.update({ where: { id: t.id }, data: { revokedAt: new Date() } });
    const persist = t.expiresAt.getTime() - t.createdAt.getTime() > 2 * 864e5;
    const accessToken = await issue(app, reply, t.user, req.headers['user-agent'], persist);
    return { accessToken, user: publicUser(t.user) };
  });

  app.post('/logout', async (req, reply) => {
    const raw = req.cookies.rt;
    if (raw) await prisma.refreshToken.updateMany({ where: { tokenHash: sha(raw), revokedAt: null }, data: { revokedAt: new Date() } });
    reply.clearCookie('rt', { path: '/auth', sameSite: cookieOpts.sameSite, secure: prod });
    return { ok: true };
  });

  app.get('/me', { preHandler: app.auth }, async (req, reply) => {
    const u = await prisma.user.findUnique({
      where: { id: req.user.sub },
      include: { kyc: { select: { status: true } }, accounts: { select: { id: true, type: true, currency: true } } },
    });
    if (!u) return reply.code(401).send({ error: 'UNAUTHORIZED' });
    return {
      ...publicUser(u),
      createdAt: u.createdAt,
      kycStatus: u.kyc?.status ?? 'NOT_STARTED',
      accounts: u.accounts,
      tier: await tierOf(u.id),
    };
  });

  app.patch('/me', { preHandler: app.auth }, async (req) => {
    const b = z.object({ name: z.string().trim().min(2).max(100), country: z.string().trim().max(60).optional() }).parse(req.body);
    const u = await prisma.user.update({ where: { id: req.user.sub }, data: { name: b.name, country: b.country || null } });
    await audit(u.id, 'auth.profile_update', req.ip);
    return publicUser(u);
  });

  app.post('/change-password', { preHandler: app.auth, config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req, reply) => {
    const b = z.object({ current: z.string().min(1).max(128), password: z.string().min(8).max(128) }).parse(req.body);
    const u = await prisma.user.findUniqueOrThrow({ where: { id: req.user.sub } });
    if (!(await argon2.verify(u.passwordHash, b.current))) return reply.code(400).send({ error: 'INVALID_CREDENTIALS' });
    await prisma.user.update({ where: { id: u.id }, data: { passwordHash: await argon2.hash(b.password) } });
    await prisma.refreshToken.updateMany({ where: { userId: u.id, revokedAt: null }, data: { revokedAt: new Date() } });
    await audit(u.id, 'auth.password_change', req.ip);
    return { ok: true };
  });

  // Lost authenticator: admin proves password + emailed code, 2FA is wiped, a session is issued so a new one can be set up.
  const reset2faBody = z.object({ email: z.string().trim().toLowerCase().email(), password: z.string().min(1).max(128) });
  async function verifyAdminCreds(b: z.infer<typeof reset2faBody>) {
    const user = await prisma.user.findUnique({ where: { email: b.email } });
    if (!user || !(await argon2.verify(user.passwordHash, b.password))) return { ok: false as const, err: 'INVALID_CREDENTIALS' as const, code: 401 };
    if (user.status !== 'ACTIVE') return { ok: false as const, err: 'ACCOUNT_SUSPENDED' as const, code: 403 };
    if (user.role !== 'ADMIN') return { ok: false as const, err: 'FORBIDDEN' as const, code: 403 };
    return { ok: true as const, user };
  }

  app.post('/2fa/reset-request', { config: { rateLimit: { max: 3, timeWindow: '1 minute' } } }, async (req, reply) => {
    const r = await verifyAdminCreds(reset2faBody.parse(req.body));
    if (!r.ok) { await audit(null, 'auth.2fa_reset_denied', req.ip); return reply.code(r.code).send({ error: r.err }); }
    await sendOtp(r.user.id, r.user.email, 'reset2fa');
    await audit(r.user.id, 'auth.2fa_reset_requested', req.ip);
    return { ok: true };
  });

  app.post('/2fa/reset', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req, reply) => {
    const b = reset2faBody.extend({ code: z.string().regex(/^\d{6}$/) }).parse(req.body);
    const r = await verifyAdminCreds(b);
    if (!r.ok) return reply.code(r.code).send({ error: r.err });
    if (!(await checkOtp(r.user.id, 'reset2fa', b.code))) return reply.code(400).send({ error: 'INVALID_CODE' });
    await prisma.user.update({ where: { id: r.user.id }, data: { totpEnabled: false, totpSecret: null } });
    await prisma.refreshToken.updateMany({ where: { userId: r.user.id, revokedAt: null }, data: { revokedAt: new Date() } });
    await audit(r.user.id, 'auth.2fa_reset', req.ip);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: r.user.id } });
    const accessToken = await issue(app, reply, user, req.headers['user-agent']);
    return { accessToken, user: publicUser(user) };
  });

  app.post('/2fa/setup', { preHandler: app.auth }, async (req) => {
    const u = await prisma.user.findUniqueOrThrow({ where: { id: req.user.sub } });
    const secret = authenticator.generateSecret();
    await prisma.user.update({ where: { id: u.id }, data: { totpSecret: encrypt(secret), totpEnabled: false } });
    return { secret, otpauth: authenticator.keyuri(u.email, 'MentorsEdgePro', secret) };
  });

  app.post('/2fa/enable', { preHandler: app.auth }, async (req, reply) => {
    const { code } = codeBody.parse(req.body);
    const u = await prisma.user.findUniqueOrThrow({ where: { id: req.user.sub } });
    if (!u.totpSecret || !authenticator.verify({ token: code, secret: decrypt(u.totpSecret) }))
      return reply.code(400).send({ error: 'INVALID_TOTP' });
    await prisma.user.update({ where: { id: u.id }, data: { totpEnabled: true } });
    await audit(u.id, 'auth.2fa_enabled', req.ip);
    return { ok: true };
  });

  app.post('/2fa/disable', { preHandler: app.auth }, async (req, reply) => {
    const { code } = codeBody.parse(req.body);
    const u = await prisma.user.findUniqueOrThrow({ where: { id: req.user.sub } });
    if (!u.totpSecret || !authenticator.verify({ token: code, secret: decrypt(u.totpSecret) }))
      return reply.code(400).send({ error: 'INVALID_TOTP' });
    await prisma.user.update({ where: { id: u.id }, data: { totpEnabled: false, totpSecret: null } });
    await audit(u.id, 'auth.2fa_disabled', req.ip);
    return { ok: true };
  });
};