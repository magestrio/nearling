// The minute cron (`triggers.crons`): the sessions to debit, the diary of the first half hour of a
// UTC day, the pause of the services, the riddle of the day, the ritual (the close of the days that
// ended, the open rows of today), the stages to write and the cleaning of old rows. Each part fails alone: a part
// that throws logs its code and the others still run.
import { accountBalance, ChainUnreachable, petView, txStatus } from './chain';
import { closeAndDebit } from './debit';
import { utcDay } from './http';
import { keyIsValid } from './nearai';
import { askNetwork } from './feeding/inflight';
import { desk, enqueueJob, STALE_RUNNING_MS } from './pet/desk';
import { closeDays } from './pet/close';
import { BUY_COLUMNS, buyCode, finishBuy, type BuyRow } from './pet/buy';
import { writeDueGrants } from './pet/grant';
import { CLAIM_STALE_MS, writeDueGrowth } from './pet/growth';
import { newestItemSend, settleItemSends } from './pet/itemTx';
import { idOf } from './pet/outfits';
import { DIARY_WINDOW_MS, markDueDays, settleOpenRows } from './pet/ritual';
import { FEEDINGS_COLUMNS, settleFeeding, type FeedingRow } from './pet/settle';
import { riddleTick } from './riddle/cron';
import { clearPause, gasReserve, lastProbe, noteProbe, pauseReason, setPause } from './servicePause';
import { monthOf } from './signin';

/** At most this many calls to NEAR AI at once for the diary (the provider allows ~64 per model, volatile). */
const DIARY_AT_ONCE = 8;
/** A meal or snack on its way is asked after by the cron from this age. */
const STALE_FEEDING_MS = 60_000;
/** At most this many rows are asked after in a tick (an unknown hash makes the RPC wait). */
const FEEDINGS_PER_TICK = 10;
/** The reference block of a portion is past the chain's validity window by then (86,400 blocks). */
const FEEDING_FAILED_AFTER_MS = 24 * 3_600_000;
const NO_HASH_FAILED_MS = 5 * 60_000;
/** At most this many pets get a stage written in a tick. */
const GROWTH_PER_TICK = 10;
/** At most this many open purchases are looked at in a tick (an unknown hash makes the RPC wait). */
const BUYS_PER_TICK = 10;
/** A purchase nobody has run for this long is run by the cron. */
const QUEUED_STALE_MS = 60_000;
/** A purchase `sending` for this long (counted from `sending_at`, not from `created_at`: a row that waited in
 * the desk's queue is not a dead desk) has lost its desk (a send ends within `SEND_TIMEOUT_MS` of a nonce
 * retry or two). Time spent in the key's queue counts: a send still waiting there when the row is failed
 * broadcasts nothing, because `noteItemSend` fails once the row is no longer `sending`. */
const SENDING_STALE_MS = 5 * 60_000;
/** A paused key is tried again at this interval. */
const PROBE_EVERY_MS = 5 * 60_000;

export async function tick(env: Env, nowMs: number = Date.now()): Promise<void> {
  const parts: [string, () => Promise<void>][] = [
    ['debit', () => closeAndDebit(env, nowMs)],
    ['diary', () => diary(env, nowMs)],
    ['pause', () => pause(env, nowMs)],
    ['riddle', () => riddleTick(env, nowMs)],
    ['outfits', () => outfits(env, nowMs)],
    ['ritual', () => ritual(env, nowMs)],
    ['growth', () => growth(env, nowMs)],
    ['feedings', () => settleStaleFeedings(env, nowMs)],
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
    // A pet born today has no yesterday to write about (`Diary screen` › «empty»).
    "SELECT token_id FROM pets WHERE slept_at IS NULL AND born_at < ?3 AND (diary_day IS NULL OR diary_day < ?1) AND token_id NOT IN (SELECT token_id FROM jobs WHERE kind = 'diary' AND status IN ('queued', 'running')) ORDER BY token_id LIMIT ?2",
  )
    .bind(today, room, today * 86_400_000)
    .all<{ token_id: string }>();
  const ids: string[] = [];
  for (const { token_id } of pets.results) {
    await enqueueJob(env.DB, token_id, { kind: 'diary', day: today });
    ids.push(token_id);
  }
  await Promise.allSettled(ids.flatMap((id) => [desk(env, id).arm(id), desk(env, id).process(id)]));
}

