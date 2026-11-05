// Owner-only card facts. Every request checks the current chain owner before reading D1 words.
import { Hono } from 'hono';
import { stageOf } from '../chain';
import type { AppEnv } from '../http';
import { wornOf } from '../pet/outfits';
import { ownedPet } from './thoughts';

export const showcaseCardRoutes = new Hono<AppEnv>();

const PET_AUTHORED = "kind IN ('reply', 'deep', 'greeting', 'wake', 'diary', 'question')";
const THOUGHT_ID = /^[0-9a-f]{24,36}$/;

showcaseCardRoutes.get('/api/pets/:id/card-lines', async (c) => {
  const owned = await ownedPet(c);
  if (owned instanceof Response) return owned;
  const rows = await c.env.DB.prepare(
    `SELECT id, reply_text AS text FROM thoughts WHERE token_id = ? AND ${PET_AUTHORED} AND reply_text IS NOT NULL AND erased_at IS NULL ORDER BY created_at DESC, rowid DESC`,
  ).bind(owned.id).all<{ id: string; text: string }>();
  return c.json({ lines: rows.results });
});

showcaseCardRoutes.post('/api/pets/:id/card-source', async (c) => {
  const owned = await ownedPet(c);
  if (owned instanceof Response) return owned;
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (body === null || !['thought', 'growth', 'outfit'].includes(String(body.kind))
    || Object.keys(body).some((key) => key !== 'kind' && key !== 'thoughtId')
    || (body.kind === 'thought' ? !THOUGHT_ID.test(String(body.thoughtId)) : body.thoughtId !== undefined)) {
    return c.json({ code: 'bad_request' }, 400);
  }
  const base = { tokenId: owned.id, name: owned.pet.name };
  if (body.kind === 'growth') {
    const stage = stageOf(owned.pet);
    return stage === 'baby' ? c.json({ code: 'growth_not_reached' }, 409) : c.json({ ...base, kind: 'growth', stage });
  }
  if (body.kind === 'outfit') {
    const worn = await wornOf(c.env.DB, owned.id);
    return worn === null ? c.json({ code: 'no_outfit' }, 409) : c.json({ ...base, kind: 'outfit', worn });
  }
  const row = await c.env.DB.prepare(
    `SELECT reply_text FROM thoughts WHERE id = ? AND token_id = ? AND ${PET_AUTHORED} AND reply_text IS NOT NULL AND erased_at IS NULL`,
  ).bind(body.thoughtId, owned.id).first<{ reply_text: string }>();
  return row === null ? c.json({ code: 'thought_erased' }, 409)
    : c.json({ ...base, kind: 'thought', thoughtId: body.thoughtId, line: row.reply_text });
});
