import { ChainUnreachable, petView, receiptTransaction } from '../chain';
import { debitSharedNow } from '../debit';
import type { ErrandRow } from './store';

const CLOSE_GAS = (5n * 1_000_000_000_000n).toString();

interface PaidThought {
  id: string;
  status: string;
  debit_tx_hash: string | null;
  reply_text: string | null;
  sources: string | null;
}

/** A paid outcome has one linked receipt. An unpaid failure keeps the reserve for owner approval. */
export async function settleSharedOutcome(env: Env, row: ErrandRow): Promise<void> {
  const hash = row.shared_job_hash;
  if (hash == null) return;
  const ended = await env.DB.prepare('SELECT state, thought_id FROM errands WHERE token_id = ? AND id = ? AND shared_job_hash = ?')
    .bind(row.token_id, row.id, hash).first<{ state: string; thought_id: string | null }>();
  if (ended === null || ended.state === 'away') return;
  if (ended.thought_id === null) {
    await env.DB.prepare("UPDATE shared_errands SET state = 'failed', report = NULL, sources = NULL, receipt_id = NULL, updated_at = ? WHERE token_id = ? AND job_hash = ? AND state = 'running'")
      .bind(Date.now(), row.token_id, hash).run();
    return;
  }
  await debitSharedNow(env, row.token_id, hash);
  await finishPaidShared(env, row.token_id, hash);
}

interface FundingSpend { index?: unknown; amount?: unknown; kind?: unknown }

/** Replays the confirmed receipt after a lost D1 write and closes only a settled chain reserve. */
export async function finishPaidShared(env: Env, tokenId: string, hash: string): Promise<boolean> {
  const thought = await env.DB.prepare("SELECT id, status, debit_tx_hash, reply_text, sources FROM thoughts WHERE token_id = ? AND shared_job_hash = ? ORDER BY created_at DESC LIMIT 1")
    .bind(tokenId, hash).first<PaidThought>();
  if (thought?.status !== 'billed' || thought.debit_tx_hash === null) return false;
  const spent = await readSharedReceiptFunding(env, thought.debit_tx_hash, hash);
  const statements: D1PreparedStatement[] = [];
  for (const item of spent) {
    statements.push(env.DB.prepare('UPDATE shared_errand_contributions SET spent_yocto = ? WHERE token_id = ? AND job_hash = ? AND funding_index = ? AND source = ?')
      .bind(item.amount, tokenId, hash, item.index, item.kind));
    statements.push(env.DB.prepare('UPDATE shared_funding_evidence SET spent_yocto = ? WHERE token_id = ? AND job_hash = ? AND funding_index = ? AND source = ?')
      .bind(item.amount, tokenId, hash, item.index, item.kind));
  }
  statements.push(env.DB.prepare(
    "UPDATE shared_errands SET state = ?, report = ?, sources = ?, receipt_id = ?, updated_at = ? WHERE token_id = ? AND job_hash = ? AND state IN ('running', 'reported', 'failed')",
  ).bind(thought.reply_text === null ? 'failed' : 'reported', thought.reply_text, thought.sources, thought.id, Date.now(), tokenId, hash));
  await env.DB.batch(statements);
  const pet = await petView(env, tokenId);
  if (pet?.shared_job?.hash !== hash) return true;
  if (pet.shared_job.state !== 'Settled') return false;
  const close = await env.SERVER_KEY.get(env.SERVER_KEY.idFromName('server')).send({
    methodName: 'shared_job_close', args: { token_id: tokenId, job_hash: hash, owner_approval: null }, gas: CLOSE_GAS,
  });
  if (close.status === 'ok') return true;
  const after = await petView(env, tokenId);
  return after?.shared_job?.hash !== hash;
}

/** The receipt itself supplies spent amounts; D1 supplies only the confirmed funding transaction pointers. */
export async function readSharedReceiptFunding(env: Env, txHash: string, hash: string): Promise<Array<{ index: number; kind: 'near' | 'snack'; amount: string }>> {
  const raw = await receiptTransaction(env, txHash, env.SERVER_ACCOUNT_ID) as {
    transaction?: { receiver_id?: string; signer_id?: string };
    receipts_outcome?: Array<{ outcome?: { logs?: string[] } }>;
  };
  if (raw.transaction?.receiver_id !== env.CONTRACT_ID || raw.transaction.signer_id !== env.SERVER_ACCOUNT_ID) throw new ChainUnreachable();
  let spent: FundingSpend[] | null = null;
  for (const outcome of raw.receipts_outcome ?? []) for (const line of outcome.outcome?.logs ?? []) {
    if (!line.startsWith('EVENT_JSON:')) continue;
    try {
      const event = JSON.parse(line.slice('EVENT_JSON:'.length)) as { standard?: string; event?: string; data?: Array<{ job_hash?: string; funding?: FundingSpend[] }> };
      if (event.standard === 'nearling' && event.event === 'receipt') {
        const record = event.data?.find((item) => item.job_hash === hash);
        if (record !== undefined && Array.isArray(record.funding)) spent = record.funding;
      }
    } catch { /* A different contract log cannot prove attribution. */ }
  }
  if (spent === null) throw new ChainUnreachable();
  return spent.map((item) => {
    if (!Number.isInteger(item.index) || typeof item.amount !== 'string' || !/^[0-9]+$/.test(item.amount) ||
      (item.kind !== 'near' && item.kind !== 'snack')) throw new ChainUnreachable();
    return { index: item.index as number, kind: item.kind, amount: item.amount };
  });
}

/** The cron finishes a confirmed debit whose response or D1 write was lost. */
export async function finishDueShared(env: Env): Promise<void> {
  const rows = await env.DB.prepare("SELECT token_id, job_hash FROM shared_errands WHERE state = 'running' OR (state IN ('reported', 'failed') AND receipt_id IS NOT NULL) ORDER BY updated_at LIMIT 10")
    .all<{ token_id: string; job_hash: string }>();
  for (const row of rows.results) {
    try {
      if (await finishPaidShared(env, row.token_id, row.job_hash)) continue;
      const errand = await env.DB.prepare("SELECT * FROM errands WHERE token_id = ? AND shared_job_hash = ? AND state != 'away'")
        .bind(row.token_id, row.job_hash).first<ErrandRow>();
      if (errand !== null) await settleSharedOutcome(env, errand);
    }
    catch (error) { console.log(error instanceof ChainUnreachable ? 'shared_settle_chain' : 'shared_settle_failed'); }
  }
}