/** The ritual of the days: the days that ended are closed, the open rows of today are looked at, then the
 * days whose mark is due are written (`pet/close.ts`, `pet/ritual.ts`, `pet/mark.ts`). */
export async function ritual(env: Env, nowMs: number): Promise<void> {
  await closeDays(env, nowMs);
  await settleOpenRows(env, nowMs);
  await markDueDays(env, nowMs);
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

/** The transitions not written yet: a retry of a failed or paused write, one that waited for 00:00 UTC,
 * one whose writer died (its claim is stale). A row refused for today stays out until its day
 * (`retry_day`), so it costs no read a minute. */
export async function growth(env: Env, nowMs: number): Promise<void> {
  const due = await env.DB.prepare(
    'SELECT DISTINCT token_id FROM pending_growth WHERE (retry_day IS NULL OR retry_day <= ?1) AND (sending_at IS NULL OR sending_at < ?2) ORDER BY created_at LIMIT ?3',
  )
    .bind(utcDay(nowMs), nowMs - CLAIM_STALE_MS, GROWTH_PER_TICK)
    .all<{ token_id: string }>();
  for (const { token_id } of due.results) await writeDueGrowth(env, token_id);
}

/** A meal or snack on its way whose tab went away: asked after by its hash a minute on, the
 * consequences run once whichever flow gets there first (`settleFeeding`). A row the network has never
 * answered for 24 hours is `failed`: the reference block of a portion is past the chain's validity
 * window, so it can no longer land (design.md › Риски). A snack row that never got its hash (the Worker
 * died between the row and the send) is failed after `NO_HASH_FAILED_MS`: its reservation is freed. */
export async function settleStaleFeedings(env: Env, nowMs: number): Promise<void> {
  const rows = await env.DB.prepare(`SELECT ${FEEDINGS_COLUMNS} FROM feedings WHERE created_at < ? ORDER BY created_at LIMIT ?`)
    .bind(nowMs - STALE_FEEDING_MS, FEEDINGS_PER_TICK)
    .all<FeedingRow>();
  for (const row of rows.results) {
    const answered = await askNetwork(env, row);
    if (answered !== null) continue;
    const age = nowMs - row.created_at;
    if (age >= FEEDING_FAILED_AFTER_MS || (row.tx_hash === null && age >= NO_HASH_FAILED_MS)) {
      await settleFeeding(env, row, { status: 'failed', code: 'expired' });
    } else if (age < 2 * STALE_FEEDING_MS) {
      console.log('feed_unknown');
    }
  }
}

/** The purchases and the grants of the wardrobe (`add-wardrobe`): the open rows of `outfit_buys`, then the
 * riddle's items waiting to be written, then the hashes of item transactions nobody settled. A half that
 * throws does not stop the others; the first error goes on to `tick`, which logs it. */
export async function outfits(env: Env, nowMs: number): Promise<void> {
  let failure: unknown = null;
  for (const half of [() => settleBuys(env, nowMs), () => writeDueGrants(env), () => settleItemSends(env, nowMs)]) {
    try {
      await half();
    } catch (e) {
      failure ??= e;
    }
  }
  if (failure !== null) throw failure;
}

/** The open purchases, oldest first: a row nobody ran (its desk died, or never got the call) is run; an
 * `unknown` one is looked for on the chain and by its hash; a `sending` one older than 5 minutes (the desk
 * died with the send) is turned into `unknown` by the newest hash noted for it, or failed when none was
 * (design.md › The purchase). A row the network has not answered for 24 hours is `failed`: the reference
 * block is past the chain's window by then, so it can no longer land (`FEEDING_FAILED_AFTER_MS`'s reason). */
export async function settleBuys(env: Env, nowMs: number): Promise<void> {
  const rows = await env.DB.prepare(
    `SELECT ${BUY_COLUMNS} FROM outfit_buys WHERE status IN ('queued', 'unknown') OR (status = 'sending' AND sending_at < ?) ORDER BY created_at LIMIT ?`,
  )
    .bind(nowMs - SENDING_STALE_MS, BUYS_PER_TICK)
    .all<BuyRow>();
  for (let row of rows.results) {
    if (row.status === 'queued') {
      if (nowMs - row.created_at >= QUEUED_STALE_MS) await desk(env, row.token_id).process(row.token_id);
      continue;
    }
    try {
      const pet = await petView(env, row.token_id);
      if (row.status === 'sending') {
        // The item is there: the send landed, its hash is in `item_sends` for `settleItemSends`.
        const noted = await newestItemSend(env.DB, row.token_id, row.item);
        if (pet?.outfits.includes(idOf(row.item))) {
          await finishBuy(env, row, { status: 'bought', txHash: noted });
          continue;
        }
        // Nothing was signed, or the network refused it: nothing was spent. A hash noted is a send that may
        // still land, so the row waits as `unknown` for the network's word. A send still waiting in the key's
        // queue has noted nothing yet: the flip below fails the row, and that send's own last check
        // (`noteItemSend`) finds it no longer `sending` and broadcasts nothing. If the send noted its hash
        // after the read above, the flip changes nothing and the row is taken as `unknown` a minute on.
        if (noted === null) {
          await finishBuy(env, row, { status: 'failed', code: 'error', unlessSent: true });
          continue;
        }
        await env.DB.prepare("UPDATE outfit_buys SET status = 'unknown', tx_hash = ?2 WHERE id = ?1 AND status = 'sending'").bind(row.id, noted).run();
        row = { ...row, status: 'unknown', tx_hash: noted };
      } else if (pet?.outfits.includes(idOf(row.item))) {
        await finishBuy(env, row, { status: 'bought', txHash: row.tx_hash });
        continue;
      }
      const seen = row.tx_hash === null ? null : await txStatus(env, row.tx_hash, env.SERVER_ACCOUNT_ID);
      if (seen?.status === 'ok') await finishBuy(env, row, { status: 'bought', burnt: seen.burnt ?? null, txHash: row.tx_hash, wrote: true });
      else if (seen?.status === 'failed') await finishBuy(env, row, { status: 'failed', code: buyCode(seen.code), txHash: row.tx_hash });
      else if (nowMs - row.created_at >= FEEDING_FAILED_AFTER_MS) await finishBuy(env, row, { status: 'failed', code: 'expired' });
      else console.log('outfit_buy_unknown');
    } catch (e) {
      // The network is not readable now: this row is looked at again a minute on.
      if (!(e instanceof ChainUnreachable)) throw e;
      console.log('outfit_buy_unreadable');
    }
  }
}

export async function clean(env: Env, nowMs: number): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM jobs WHERE created_at < ? AND status IN ('done', 'failed')").bind(nowMs - 86_400_000),
    env.DB.prepare('DELETE FROM empty_answers WHERE day < ?').bind(utcDay(nowMs) - 1),
    // Refusals of past months (Sign-in data › «новый месяц»); the ended sessions after 24 hours (ADR-022).
    env.DB.prepare('DELETE FROM sign_in_refusals WHERE month <> ?').bind(monthOf(nowMs)),
    env.DB.prepare('DELETE FROM ended_sessions WHERE ended_at < ?').bind(nowMs - 86_400_000),
    // The friends' snacks of earlier UTC days (§8 › Перекусы друзей: «до конца суток UTC»).
    env.DB.prepare('DELETE FROM friend_snacks WHERE day < ?').bind(utcDay(nowMs)),
    // The answers to the riddle live to the end of the next day (`Ritual data`), and a revealed riddle's
    // row as long: an unrevealed one stays until it is revealed, however late (ADR-009).
    // From the end of the next day an answer of a riddle not yet revealed keeps only «right or not»: its text
    // goes, its verdict stays for the reveal, however late (`Wardrobe data`, ADR-009). The order matters: the
    // delete keeps the unrevealed days, the update then empties what is left of them.
    env.DB.prepare('DELETE FROM riddle_answers WHERE day < ?1 AND day NOT IN (SELECT day FROM riddles WHERE revealed_at IS NULL)').bind(utcDay(nowMs) - 1),
    env.DB.prepare("UPDATE riddle_answers SET text = '' WHERE day < ?1 AND text <> ''").bind(utcDay(nowMs) - 1),
    env.DB.prepare('DELETE FROM riddles WHERE revealed_at IS NOT NULL AND day < ?').bind(utcDay(nowMs) - 1),
    // The purchases that are over, a day on (their outcome is shown for minutes).
    env.DB.prepare("DELETE FROM outfit_buys WHERE status IN ('bought', 'failed') AND settled_at < ?").bind(nowMs - 86_400_000),
  ]);
}
