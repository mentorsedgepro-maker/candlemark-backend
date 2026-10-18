import type { FastifyPluginAsync } from 'fastify';
import { redis } from '../../lib/redis.js';

const URLS = [
  'https://nfs.faireconomy.media/ff_calendar_thisweek.json',
  'https://cdn-nfs.faireconomy.media/ff_calendar_thisweek.json',
];

async function load() {
  const hit = await redis.get('cal:data');
  if (hit) return JSON.parse(hit);
  const stale = await redis.get('cal:stale');
  if (await redis.get('cal:fail')) return stale ? JSON.parse(stale) : [];
  try {
    let raw: unknown;
    for (const u of URLS) {
      const r = await fetch(u, { signal: AbortSignal.timeout(8000), headers: { 'user-agent': 'Mozilla/5.0', accept: 'application/json' } }).catch(() => null);
      if (r?.ok) { raw = await r.json().catch(() => null); if (Array.isArray(raw) && raw.length) break; }
      else console.error('calendar status', u, r?.status);
    }
    if (!Array.isArray(raw) || !raw.length) throw new Error('BAD_PAYLOAD');
    const items = raw.map((event: any) => ({
      title: String(event.title ?? ''),
      ccy: String(event.country ?? ''),
      date: String(event.date ?? ''),
      impact: String(event.impact ?? 'Low'),
      forecast: String(event.forecast ?? ''),
      previous: String(event.previous ?? ''),
    }));
    const serialized = JSON.stringify(items);
    await redis.set('cal:data', serialized, 'EX', 3600);
    await redis.set('cal:stale', serialized, 'EX', 7 * 86400);
    return items;
  } catch (error) {
    console.error('calendar fetch failed', error);
    await redis.set('cal:fail', '1', 'EX', 300);
    return stale ? JSON.parse(stale) : [];
  }
}

export const calendarRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async () => ({ items: await load() }));
};