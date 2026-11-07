// Private directed relationships: each read checks the current chain owner before D1 is read.
import { Hono } from 'hono';
import { ChainUnreachable, petView } from '../chain';
import type { AppEnv } from '../http';
import type { Stance } from '../society/relations';
import { OPAQUE_ID } from '../experience/events';
import { utcDay } from '../http';
import { recordSocietyEvent } from '../society/events';
import { ownedPet } from './thoughts';

export const societyRoutes = new Hono<AppEnv>();

interface SummaryRow {
  other_id: string;
  stance: Stance;
  break_until: number | null;
}

societyRoutes.get('/api/pets/:id/relationships', async (c) => {
  const owned = await ownedPet(c);
  if (owned instanceof Response) return owned;

  const rows = await c.env.DB.prepare(
    `SELECT other_id, stance, break_until FROM society_relations
     WHERE token_id = ? ORDER BY created_at, other_id LIMIT 32`,
  ).bind(owned.id).all<SummaryRow>();

  // Names are public chain facts. Any failed view closes the whole private response.
  let named: { tokenId: string; name: string; stance: Stance; breakUntil: number | null }[];
  try {
    named = (await Promise.all(rows.results.map(async (row) => {
      const other = await petView(c.env, row.other_id);
      return other === null ? null : {
        tokenId: row.other_id, name: other.name, stance: row.stance, breakUntil: row.break_until,
      };
    }))).filter((row): row is NonNullable<typeof row> => row !== null);
  } catch (e) {
    if (e instanceof ChainUnreachable) return c.json({ code: 'chain_unreachable' }, 503);
    throw e;
  }

  // A transfer during the name reads must not hand an old tab the private rows.
  const stillOwned = await ownedPet(c);
  if (stillOwned instanceof Response) return stillOwned;
  if (stillOwned.pet.transfer_generation !== owned.pet.transfer_generation)
    return c.json({ code: 'not_owner' }, 403);

  return c.json({ tokenId: owned.id, name: owned.pet.name, relationships: named });
});

societyRoutes.post('/api/pets/:id/society/diary-seen', async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (body === null || Object.keys(body).sort().join(',') !== 'eventId,petId,playerId,tabId' ||
    Object.values(body).some((value) => typeof value !== 'string' || !OPAQUE_ID.test(value)))
    return c.json({ code: 'bad_request' }, 400);
  const owned = await ownedPet(c);
  if (owned instanceof Response) return owned;
  const line = await c.env.DB.prepare('SELECT 1 AS found FROM society_diary_lines WHERE token_id = ? AND day = ? LIMIT 1')
    .bind(owned.id, utcDay(Date.now())).first();
  if (line === null) return c.json({ code: 'no_social_line' }, 409);
  await recordSocietyEvent(c.env, 'society_diary_seen', { id: body.eventId as string,
    ids: { tabId: body.tabId as string, playerId: body.playerId as string, petId: body.petId as string },
    ip: c.req.header('cf-connecting-ip') ?? 'unknown' });
  return c.body(null, 204);
});
