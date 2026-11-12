// Who wakes a pet: `wakeIfFed` is called by the state poll (the food in the network grew) and, in
// later changes, by feeding and by the worker's earnings (design.md › «Кто будит»). `slept_at` is the
// server's own note that the pet fell asleep; the network is the truth for the food.
import { ChainUnreachable, petView } from '../chain';
import { fullness, STARTER_FOOD_YOCTO } from '../pricing';
import { track } from '../track';
import { desk, enqueueJob } from './desk';
import { DIARY_WINDOW_MS } from './ritual';
import { foodState } from './view';

export type WakeCause = 'owner' | 'link' | 'work' | 'cross_chain' | 'unattributed';
type PendingFriend = { feedId: string; memoryEpoch: number };

/** A sleeping pet whose food is back to one scale thought, whoever brought it: states in NEAR do not
 * move with the rate (`Pet food data` › «курс сменился»). `ChainUnreachable` when the pet cannot be read. */
export async function wakeDue(env: Env, tokenId: string): Promise<boolean> {
  const row = await env.DB.prepare('SELECT slept_at FROM pets WHERE token_id = ?').bind(tokenId).first<{ slept_at: number | null }>();
  if (row === null || row.slept_at === null) return false;
  const pet = await petView(env, tokenId);
  if (pet === null) return false;
  const fs = await foodState(env.DB, tokenId, pet, Date.now());
  return fullness(fs.eff, STARTER_FOOD_YOCTO).state !== 'asleep';
}

/** What follows the write that woke the pet. */
export async function afterWake(env: Env, tokenId: string, cause: WakeCause, friend?: string, rememberFriend = true): Promise<void> {
  if (cause === 'link' && rememberFriend) {
    await env.DB.prepare("INSERT INTO memory_notes (token_id, kind, name, at) VALUES (?, 'fed_by', ?, ?)").bind(tokenId, friend ?? '', Date.now()).run();
  }
  // Anonymous food has its exact line on the page. No named feeder or AI wake thought is made.
  if (cause !== 'cross_chain' && cause !== 'unattributed') {
    await enqueueJob(env.DB, tokenId, { kind: 'wake', cause, friend });
    await desk(env, tokenId).arm(tokenId);
  }
  if (cause !== 'unattributed') track('pet_woke', { via: cause });
}

/** Wakes the pet when `wakeDue` says so. Returns whether it woke. */
export async function wakeIfFed(env: Env, tokenId: string, cause: WakeCause, friend?: string, rememberFriend = true, pending?: PendingFriend): Promise<boolean> {
  if (!(await wakeDue(env, tokenId))) return false;
  // Atomic: of two polls that see the food, one wakes the pet. `wake_seq` counts the wake for the
  // owner's page (`/state?wakes=`), `wake_by` is the friend's name ('' for a nameless one; NULL for
  // the owner's own meal and for work) and is memory: Clear memory erases it.
  // The same statement notes a wake after the diary window of a pet that slept into it, so «a day with no
  // diary» is told from «a diary that was not written» (`Daily ritual flow` › «день без дневника»). In
  // SQL the right-hand sides read the row as it was: `slept_at` is the sleep that ends here.
  const now = Date.now();
  const windowEnd = Math.floor(now / 86_400_000) * 86_400_000 + DIARY_WINDOW_MS;
  const update = `UPDATE pets SET slept_at = NULL, wake_seq = wake_seq + 1, wake_by = ?2, wake_source = ?6,
      asleep_diary_day = CASE WHEN ?3 >= ?4 AND slept_at < ?4 THEN ?5 ELSE asleep_diary_day END
      WHERE token_id = ?1 AND slept_at IS NOT NULL`;
  const updateArgs = [tokenId, cause === 'link' ? (friend ?? '') : null, now, windowEnd,
    Math.floor(now / 86_400_000), cause === 'unattributed' ? null : cause] as const;
  if (pending !== undefined) {
    // D1 batches commit together. The job claims the still-sleeping pet and exact pending feed;
    // only that claim can wake it and remove the row. A second poll or Clear memory can run
    // before or after the batch, never between these three writes.
    const jobId = crypto.randomUUID().replaceAll('-', '');
    const [queued] = await env.DB.batch([
      env.DB.prepare(`INSERT INTO jobs (id, token_id, kind, mode, payload, status, created_at, owner_account)
        SELECT ?1, ?2, 'wake', NULL, ?3, 'queued', ?4, NULL
        WHERE EXISTS (SELECT 1 FROM pets p JOIN pending_feed_wakes w ON w.token_id = p.token_id
          WHERE p.token_id = ?2 AND p.slept_at IS NOT NULL AND p.memory_epoch = ?5
            AND w.feed_id = ?6 AND w.name = ?7)`)
        .bind(jobId, tokenId, JSON.stringify({ cause, friend: friend ?? null }), now,
          pending.memoryEpoch, pending.feedId, friend ?? ''),
      env.DB.prepare(`${update} AND EXISTS (SELECT 1 FROM jobs WHERE id = ?7 AND token_id = ?1)`)
        .bind(...updateArgs, jobId),
      env.DB.prepare(`DELETE FROM pending_feed_wakes WHERE token_id = ?1 AND feed_id = ?2
        AND EXISTS (SELECT 1 FROM jobs WHERE id = ?3 AND token_id = ?1)`)
        .bind(tokenId, pending.feedId, jobId),
    ]);
    if (queued.meta.changes === 0) return false;
    await desk(env, tokenId).arm(tokenId);
    track('pet_woke', { via: cause });
    return true;
  }
  const woke = await env.DB.prepare(update).bind(...updateArgs).run();
  if (woke.meta.changes === 0) return false;
  await afterWake(env, tokenId, cause, friend, rememberFriend);
  return true;
}

/** A confirmed friend's attribution stays here until a fresh chain view can make its wake. */
export async function pendingFriendWake(env: Env, tokenId: string): Promise<{ pending: boolean; woke: boolean }> {
  const row = await env.DB.prepare(`SELECT w.feed_id, w.name, p.memory_epoch FROM pending_feed_wakes w
    JOIN pets p ON p.token_id = w.token_id WHERE w.token_id = ?`)
    .bind(tokenId).first<{ feed_id: string; name: string; memory_epoch: number }>();
  if (row === null) return { pending: false, woke: false };
  const slept = await env.DB.prepare('SELECT slept_at FROM pets WHERE token_id = ?')
    .bind(tokenId).first<{ slept_at: number | null }>();
  if (slept?.slept_at === null || slept === null) {
    await env.DB.prepare('DELETE FROM pending_feed_wakes WHERE token_id = ? AND feed_id = ?').bind(tokenId, row.feed_id).run();
    return { pending: false, woke: false };
  }
  let woke: boolean;
  try {
    woke = await wakeIfFed(env, tokenId, 'link', row.name, false, { feedId: row.feed_id, memoryEpoch: row.memory_epoch });
  } catch (error) {
    if (error instanceof ChainUnreachable) return { pending: true, woke: false };
    throw error;
  }
  if (woke) {
    return { pending: false, woke: true };
  }
  return { pending: true, woke: false };
}
