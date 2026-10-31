// Writing the day of a finished ritual to the contract (`Streak rule` › «серия записана позже», ADR-010).
// A row of `ritual_days` with `completed_at` and no `marked_at` is a day to write; this writer sends
// `streak_mark` for the oldest one, finds out from the chain whether it landed, and finishes once: the
// row's end, the events and the project's gas. Same shape as `pet/growth.ts`.
//
// Called by `settleRitual` (so by the read mark, an accepted riddle answer, every job of the desk and a
// clear of the memory) and by the cron for the rows nobody called for. ADR-008: a mark the chain already
// holds is never sent again.
import { chainDay, ChainUnreachable, petView, STREAK_MARK_TGAS } from '../chain';
import { nearUsdRate, yoctoToUsdMicros } from '../pricing';
import { isPaused } from '../servicePause';
import { track } from '../track';
import { CLAIM_STALE_MS } from './growth';
import { applyMark, type StreakBefore } from './streak';

/** What the writer knew when it sent: the streak, the freezes, the last marked day and `skipped`. It is
 * stored before the send, so a send whose outcome was lost and is found later still fires its events. */
interface Before extends StreakBefore {
  skipped: number;
}

export type MarkResult = 'idle' | 'paused' | 'busy' | 'unreadable' | 'waiting' | 'written' | 'found' | 'failed' | 'excused';

/** At most this many days of one pet are written in a call: a late row is excused, a landed one finished. */
const DAYS_PER_CALL = 3;

/** Tries the oldest unwritten day of the pet, then the next, in the order of design.md › Решения: the gas
 * pause, the claim, the chain's pet and day, then the send. Never throws for the network: a day that is
 * not written now is tried again by the cron a minute on. */
export async function writeDueMark(env: Env, tokenId: string): Promise<MarkResult> {
  let first: MarkResult = 'idle';
  for (let n = 0; n < DAYS_PER_CALL; n += 1) {
    const result = await markOldest(env, tokenId);
    if (first === 'idle') first = result;
    if (result !== 'written' && result !== 'found' && result !== 'excused') break;
  }
  return first;
}

async function markOldest(env: Env, tokenId: string): Promise<MarkResult> {
  const now = Date.now();
  const row = await env.DB.prepare(
    'SELECT day, mark_before FROM ritual_days WHERE token_id = ? AND completed_at IS NOT NULL AND marked_at IS NULL AND excused = 0 ORDER BY day LIMIT 1',
  )
    .bind(tokenId)
    .first<{ day: number; mark_before: string | null }>();
  if (row === null) return 'idle';
  // Gas only: the AI pause does not stop a write (`Streak rule`, ADR-010).
  if (await isPaused(env.DB, 'streak')) return 'paused';
  // Yesterday is not closed yet: the days it would excuse are not in `ritual_days`, so `skipped` would
  // read short and the contract would count a night with nothing available as missed, for good. The
  // cron closes it first in its tick; the next minute finds it closed (`Ritual day rule`, `forecastOf`).
  const clock = await env.DB.prepare('SELECT closed_day FROM ritual_clock WHERE id = 1').first<{ closed_day: number }>();
  if ((clock?.closed_day ?? 0) < row.day - 1) return 'waiting';

  const claim = await env.DB.prepare('UPDATE ritual_days SET sending_at = ?3 WHERE token_id = ?1 AND day = ?2 AND marked_at IS NULL AND excused = 0 AND (sending_at IS NULL OR sending_at < ?4) RETURNING day')
    .bind(tokenId, row.day, now, now - CLAIM_STALE_MS)
    .first();
  if (claim === null) return 'busy';

  let last: number;
  let streak: number;
  let freezes: number;
  let today: number;
  try {
    const pet = await petView(env, tokenId);
    if (pet === null) {
      await release(env.DB, tokenId, row.day);
      return 'unreadable';
    }
    today = await chainDay(env);
    last = pet.last_streak_day ?? 0;
    streak = pet.streak;
    freezes = pet.freezes;
  } catch (e) {
    if (!(e instanceof ChainUnreachable)) throw e;
    await release(env.DB, tokenId, row.day);
    console.log('streak_unreadable');
    return 'unreadable';
  }

  // The chain is already there (an outcome that was unknown has landed): finish, send nothing.
  if (last >= row.day) return finish(env, tokenId, row.day, null);
  // The mark could not land any more: the contract takes yesterday and today only (ADR-010 › Which day).
  if (row.day < today - 1) {
    await env.DB.prepare('UPDATE ritual_days SET excused = 1, sending_at = NULL WHERE token_id = ? AND day = ? AND marked_at IS NULL').bind(tokenId, row.day).run();
    console.log('streak_lost');
    return 'excused';
  }
  // The Worker's clock is ahead of the chain's: the contract would refuse the day. A minute on.
  if (row.day > today) {
    await release(env.DB, tokenId, row.day);
    return 'waiting';
  }

  // The days between the last mark and this one that the pet slept through or had nothing available
  // go into `skipped`; the first mark reads none.
  const skipped =
    last === 0
      ? 0
      : ((await env.DB.prepare('SELECT COUNT(*) AS n FROM ritual_days WHERE token_id = ? AND excused = 1 AND day > ? AND day < ?').bind(tokenId, last, row.day).first<{ n: number }>())?.n ?? 0);
  const before: Before = { streak, freezes, last, skipped };
  await env.DB.prepare('UPDATE ritual_days SET mark_before = ? WHERE token_id = ? AND day = ?').bind(JSON.stringify(before), tokenId, row.day).run();

  const answer = await env.SERVER_KEY.get(env.SERVER_KEY.idFromName('server')).send({
    methodName: 'streak_mark',
    args: { token_id: tokenId, day: row.day, skipped },
    gas: (STREAK_MARK_TGAS * 1_000_000_000_000n).toString(),
  });
  if (answer.status === 'ok') {
    console.log('streak_sent');
    return finish(env, tokenId, row.day, { burnt: answer.burnt ?? null });
  }
  // A refusal, an unreachable network or an outcome nobody heard: the next attempt reads the chain
  // first, so a send that did land is found there and never sent again.
  await release(env.DB, tokenId, row.day);
  console.log(answer.status === 'unknown' ? 'streak_unknown' : `streak_failed:${answer.status === 'failed' ? answer.code : 'unreachable'}`);
  return 'failed';
}

