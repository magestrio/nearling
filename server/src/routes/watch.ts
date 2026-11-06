import { Hono } from 'hono';
import { type AppEnv } from '../http';
import { ownedPet } from './thoughts';
import { ownerWatch, syncedWatch, validTarget } from '../watch/target';
import { upToFor, view } from '../errands/price';

export const watchRoutes = new Hono<AppEnv>();

watchRoutes.get('/api/pets/:id/watch', async (c) => {
  const owned = await ownedPet(c);
  if (owned instanceof Response) return owned;
  return c.json({ ...await ownerWatch(c.env.DB, await syncedWatch(c.env.DB, owned.id, owned.pet), Date.now()), upTo: view(upToFor(c.env, 1)) });
});

watchRoutes.put('/api/pets/:id/watch', async (c) => {
  const owned = await ownedPet(c);
  if (owned instanceof Response) return owned;
  const body = await c.req.json<{ target?: unknown }>().catch(() => null);
  const value = validTarget(body?.target);
  if (value === 'blank') return c.json({ code: 'watch_blank' }, 400);
  if (value === 'too_long') return c.json({ code: 'watch_too_long' }, 400);
  const now = Date.now();
  const previous = await syncedWatch(c.env.DB, owned.id, owned.pet);
  if (previous?.target === value.target && previous.kind === value.kind) {
    return c.json({ ...await ownerWatch(c.env.DB, previous, now), upTo: view(upToFor(c.env, 1)) });
  }
  // A replacement drops the baseline but never returns the day's already used slot.
  await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO watch_targets
      (token_id, kind, target, revision, saved_hour_utc, paused, owner_generation, last_started_day, updated_at)
      VALUES (?, ?, ?, 1, ?, 0, ?, ?, ?)
      ON CONFLICT(token_id) DO UPDATE SET kind = excluded.kind, target = excluded.target,
      revision = watch_targets.revision + 1, saved_hour_utc = excluded.saved_hour_utc,
      paused = 0, owner_generation = excluded.owner_generation,
      latest_result = NULL, latest_price_yocto = NULL, latest_receipt_id = NULL,
      updated_at = excluded.updated_at`)
      .bind(owned.id, value.kind, value.target, new Date(now).getUTCHours(), owned.pet.transfer_generation, previous?.last_started_day ?? null, now),
    c.env.DB.prepare('DELETE FROM watch_observations WHERE token_id = ?').bind(owned.id),
    c.env.DB.prepare('UPDATE watch_checks SET pending_content = NULL, pending_sources = NULL, pending_result = NULL WHERE token_id = ? AND status = ?').bind(owned.id, 'started'),
  ]);
  return c.json({ ...await ownerWatch(c.env.DB, await syncedWatch(c.env.DB, owned.id, owned.pet), now), upTo: view(upToFor(c.env, 1)) });
});

watchRoutes.post('/api/pets/:id/watch/resume', async (c) => {
  const owned = await ownedPet(c);
  if (owned instanceof Response) return owned;
  const row = await syncedWatch(c.env.DB, owned.id, owned.pet);
  if (row === null) return c.json({ code: 'watch_missing' }, 404);
  await c.env.DB.prepare('UPDATE watch_targets SET paused = 0, updated_at = ? WHERE token_id = ? AND owner_generation = ?')
    .bind(Date.now(), owned.id, owned.pet.transfer_generation).run();
  return c.json({ ...await ownerWatch(c.env.DB, await syncedWatch(c.env.DB, owned.id, owned.pet), Date.now()), upTo: view(upToFor(c.env, 1)) });
});

watchRoutes.delete('/api/pets/:id/watch', async (c) => {
  const owned = await ownedPet(c);
  if (owned instanceof Response) return owned;
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM watch_targets WHERE token_id = ?').bind(owned.id),
    c.env.DB.prepare('UPDATE watch_checks SET pending_content = NULL, pending_sources = NULL, pending_result = NULL WHERE token_id = ? AND status = ?').bind(owned.id, 'started'),
  ]);
  return c.json({ target: null });
});
