// The daily slot is claimed before search, and a blocked day is recorded as skipped. No
// outbound call occurs from this module; the claimed job runs on the pet's desk.
import { petView, type PetRecord } from '../chain';
import { utcDay } from '../http';
import { energyLeft, readLife, spendEnergy } from '../pet/life';
import { foodState, isTired } from '../pet/view';
import { fullness } from '../pricing';
import { gasIsLow, isPaused } from '../servicePause';
import { upToFor } from '../errands/price';
import { syncedWatch, type WatchRow } from './target';
import { track } from '../track';

export type WatchPause = 'sleeping' | 'energy' | 'food' | 'cap' | 'services';
export type Claim = { kind: 'started'; row: WatchRow; pet: PetRecord } | { kind: 'skipped'; reason: WatchPause } | { kind: 'not_due' };

export async function claimWatch(env: Env, id: string, nowMs: number): Promise<Claim> {
  const pet = await petView(env, id);
  if (pet === null) return { kind: 'not_due' };
  const row = await syncedWatch(env.DB, id, pet);
  const day = utcDay(nowMs);
  if (row === null || row.paused || row.saved_hour_utc > new Date(nowMs).getUTCHours() || row.last_started_day === day) return { kind: 'not_due' };
  if (await env.DB.prepare('SELECT 1 FROM watch_checks WHERE token_id = ? AND day = ?').bind(id, day).first()) return { kind: 'not_due' };

  const food = await foodState(env.DB, id, pet, nowMs);
  const needed = upToFor(env, 1).yocto;
  let reason: WatchPause | null = null;
  if ((await isPaused(env.DB, 'thought')) || (await gasIsLow(env, nowMs))) reason = 'services';
  else if (fullness(food.eff).state === 'asleep') reason = 'sleeping';
  else if (food.room < needed) reason = 'food';
  else if (energyLeft(await readLife(env.DB, id), day) === 0) reason = 'energy';
  else if ((await isTired(env, id, food, nowMs)) || food.capLeft < needed) reason = 'cap';

  if (reason !== null) {
    const written = await env.DB.prepare("INSERT OR IGNORE INTO watch_checks (token_id, day, revision, status, started_at, skip_reason) VALUES (?, ?, ?, 'skipped', ?, ?)")
      .bind(id, day, row.revision, nowMs, reason).run();
    if (written.meta.changes !== 1) return { kind: 'not_due' };
    track('watch_checked', { outcome: 'paused', cost_usd: 0, price_usd: 0 });
    return { kind: 'skipped', reason };
  }
  const written = await env.DB.prepare(`INSERT OR IGNORE INTO watch_checks
    (token_id, day, revision, status, started_at)
    SELECT token_id, ?, revision, 'started', ? FROM watch_targets
    WHERE token_id = ? AND paused = 0 AND owner_generation = ? AND revision = ? AND (last_started_day IS NULL OR last_started_day < ?)`)
    .bind(day, nowMs, id, pet.transfer_generation, row.revision, day).run();
  if (written.meta.changes !== 1) return { kind: 'not_due' };
  const marked = await env.DB.prepare('UPDATE watch_targets SET last_started_day = ? WHERE token_id = ? AND revision = ? AND paused = 0 AND owner_generation = ?')
    .bind(day, id, row.revision, pet.transfer_generation).run();
  if (marked.meta.changes !== 1) return { kind: 'not_due' };
  // A started check owns its day's energy even if the network or debit later fails.
  await spendEnergy(env.DB, id, 'watch', nowMs);
  return { kind: 'started', row, pet };
}