const release = (db: D1Database, tokenId: string, day: number) =>
  db.prepare('UPDATE ritual_days SET sending_at = NULL WHERE token_id = ? AND day = ? AND marked_at IS NULL').bind(tokenId, day).run();

/** Finishes a day once: the row's end, the quiet of a gifted pet over, the rows of earlier days gone, in
 * one batch; the events and the project's gas follow only for the writer that flipped `marked_at`.
 * `sent` is null when this writer sent nothing (the chain already had the day), else the gas its own send
 * burned (null when the answer did not say). */
async function finish(env: Env, tokenId: string, day: number, sent: { burnt: string | null } | null): Promise<MarkResult> {
  const now = Date.now();
  const written = await env.DB.batch([
    env.DB.prepare('UPDATE ritual_days SET marked_at = ?3, sending_at = NULL WHERE token_id = ?1 AND day = ?2 AND marked_at IS NULL RETURNING mark_before').bind(tokenId, day, now),
    // After the first mark that follows a gift the lines about a miss are back (`Streak rule`).
    env.DB.prepare('UPDATE pets SET gifted_unmarked = 0 WHERE token_id = ?').bind(tokenId),
    // The marks, the parts and the days without a ritual of earlier days have done their work.
    env.DB.prepare('DELETE FROM ritual_days WHERE token_id = ? AND day < ?').bind(tokenId, day),
  ]);
  const flipped = written[0]!.results as { mark_before: string | null }[];
  if (flipped.length === 0) return 'busy';
  eventsOf(flipped[0]!.mark_before, day);
  if (sent?.burnt != null) {
    const rate = nearUsdRate(env.NEAR_USD_RATE);
    if (rate === null) console.log('rate_missing');
    else await env.DB.prepare('INSERT INTO project_spend (at, kind, usd_micros) VALUES (?, ?, ?)').bind(now, 'gas', yoctoToUsdMicros(BigInt(sent.burnt), rate)).run();
  }
  return sent === null ? 'found' : 'written';
}

/** `streak_frozen` per covered day and `streak_reset {last_days}` when the streak started over, from what
 * the writer knew at the send (`applyMark` is the contract's arithmetic). No record of it: no event. */
function eventsOf(stored: string | null, day: number): void {
  if (stored === null) return;
  const before = JSON.parse(stored) as Before;
  if (before.last === 0) return;
  const missed = Math.max(0, day - before.last - 1 - before.skipped);
  if (missed === 0) return;
  if (missed > before.freezes) {
    track('streak_reset', { last_days: before.streak });
    return;
  }
  const { spent } = applyMark(before, day, before.skipped);
  for (let n = 0; n < spent; n += 1) track('streak_frozen');
}
