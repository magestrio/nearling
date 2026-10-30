// The minute cron (`triggers.crons`): the sessions to debit, the diary of the first half hour of a
// UTC day, the pause of the services and the cleaning of old rows. Each part fails alone: a part
// that throws logs its code and the others still run.
import { accountBalance, ChainUnreachable } from './chain';
import { closeAndDebit } from './debit';
import { utcDay } from './http';
import { keyIsValid } from './nearai';
import { desk, enqueueJob, STALE_RUNNING_MS } from './pet/desk';
import { clearPause, gasReserve, lastProbe, noteProbe, pauseReason, setPause } from './servicePause';

/** The diary is put to the pets that do not sleep in the first 30 minutes of the UTC day. */
const DIARY_WINDOW_MS = 30 * 60_000;
/** At most this many calls to NEAR AI at once for the diary (the provider allows ~64 per model, volatile). */
const DIARY_AT_ONCE = 8;
/** A paused key is tried again at this interval. */
const PROBE_EVERY_MS = 5 * 60_000;

export async function tick(env: Env, nowMs: number = Date.now()): Promise<void> {
  const parts: [string, () => Promise<void>][] = [
    ['debit', () => closeAndDebit(env, nowMs)],
    ['diary', () => diary(env, nowMs)],
    ['pause', () => pause(env, nowMs)],
    ['clean', () => clean(env, nowMs)],
  ];
  for (const [name, part] of parts) {
    try {
      await part();
    } catch (e) {
      console.log(e instanceof ChainUnreachable ? `tick_chain:${name}` : `tick_failed:${name}`);
    }
  }
}

/** The diary of yesterday for every awake pet, in the first half hour of the day, a few at a time,
 * and again each minute for the ones that failed (Return after absence flow › «дневник без игрока»). */
export async function diary(env: Env, nowMs: number): Promise<void> {
  const today = utcDay(nowMs);
  if (nowMs - today * 86_400_000 >= DIARY_WINDOW_MS) return;
  // A desk that died holds a slot until something runs it again: its sweep ends the stale row.
  const stale = await env.DB.prepare("SELECT DISTINCT token_id FROM jobs WHERE kind = 'diary' AND status IN ('queued', 'running') AND created_at < ?")
    .bind(nowMs - STALE_RUNNING_MS)
    .all<{ token_id: string }>();
  await Promise.allSettled(stale.results.map(({ token_id }) => desk(env, token_id).process(token_id)));
  const running = await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind = 'diary' AND status IN ('queued', 'running')").first<{ n: number }>();
  const room = DIARY_AT_ONCE - (running?.n ?? 0);
  if (room <= 0) return;
  const pets = await env.DB.prepare(
    "SELECT token_id FROM pets WHERE slept_at IS NULL AND (diary_day IS NULL OR diary_day < ?) AND token_id NOT IN (SELECT token_id FROM jobs WHERE kind = 'diary' AND status IN ('queued', 'running')) ORDER BY token_id LIMIT ?",
  )
    .bind(today, room)
    .all<{ token_id: string }>();
  const ids: string[] = [];
  for (const { token_id } of pets.results) {
    await enqueueJob(env.DB, token_id, { kind: 'diary', day: today });
    ids.push(token_id);
  }
  await Promise.allSettled(ids.flatMap((id) => [desk(env, id).arm(id), desk(env, id).process(id)]));
}

/** Starts and ends the pause of the services (Service pause data). */
export async function pause(env: Env, nowMs: number): Promise<void> {
  const reason = await pauseReason(env.DB);
  const balance = BigInt(await accountBalance(env, env.SERVER_ACCOUNT_ID));
  const reserve = await gasReserve(env);
  if (reason === null) {
    if (balance <= reserve) {
      await setPause(env.DB, 'gas', nowMs);
      console.log('pause_gas');
    }
    return;
  }
  if (reason === 'gas') {
    if (balance > reserve) {
      await clearPause(env.DB);
      console.log('pause_lifted');
    }
    return;
  }
  // The key of NEAR AI was refused (402): ask it, now and then, with a call that spends no tokens.
  const last = await lastProbe(env.DB);
  if (last !== null && nowMs - last < PROBE_EVERY_MS) return;
  await noteProbe(env.DB, nowMs);
  if (await keyIsValid(env)) {
    await clearPause(env.DB);
    console.log('pause_lifted');
  }
}

async function clean(env: Env, nowMs: number): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM jobs WHERE created_at < ? AND status IN ('done', 'failed')").bind(nowMs - 86_400_000),
    env.DB.prepare('DELETE FROM empty_answers WHERE day < ?').bind(utcDay(nowMs) - 1),
  ]);
}
