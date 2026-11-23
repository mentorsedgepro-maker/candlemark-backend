import { redis } from './redis.js';
import { env } from '../config/env.js';

// Cloudflare Turnstile. If TURNSTILE_SECRET is unset (local dev) the check is skipped;
// in production the env schema requires it.
export async function verifyTurnstile(token: string | undefined, ip: string): Promise<boolean> {
  if (!env.TURNSTILE_SECRET) return true;
  if (!token) return false;
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token, remoteip: ip }),
      signal: AbortSignal.timeout(5000),
    });
    const data = (await res.json()) as { success?: boolean };
    return data.success === true;
  } catch {
    return false; // fail closed
  }
}

// Small starter list of throwaway-mail domains. Extend as needed.
const DISPOSABLE = new Set([
  'mailinator.com', 'guerrillamail.com', 'guerrillamail.net', '10minutemail.com', 'tempmail.com', 'temp-mail.org',
  'yopmail.com', 'trashmail.com', 'sharklasers.com', 'getnada.com', 'dispostable.com', 'maildrop.cc', 'throwawaymail.com',
  'fakeinbox.com', 'mintemail.com', 'emailondeck.com', 'mohmal.com', 'tempail.com', 'burnermail.io', 'moakt.com',
]);
export const isDisposable = (email: string) => DISPOSABLE.has(email.split('@')[1]?.toLowerCase() ?? '');

// Fixed-window counter shared across all instances. Returns true if still under the limit.
export async function underGlobalLimit(key: string, max: number, windowSec: number): Promise<boolean> {
  try {
    const k = `abuse:${key}`;
    const n = await redis.incr(k);
    if (n === 1) await redis.expire(k, windowSec);
    return n <= max;
  } catch {
    return true; // don't lock everyone out if Redis hiccups
  }
}
