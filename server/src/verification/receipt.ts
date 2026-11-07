import { receiptTransaction } from '../chain';

export interface ReceiptThought {
  id: string;
  token_id: string;
  receipt_token_id: string | null;
  paying_token_id: string | null;
  debit_tx_hash: string | null;
  status: string;
  kind: string;
  erased_at: number | null;
  link_eligible: number;
  skilled: number;
  adapter_used: number;
  model: string;
  price_yocto: string;
  worker_id: string | null;
}

export interface StoredCall {
  n: number;
  req_bytes: ArrayBuffer | Uint8Array | null;
  res_bytes: ArrayBuffer | Uint8Array | null;
  req_sha256: string;
  res_sha256: string;
  signature: string;
  sig_kind: string;
  signer: string;
  tokens_in: number;
  tokens_out: number;
  tokens_reasoning: number;
  cut: number;
}

interface ChainEvent { standard: string; version: string; event: string; data: unknown[] }
interface Outcome {
  status?: Record<string, unknown>;
  transaction?: { signer_id?: string; receiver_id?: string; actions?: Record<string, unknown>[] };
  receipts_outcome?: { outcome?: { logs?: string[] } }[];
}

function eventOf(log: string): ChainEvent | null {
  if (!log.startsWith('EVENT_JSON:')) return null;
  try {
    const value = JSON.parse(log.slice(11)) as ChainEvent;
    return value.standard === 'nearling' && value.version === '1.0.0' && Array.isArray(value.data) ? value : null;
  } catch { return null; }
}

function sameCall(a: Record<string, unknown>, b: StoredCall): boolean {
  return a.req_sha256 === b.req_sha256 && a.res_sha256 === b.res_sha256
    && a.signature === b.signature && a.sig_kind === b.sig_kind && a.signer === b.signer
    && a.tokens_in === b.tokens_in && a.tokens_out === b.tokens_out
    && a.tokens_reasoning === b.tokens_reasoning && a.cut === (b.cut === 1);
}

function rawBytes(value: ArrayBuffer | Uint8Array | null): Uint8Array {
  if (value === null) return new Uint8Array();
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}

export function intactCalls(calls: StoredCall[]): boolean {
  return calls.length > 0 && calls.length <= 4 && calls.every((call, i) =>
    call.n === i && rawBytes(call.req_bytes).length > 0 && rawBytes(call.res_bytes).length > 0);
}

export async function intactCallHashes(calls: StoredCall[]): Promise<boolean> {
  if (!intactCalls(calls)) return false;
  for (const call of calls) {
    if (!await hashMatches(rawBytes(call.req_bytes), call.req_sha256)
      || !await hashMatches(rawBytes(call.res_bytes), call.res_sha256)) return false;
  }
  return true;
}

async function hashMatches(bytes: Uint8Array, expected: string): Promise<boolean> {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return expected === Array.from(hash, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Refuses ambiguous or incomplete evidence. A thought id is not on chain, so its full call
 * tuple must select exactly one receipt inside the executed batch. */
export async function matchingReceipt(env: Env, row: ReceiptThought, calls: StoredCall[], hire: { fee_yocto: string; skilled: number; status: string; experience: number } | null): Promise<boolean> {
  if (row.status !== 'billed' || row.debit_tx_hash === null || row.paying_token_id === null
    || row.receipt_token_id === null || row.link_eligible !== 1 || row.skilled === 1
    || row.adapter_used === 1 || hire?.experience === 1 || row.erased_at !== null || !intactCalls(calls)
    || row.receipt_token_id !== (row.kind === 'hire_question' ? row.paying_token_id : (row.worker_id ?? row.paying_token_id))) return false;
  if (!await intactCallHashes(calls)) return false;
  const outcome = await receiptTransaction(env, row.debit_tx_hash, env.SERVER_ACCOUNT_ID) as Outcome;
  if (!outcome || !outcome.status || !('SuccessValue' in outcome.status)
    || outcome.transaction?.signer_id !== env.SERVER_ACCOUNT_ID
    || outcome.transaction.receiver_id !== env.CONTRACT_ID) return false;
  const actions = outcome.transaction.actions;
  if (!Array.isArray(actions) || actions.length !== 1 || !('FunctionCall' in actions[0]!)) return false;
  const action = actions[0]!.FunctionCall as { method_name?: string; args?: string };
  if (action.method_name !== 'debit_session' || typeof action.args !== 'string') return false;
  let input: { token_id?: string; debit_id?: number };
  try { input = JSON.parse(atob(action.args)) as typeof input; } catch { return false; }
  if (input.token_id !== row.paying_token_id || !Number.isSafeInteger(input.debit_id)) return false;
  const events = (outcome.receipts_outcome ?? []).flatMap((receipt) => receipt.outcome?.logs ?? [])
    .map(eventOf).filter((event): event is ChainEvent => event !== null);
  const matches = events.flatMap((event, eventIndex) => event.event === 'receipt'
    ? event.data.map((data) => ({ data, eventIndex })) : []);
  const found = matches.filter(({ data }) => {
    if (typeof data !== 'object' || data === null) return false;
    const receipt = data as Record<string, unknown>;
    const receiptCalls = receipt.calls;
    if (receipt.token_id !== row.paying_token_id || receipt.debit_id !== input.debit_id
      || receipt.model !== row.model || receipt.price !== row.price_yocto
      || (receipt.worker ?? null) !== (row.kind === 'hire_question' ? null : row.worker_id) || !Array.isArray(receiptCalls)
      || receiptCalls.length !== calls.length) return false;
    return calls.every((call, i) => typeof receiptCalls[i] === 'object'
      && receiptCalls[i] !== null && sameCall(receiptCalls[i] as Record<string, unknown>, call));
  });
  if (found.length !== 1) return false;
  const eventIndex = found[0]!.eventIndex;
  const next = events[eventIndex + 1];
  if (hire === null) return next?.event !== 'hire';
  if (hire.status !== 'recorded' || next?.event !== 'hire' || next.data.length !== 1) return false;
  if (typeof next.data[0] !== 'object' || next.data[0] === null) return false;
  const data = next.data[0] as Record<string, unknown>;
  return data.debit_id === input.debit_id && data.hirer === row.paying_token_id
    && data.worker === row.worker_id && data.fee === hire.fee_yocto
    && data.answer_cost === row.price_yocto && data.skill === (hire.skilled === 1);
}

export function callBytes(call: StoredCall, part: 'request' | 'reply'): Uint8Array {
  return rawBytes(part === 'request' ? call.req_bytes : call.res_bytes);
}
