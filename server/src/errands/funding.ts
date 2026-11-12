import { ChainUnreachable, petView, receiptTransaction, type PetRecord } from '../chain';
import type { Session } from '../auth';
import { memoryEpoch } from '../pet/forget';
import type { FeedingRow } from '../pet/settle';
import { hashCode, linkIsCurrent, sharedForCode } from './shared';

const CODE = /^[0-9a-f]{64}$/;

/** A link code is authority only to name the active funding job, never to impersonate its owner. */
export async function fundingTag(env: Env, tokenId: string, session: Session, code: unknown, pet?: PetRecord): Promise<{ hash: string | null; error?: string }> {
  if (code === undefined || code === null) return { hash: null };
  if (typeof code !== 'string' || !CODE.test(code)) return { hash: null, error: 'bad_request' };
  const current = pet ?? await petView(env, tokenId);
  if (current === null) return { hash: null, error: 'no_pet' };
  if (current.owner_id === session.accountId) return { hash: null, error: 'shared_owner_cannot_fund' };
  const row = await sharedForCode(env.DB, tokenId, await hashCode(code));
  if (row === null || !linkIsCurrent(row, current, await memoryEpoch(env.DB, tokenId))) return { hash: null, error: 'shared_unavailable' };
  if (current.shared_job?.state !== 'Funding') return { hash: null, error: 'shared_funding_closed' };
  if (BigInt(current.shared_job.linked_near) + BigInt(current.shared_job.linked_snack) >= BigInt(row.allowance_yocto))
    return { hash: null, error: 'shared_funding_closed' };
  return { hash: row.job_hash };
}

interface Event { standard?: unknown; event?: unknown; data?: unknown }
interface FundingEvent { token_id?: unknown; feeder?: unknown; friend?: unknown; amount?: unknown; job_hash?: unknown; funding_index?: unknown }

/** Read the exact confirmed NEP-297 event, including its funding index, from the known transaction. */
export async function confirmedFunding(env: Env, row: FeedingRow): Promise<{ txHash: string; amount: string; index: number }> {
  if (row.tx_hash === null || row.job_hash == null) throw new ChainUnreachable();
  const raw = await receiptTransaction(env, row.tx_hash, row.source === 'near' ? row.account : env.SERVER_ACCOUNT_ID) as {
    transaction?: { receiver_id?: string; signer_id?: string };
    receipts_outcome?: Array<{ outcome?: { logs?: string[] } }>;
  };
  if (raw.transaction?.receiver_id !== env.CONTRACT_ID || raw.transaction.signer_id !== (row.source === 'near' ? row.account : env.SERVER_ACCOUNT_ID)) throw new ChainUnreachable();
  for (const receipt of raw.receipts_outcome ?? []) for (const line of receipt.outcome?.logs ?? []) {
    if (!line.startsWith('EVENT_JSON:')) continue;
    let event: Event;
    try { event = JSON.parse(line.slice('EVENT_JSON:'.length)) as Event; } catch { continue; }
    if (event.standard !== 'nearling' || event.event !== (row.source === 'near' ? 'feed' : 'snack') || typeof event.data !== 'object' || event.data === null) continue;
    // the contract writes one object per event; an array is read as well
    for (const item of (Array.isArray(event.data) ? event.data : [event.data]) as FundingEvent[]) {
      const contributor = row.source === 'near' ? item.feeder : item.friend;
      if (item.token_id !== row.token_id || item.job_hash !== row.job_hash || contributor !== row.account) continue;
      if (typeof item.amount !== 'string' || !/^[0-9]+$/.test(item.amount) || !Number.isInteger(item.funding_index)) continue;
      return { txHash: row.tx_hash, amount: item.amount, index: item.funding_index as number };
    }
  }
  throw new ChainUnreachable();
}
