import { Hono } from 'hono';
import type { AppEnv } from '../http';
import { JUDGE_DELETE_AT } from '../judge';
import policy from '../showcasePolicy.json';

export const showcaseRoutes = new Hono<AppEnv>();

const OPAQUE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KINDS = new Set(['thought', 'growth', 'outfit']);
const DELIVERIES = new Set(['save', 'share']);

showcaseRoutes.get('/api/showcase', async (c) => {
  const copy = await c.env.SHOWCASE.get(c.env.SHOWCASE.idFromName('public')).read();
  return c.json(copy ?? { pets: [], numbers: null });
});

// Public, non-secret admission timing for the browser's same-tab Google return.
showcaseRoutes.get('/api/showcase/policy', (c) => c.json({ judgeExpiresAt: policy.judgeExpiresAt }));

showcaseRoutes.post('/api/showcase/card-shared', async (c) => {
  if (c.get('session') === null) return c.json({ code: 'signed_out' }, 401);
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (body === null || Object.keys(body).sort().join(',') !== 'at,delivery,kind,petId,playerId,tabId'
    || !KINDS.has(String(body.kind)) || !DELIVERIES.has(String(body.delivery))
    || !Number.isSafeInteger(body.at) || Number(body.at) < 0
    || ![body.tabId, body.playerId, body.petId].every((value) => typeof value === 'string' && OPAQUE_ID.test(value))) {
    return c.json({ code: 'bad_request' }, 400);
  }
  if (Date.now() >= JUDGE_DELETE_AT) return c.body(null, 204);
  try {
    const now = Date.now();
    const ip = c.req.header('cf-connecting-ip') ?? 'unknown';
    const ipBytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ip)));
    const ipKey = Array.from(ipBytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    await c.env.EVENTS.prepare(
      `INSERT INTO showcase_event_attempt
       (id, at, kind, delivery, tab_id, player_id, pet_id, ip_key, minute_bucket, day_bucket)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(crypto.randomUUID(), body.at, body.kind, body.delivery, body.tabId,
      body.playerId, body.petId, ipKey, Math.floor(now / 60_000), Math.floor(now / 86_400_000)).run();
  } catch {
    // A lost playtest event never changes the card delivery or exposes its payload in a log.
    console.log('card_event_write_failed');
  }
  return c.body(null, 204);
});
