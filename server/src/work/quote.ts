// A worker's price and its places for a UTC day (`add-pet-work` › `Hire quote data`, `Hire price rule`).
// The count is `worker_answers.n` (the answers that reached the asker) plus `held` (the calls on their
// way), by the server's own UTC day. The price is the server's, never the browser's: what the browser
// sends, or a Manual offer names, is only a ceiling a hold is made under.
import { hireCents, MAX_JOBS_PER_DAY, nearUsdRate, workerPrice } from '../pricing';
import { relation } from '../society/relations';

type Db = Pick<Env, 'DB'>;

/** A worker's price as the pages carry it: the yocto the server holds it at and the cents shown (`{price}`), at the
 * rate of NEAR now. An empty rate is a config error, as it is for `deepPrice`. */
export function priceView(env: Pick<Env, 'NEAR_USD_RATE'>, yocto: bigint): { yocto: string; cents: number } {
  const rate = nearUsdRate(env.NEAR_USD_RATE);
  if (rate === null) throw new Error('rate_missing');
  return { yocto: yocto.toString(), cents: hireCents(yocto, rate) };
}

export interface Quote {
  /** what the next asker pays, in yocto */
  yocto: bigint;
  /** the answers of the day with the places held: the price's step and the day's limit are counted from it */
  count: number;
  /** a worker with a skill or without one is a worker only below `MAX_JOBS_PER_DAY` (`Hire eligibility rule`) */
  open: boolean;
  discounted?: boolean;
  refusalUntil?: number | null;
}

export type Hold = { ok: true; fee: bigint; discounted?: boolean } | { ok: false; price: bigint; open: boolean };

/** A place left `held` for this long by a desk that died is cleared by the cron, as the stale jobs are
 * (`STALE_RUNNING_MS` of `pet/desk.ts`). */
export const STALE_HELD_MS = 5 * 60_000;

async function skilled(db: Db, workerId: string): Promise<boolean> {
  return (await db.DB.prepare('SELECT 1 AS found FROM skills WHERE token_id = ?').bind(workerId).first()) !== null;
}

/** What the next asker pays this worker today, and whether it is still one. */
export async function priceOf(env: Db, workerId: string, day: number): Promise<Quote> {
  const row = await env.DB.prepare('SELECT n, held FROM worker_answers WHERE token_id = ? AND day = ?').bind(workerId, day).first<{ n: number; held: number }>();
  const count = (row?.n ?? 0) + (row?.held ?? 0);
  return { yocto: workerPrice(await skilled(env, workerId), count), count, open: count < MAX_JOBS_PER_DAY };
}

export const discountedFee = (base: bigint): bigint => base * 9n / 10n;

/** The payer's directed stance prices the pair; the worker's directed break controls access. */
export async function pairPrice(env: Db, payerId: string, workerId: string, day: number, nowMs: number): Promise<Quote> {
  const [base, payer, worker] = await Promise.all([
    priceOf(env, workerId, day), relation(env.DB, payerId, workerId), relation(env.DB, workerId, payerId),
  ]);
  const discounted = payer?.stance === 'liked';
  return { ...base, yocto: discounted ? discountedFee(base.yocto) : base.yocto,
    discounted, refusalUntil: worker?.break_until != null && worker.break_until > nowMs ? worker.break_until : null };
}

/** The highest count, 0…`MAX_JOBS_PER_DAY` − 1, at which the price of a worker is still within `ceiling`; -1 when
 * not even the first answer is. SQLite cannot compare yocto (past 2^63), so the price is turned into a count here. */
function reach(isSkilled: boolean, ceiling: bigint, discounted = false): number {
  let top = -1;
  for (let count = 0; count < MAX_JOBS_PER_DAY; count += 1) {
    const base = workerPrice(isSkilled, count);
    if ((discounted ? discountedFee(base) : base) <= ceiling) top = count;
  }
  return top;
}

/** Holds a place of the worker's day under `ceiling`: one statement, so that two askers at once see each other's
 * place — the second meets the price the first one raised. The fee is the price at the moment the place is held.
 * No place: the price it is now, and whether the worker still is one. */
export async function hold(env: Db, workerId: string, day: number, ceiling: bigint, nowMs: number, payerId?: string): Promise<Hold> {
  const liked = payerId === undefined ? '0' : "EXISTS (SELECT 1 FROM society_relations WHERE token_id = ?7 AND other_id = ?1 AND stance = 'liked')";
  const [, held] = await env.DB.batch<{ n: number; held: number; skilled: number; discounted: number }>([
    env.DB.prepare('INSERT OR IGNORE INTO worker_answers (token_id, day) VALUES (?1, ?2)').bind(workerId, day),
    env.DB.prepare(
      `UPDATE worker_answers SET held = held + 1, held_at = ?3
       WHERE token_id = ?1 AND day = ?2 AND n + held < ?4
         AND n + held <= (CASE WHEN ${liked} THEN
           CASE WHEN EXISTS (SELECT 1 FROM skills WHERE token_id = ?1) THEN ?8 ELSE ?9 END
           ELSE CASE WHEN EXISTS (SELECT 1 FROM skills WHERE token_id = ?1) THEN ?5 ELSE ?6 END END)
       RETURNING n, held, EXISTS (SELECT 1 FROM skills WHERE token_id = ?1) AS skilled,
         ${liked} AS discounted`,
    ).bind(workerId, day, nowMs, MAX_JOBS_PER_DAY, reach(true, ceiling), reach(false, ceiling), payerId ?? null,
      reach(true, ceiling, true), reach(false, ceiling, true)),
  ]);
  const row = held?.results[0];
  if (row === undefined) {
    const quote = payerId === undefined ? await priceOf(env, workerId, day) : await pairPrice(env, payerId, workerId, day, nowMs);
    return { ok: false, price: quote.yocto, open: quote.open };
  }
  const base = workerPrice(row.skilled === 1, row.n + row.held - 1);
  return { ok: true, fee: row.discounted === 1 ? discountedFee(base) : base,
    ...(payerId === undefined ? {} : { discounted: row.discounted === 1 }) };
}

/** The answer reached the asker, shown or an empty one the payer pays: the place becomes an answer. */
export async function answered(env: Db, workerId: string, day: number): Promise<void> {
  await env.DB.prepare('UPDATE worker_answers SET n = n + 1, held = held - 1 WHERE token_id = ? AND day = ? AND held > 0').bind(workerId, day).run();
}

/** The call failed (no answer, a stopped reply, an instruction that cannot be read): the place goes back and the
 * price with it. */
export async function release(env: Db, workerId: string, day: number): Promise<void> {
  await env.DB.prepare('UPDATE worker_answers SET held = held - 1 WHERE token_id = ? AND day = ? AND held > 0').bind(workerId, day).run();
}

/** The cron's part: the places a dead desk left, and the days before yesterday. */
export async function cleanQuotes(env: Db, nowMs: number, today: number): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('UPDATE worker_answers SET held = 0 WHERE held > 0 AND held_at < ?').bind(nowMs - STALE_HELD_MS),
    env.DB.prepare('DELETE FROM worker_answers WHERE day < ?').bind(today - 1),
  ]);
}
