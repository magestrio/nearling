// Reconcile the D1 watch result after its one debit. A chain outcome can arrive after the
// invocation that searched has gone away; the pending observation is never a baseline until paid.
import { debitWatchNow } from '../debit';
import { petView } from '../chain';
import { costUsd12, usd12ToMicros } from '../pricing';
import { projectPays } from '../spend';
import { track } from '../track';
import { storePaidObservation } from './observation';
import { watchRow } from './target';

interface Pending {
  token_id: string;
  day: number;
  revision: number;
  status: string;
  receipt_id: string;
  price_yocto: string | null;
  changed: number;
  pending_content: string | null;
  pending_sources: string | null;
  pending_result: string | null;
  cost_usd_micros: number | null;
  owner_generation: number | null;
  thought_status: string;
  session_id: string;
  thought_id: string;
  price_usd_micros: number;
}

async function pendingOf(db: D1Database, tokenId: string, day: number): Promise<Pending | null> {
  return db.prepare(`SELECT c.*, t.status AS thought_status, t.session_id, t.id AS thought_id, t.price_usd_micros
    FROM watch_checks c JOIN thoughts t ON t.id = c.receipt_id
    WHERE c.token_id = ? AND c.day = ? AND c.status IN ('started', 'paid')`)
    .bind(tokenId, day).first<Pending>();
}

/** True once the chain billed this check and D1 carries its result, or the batch was refused. */
export async function finishWatch(env: Env, tokenId: string, day: number): Promise<boolean> {
  const pending = await pendingOf(env.DB, tokenId, day);
  if (pending === null) return false;
  if (pending.thought_status === 'unbilled') {
    const session = await env.DB.prepare('SELECT tx_hash, debit_id, claimed_at FROM debit_sessions WHERE id = ?')
      .bind(pending.session_id).first<{ tx_hash: string | null; debit_id: number | null; claimed_at: number | null }>();
    if (session?.tx_hash === null && session.debit_id === null && session.claimed_at === null) {
      const [pet, target] = await Promise.all([petView(env, tokenId), watchRow(env.DB, tokenId)]);
      if (pet?.transfer_generation !== pending.owner_generation || target?.revision !== pending.revision
        || target.paused === 1 || pending.pending_result === null) {
        const stopped = await env.DB.batch([
          env.DB.prepare(`UPDATE debit_sessions SET status = 'done' WHERE id = ?
            AND status IN ('open', 'sending') AND tx_hash IS NULL AND debit_id IS NULL AND claimed_at IS NULL`)
            .bind(pending.session_id),
          env.DB.prepare(`UPDATE thoughts SET status = 'project' WHERE id = ? AND status = 'unbilled'
            AND EXISTS (SELECT 1 FROM debit_sessions WHERE id = ? AND status = 'done' AND tx_hash IS NULL AND debit_id IS NULL)`)
            .bind(pending.thought_id, pending.session_id),
        ]);
        if (stopped[1]?.meta.changes === 1) {
          const calls = await env.DB.prepare('SELECT tokens_in, tokens_out FROM thought_calls WHERE thought_id = ?')
            .bind(pending.thought_id).all<{ tokens_in: number; tokens_out: number }>();
          const tokenCost = calls.results.reduce((sum, call) => sum + costUsd12(env, call.tokens_in, call.tokens_out), 0n);
          const searchCost = pending.pending_result === 'no_search' ? 0 : Number(env.SEARCH_USD_PER_CALL);
          await projectPays(env, 'watch_cancelled', usd12ToMicros(tokenCost) + Math.round(searchCost * 1e6));
          return finishWatch(env, tokenId, day);
        }
      }
    }
    await debitWatchNow(env, pending.session_id);
    const after = await pendingOf(env.DB, tokenId, day);
    return after?.thought_status === 'unbilled' ? false : finishWatch(env, tokenId, day);
  }
  if (pending.thought_status === 'project') {
    const written = await env.DB.prepare(`UPDATE watch_checks SET status = 'failed', receipt_id = NULL,
      price_yocto = NULL, pending_content = NULL, pending_sources = NULL, pending_result = NULL
      WHERE token_id = ? AND day = ? AND status = 'started'`).bind(tokenId, day).run();
    if (pending.pending_result !== null) await env.DB.prepare("UPDATE watch_targets SET latest_result = 'failed' WHERE token_id = ? AND revision = ?")
      .bind(tokenId, pending.revision).run();
    if (written.meta.changes === 1) track('watch_checked', { outcome: 'failed',
      cost_usd: (pending.cost_usd_micros ?? 0) / 1e6, price_usd: 0 });
    return true;
  }
  if (pending.thought_status !== 'billed') return false;
  const first = pending.status === 'started';
  if (first) await env.DB.prepare("UPDATE watch_checks SET status = 'paid' WHERE token_id = ? AND day = ? AND status = 'started'")
    .bind(tokenId, day).run();
  const target = await watchRow(env.DB, tokenId);
  if (target?.revision === pending.revision && target.paused === 0 && pending.pending_result !== null) {
    if (pending.pending_content !== null) await storePaidObservation(env.DB, tokenId, day, pending.revision,
      { namedContent: pending.pending_content, sourceUrls: JSON.parse(pending.pending_sources ?? '[]') as string[] });
    await env.DB.prepare('UPDATE watch_targets SET latest_result = ?, latest_price_yocto = ?, latest_receipt_id = ? WHERE token_id = ? AND revision = ?')
      .bind(pending.pending_result, pending.price_yocto, pending.receipt_id, tokenId, pending.revision).run();
  }
  await env.DB.prepare('UPDATE watch_checks SET pending_content = NULL, pending_sources = NULL, pending_result = NULL WHERE token_id = ? AND day = ?')
    .bind(tokenId, day).run();
  if (first) track('watch_checked', {
    outcome: pending.pending_result === 'changed' ? 'changed' : pending.pending_result === 'first' || pending.pending_result === 'unchanged' ? 'unchanged' : 'failed',
    cost_usd: (pending.cost_usd_micros ?? 0) / 1e6,
    price_usd: pending.price_usd_micros / 1e6,
  });
  return true;
}

/** Retries only already-started checks. It never reads a source or uses another day slot. */
export async function finishDueWatches(env: Env): Promise<void> {
  const due = await env.DB.prepare(`SELECT token_id, day FROM watch_checks
    WHERE receipt_id IS NOT NULL AND (status = 'started' OR (status = 'paid' AND pending_result IS NOT NULL))
    ORDER BY started_at LIMIT 10`).all<{ token_id: string; day: number }>();
  for (const { token_id, day } of due.results) {
    try { await finishWatch(env, token_id, day); }
    catch { console.log('watch_settle_failed'); }
  }
}
