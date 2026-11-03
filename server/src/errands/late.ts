// An errand that is not back 3 minutes after «Send» has come back empty (`Errand flow` › «not back in 3 minutes»,
// `Errand access data`): the pet pays only the searches that ran, the reserve goes back, a report that lands after it
// is neither stored nor paid by the pet (the job's conditional end finds the errand no longer away).
import { petView, type PetRecord } from '../chain';
import { utcDay } from '../http';
import { openSession, yoctoMicros } from '../spend';
import { foodState } from '../pet/view';
import { track } from '../track';
import { afterThought } from './after';
import { cutBoundUsd, cutPrice, errandPrice } from './price';
import { announceFailed, tokensCostUsd, type ErrandRow, type Paid } from './store';

/** The errand's own deadline, from «Send». */
export const ERRAND_DEADLINE_MS = 180_000;

/** Settles the pet's errand if it is away past its deadline; true when this call ended it. `pet` is the pet's record
 * when the caller read it already (the state poll does). A chain that cannot be read leaves the errand for the next
 * minute: the price of the searches that ran needs the food. */
export async function settleLate(env: Env, tokenId: string, now: number = Date.now(), known?: PetRecord): Promise<boolean> {
  const row = await env.DB.prepare("SELECT * FROM errands WHERE token_id = ? AND state = 'away' AND sent_at <= ?").bind(tokenId, now - ERRAND_DEADLINE_MS).first<ErrandRow>();
  if (row === null) return false;
  return settleRecorded(env, row, 'timeout', now, known);
}

/** An unexpected failure after the signed search was stored still owes for those searches. `null` means no
 * recorded search was found, so the caller may use its no-spend failure path. */
export async function settleInterrupted(env: Env, tokenId: string, now: number = Date.now()): Promise<boolean | null> {
  const row = await env.DB.prepare("SELECT * FROM errands WHERE token_id = ? AND state = 'away'").bind(tokenId).first<ErrandRow>();
  if (row?.thought_id === null || row === null) return null;
  return settleRecorded(env, row, 'empty', now);
}

async function settleRecorded(env: Env, row: ErrandRow, reason: 'timeout' | 'empty', now: number, known?: PetRecord): Promise<boolean> {
  const tokenId = row.token_id;
  // The searches that ran are the stored `away` thought of the errand; with none, nothing was spent.
  let price: bigint | null = null;
  let calls: { tokensIn: number; tokensOut: number; cut: number }[] = [];
  let pet: PetRecord | null = null;
  if (row.thought_id !== null) {
    pet = known ?? (await petView(env, tokenId));
    if (pet === null) return false;
    const stored = await env.DB.prepare("SELECT tokens_in AS tokensIn, tokens_out AS tokensOut, cut FROM thought_calls WHERE thought_id = ? AND label = 'search' ORDER BY n").bind(row.thought_id).all<{ tokensIn: number; tokensOut: number; cut: number }>();
    calls = stored.results;
    const fs = await foodState(env.DB, tokenId, pet, now);
    price = await cutPrice(env, fs, errandPrice(env, calls, row.searches_ran));
  }
  const sessionId = price === null ? null : await openSession(env, tokenId, now);

  const ended = await env.DB.batch([
    env.DB
      .prepare(
        `UPDATE errands SET state = 'failed', reason = ?3, cause = NULL, reserve_yocto = '0', price_yocto = ?4
         WHERE token_id = ?1 AND id = ?2 AND state = 'away' RETURNING id`,
      )
      .bind(row.token_id, row.id, reason, price === null ? null : price.toString()),
    // The thought of the searches turns `unbilled` only in the batch that ended the errand.
    env.DB
      .prepare(
        `UPDATE thoughts SET player_text = ?5, price_yocto = ?6, price_usd_micros = ?7, session_id = ?8, status = 'unbilled'
         WHERE id = ?3 AND status = 'away' AND EXISTS (SELECT 1 FROM errands WHERE token_id = ?1 AND id = ?2 AND state = 'failed' AND reason = ?4 AND thought_id = ?3)`,
      )
      .bind(row.token_id, row.id, row.thought_id ?? '', reason, row.job, price === null ? '0' : price.toString(), price === null ? 0 : yoctoMicros(env, price), sessionId),
    env.DB.prepare('DELETE FROM pet_spend WHERE token_id = ? AND reserve_yocto = ?').bind(row.token_id, row.reserve_yocto),
  ]);
  if ((ended[0]?.results.length ?? 0) === 0) return false;

  // A call still unfinished at the deadline is not waited for.
  const open = await env.DB.prepare("SELECT 1 AS found FROM jobs WHERE token_id = ? AND kind = 'errand' AND status IN ('queued', 'running') LIMIT 1").bind(row.token_id).first();
  if (open !== null && reason === 'timeout') track('thought_failed', { for: 'errand', reason: 'not_waited' });
  const cut = calls.some((call) => call.cut === 1);
  const paid: Paid =
    price === null ? { priceUsd: 0, costUsd: 0 } : { priceUsd: yoctoMicros(env, price) / 1e6, costUsd: tokensCostUsd(env, calls) + row.searches_ran * Number(env.SEARCH_USD_PER_CALL) };
  announceFailed(row, { reason, searches: row.searches_ran, paid, cut, projectUsd: cut ? cutBoundUsd(env, Math.max(row.searches_ran, 1)) : 0 });
  if (price !== null && pet !== null) {
    await afterThought(env, tokenId, pet, await foodState(env.DB, tokenId, pet, now), { price: 0n, cut: null, shown: false, today: utcDay(now), now });
  }
  return true;
}

/** The cron's pass over every errand away past its deadline. */
export async function settleLateErrands(env: Env, now: number): Promise<void> {
  const due = await env.DB.prepare("SELECT token_id FROM errands WHERE state = 'away' AND sent_at <= ?").bind(now - ERRAND_DEADLINE_MS).all<{ token_id: string }>();
  for (const { token_id } of due.results) {
    try {
      await settleLate(env, token_id, now);
    } catch {
      // The errand stays away and the next minute settles it; one pet's chain never holds the others.
      console.log('errand_settle_failed');
    }
  }
}