/** A bounded due scan. Its callback receives only a claimed slot, never a skipped day. */
export async function dueWatches(env: Env, nowMs: number, onClaim: (claim: Extract<Claim, { kind: 'started' }>) => Promise<void>): Promise<void> {
  const day = utcDay(nowMs);
  const rows = await env.DB.prepare(`SELECT token_id FROM watch_targets WHERE paused = 0 AND saved_hour_utc <= ?
    AND (last_started_day IS NULL OR last_started_day < ?)
    AND token_id NOT IN (SELECT token_id FROM watch_checks WHERE day = ?)
    ORDER BY saved_hour_utc, token_id LIMIT 10`)
    .bind(new Date(nowMs).getUTCHours(), day, day).all<{ token_id: string }>();
  for (const { token_id } of rows.results) {
    const claim = await claimWatch(env, token_id, nowMs);
    if (claim.kind === 'started') await onClaim(claim);
  }
}

/** Atomic queue guard shared by the normal claim path and the recovery scan. */
export async function queueWatchIfMissing(db: D1Database, id: string, day: number, revision: number, nowMs: number): Promise<boolean> {
  const jobId = crypto.randomUUID().replaceAll('-', '');
  const written = await db.prepare(`INSERT INTO jobs (id, token_id, kind, mode, payload, status, created_at, owner_account)
    SELECT ?, c.token_id, 'watch', NULL, ?, 'queued', ?, NULL FROM watch_checks c
    WHERE c.token_id = ? AND c.day = ? AND c.revision = ? AND c.status = 'started' AND c.receipt_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.token_id = c.token_id AND j.kind = 'watch'
        AND json_extract(j.payload, '$.day') = c.day AND json_extract(j.payload, '$.revision') = c.revision)`)
    .bind(jobId, JSON.stringify({ day, revision }), nowMs, id, day, revision).run();
  return written.meta.changes === 1;
}

/** Reclaims a daily slot whose Worker stopped after D1 claimed it but before a desk job existed. */
export async function recoverUnqueuedWatches(env: Env, nowMs: number): Promise<string[]> {
  const day = utcDay(nowMs);
  const expired = await env.DB.prepare(`SELECT c.token_id, c.day, c.revision FROM watch_checks c
    WHERE c.day < ? AND c.status = 'started' AND c.receipt_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.token_id = c.token_id AND j.kind = 'watch'
        AND json_extract(j.payload, '$.day') = c.day AND json_extract(j.payload, '$.revision') = c.revision)
    ORDER BY c.started_at LIMIT 10`).bind(day).all<{ token_id: string; day: number; revision: number }>();
  for (const row of expired.results) await env.DB.batch([
    env.DB.prepare("UPDATE watch_checks SET status = 'failed' WHERE token_id = ? AND day = ? AND revision = ? AND status = 'started' AND receipt_id IS NULL")
      .bind(row.token_id, row.day, row.revision),
    env.DB.prepare(`UPDATE watch_targets SET latest_result = 'failed' WHERE token_id = ? AND revision = ?
      AND EXISTS (SELECT 1 FROM watch_checks WHERE token_id = ? AND day = ? AND status = 'failed')`)
      .bind(row.token_id, row.revision, row.token_id, row.day),
  ]);
  const rows = await env.DB.prepare(`SELECT c.token_id, c.revision FROM watch_checks c
    JOIN watch_targets t ON t.token_id = c.token_id AND t.revision = c.revision AND t.paused = 0
    WHERE c.day = ? AND c.status = 'started' AND c.receipt_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.token_id = c.token_id AND j.kind = 'watch'
        AND json_extract(j.payload, '$.day') = c.day AND json_extract(j.payload, '$.revision') = c.revision
        AND j.status IN ('running', 'done', 'failed'))
    ORDER BY c.started_at LIMIT 10`).bind(day).all<{ token_id: string; revision: number }>();
  const ready: string[] = [];
  for (const row of rows.results) {
    if (await queueWatchIfMissing(env.DB, row.token_id, day, row.revision, nowMs)) ready.push(row.token_id);
    else if (await env.DB.prepare(`SELECT 1 FROM jobs WHERE token_id = ? AND kind = 'watch' AND status = 'queued'
      AND json_extract(payload, '$.day') = ? AND json_extract(payload, '$.revision') = ?`)
      .bind(row.token_id, day, row.revision).first()) ready.push(row.token_id);
  }
  return ready;
}
