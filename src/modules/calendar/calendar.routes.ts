import type { FastifyPluginAsync } from 'fastify';
import { redis } from '../../lib/redis.js';

const URL_ = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';

async function load() {
  const hit = await redis.get('cal:data');
  if (hit) return JSON.parse(hit);
  const stale = await redis.get('cal:stale');
  if (await redis.get('cal:fail')) return stale ? JSON.parse(stale) : [];
  try {
    const response = await fetch(URL_, {
      signal: AbortSignal.timeout(8000),
      headers: { 'user-agent': 'Mozilla/5.0', accept: 'application/json' },
    });
    if (!response.ok) throw new Error(String(response.status));
    const raw = await response.json();
    if (!Array.isArray(raw) || !raw.length) throw new Error('BAD_PAYLOAD');
    const items = raw.map((event) => ({
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