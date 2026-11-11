import { ChainUnreachable, rpcProvider } from '../chain';
import { ONE_CLICK } from './quote';

const HASH = /^[1-9A-HJ-NP-Za-km-z]{32,100}$/;
const ROUTE = /^[0-9a-f]{32}$/;
const YOCTO = /^\d{1,39}$/;

interface EventData {
  credit_id?: number;
  delivery_id?: number;
  route_id?: string;
  token_id?: string;
  amount?: string;
  reason?: string;
  sender_id?: string;
}
interface ContractEvent { event: string; data: EventData | EventData[] }
interface ReceiptAction { FunctionCall?: { method_name: string; args: string } }
interface NearReceipt {
  receipt_id: string;
  predecessor_id: string;
  receiver_id: string;
  receipt?: { Action?: { actions: ReceiptAction[] } };
}
interface NearOutcome { id: string; outcome: { executor_id: string; logs: string[]; status: unknown } }
interface NearTransaction {
  final_execution_status: string;
  transaction: { hash: string; signer_id: string };
  receipts: NearReceipt[];
  receipts_outcome: NearOutcome[];
}
export interface DeliveryEvidence {
  receiptId: string;
  nearTxHash: string;
  routeId: string | null;
  tokenId: string | null;
  amount: string;
  kind: 'pending' | 'held';
  creditId: number | null;
  heldId: number | null;
  reason: string | null;
  credited: boolean;
  unwrapFailed: boolean;
}

function recordEvent(log: string): ContractEvent | null {
  if (!log.startsWith('EVENT_JSON:')) return null;
  try {
    const parsed = JSON.parse(log.slice('EVENT_JSON:'.length)) as ContractEvent & { standard?: string };
    return parsed.standard === 'nearling' ? parsed : null;
  } catch { return null; }
}

/** Read the final public receipt, including the actual wrap.near call. A provider hash alone never creates evidence. */
export function parseDelivery(raw: unknown, expectedTx: string, contractId: string, txSigner = 'intents.near'): DeliveryEvidence[] {
  const tx = raw as NearTransaction;
  if (!tx || tx.final_execution_status !== 'FINAL' || tx.transaction?.hash !== expectedTx ||
    tx.transaction.signer_id !== txSigner || !Array.isArray(tx.receipts) || !Array.isArray(tx.receipts_outcome)) return [];
  const events = new Map<string, { event: string; data: EventData }[]>();
  for (const result of tx.receipts_outcome) {
    if (result.outcome?.executor_id !== contractId || !Array.isArray(result.outcome.logs)) continue;
    const rows: { event: string; data: EventData }[] = [];
    for (const log of result.outcome.logs) {
      const item = recordEvent(log);
      if (!item) continue;
      const data = Array.isArray(item.data) ? item.data : [item.data];
      for (const value of data) rows.push({ event: item.event, data: value });
    }
    events.set(result.id, rows);
  }
  const credits = new Map<number, EventData>();
  for (const rows of events.values()) for (const row of rows)
    if (row.event === 'cross_chain_feed' && Number.isSafeInteger(row.data.credit_id)) credits.set(row.data.credit_id!, row.data);
  const failedWithdraw = tx.receipts.some((receipt) =>
    receipt.receiver_id === 'wrap.near' &&
    receipt.receipt?.Action?.actions.some((action) => action.FunctionCall?.method_name === 'near_withdraw') &&
    tx.receipts_outcome.some((outcome) => outcome.id === receipt.receipt_id &&
      typeof outcome.outcome?.status === 'object' && outcome.outcome.status !== null && 'Failure' in outcome.outcome.status));
  const callbacks = new Set<number>();
  for (const receipt of tx.receipts) {
    if (receipt.receiver_id !== contractId) continue;
    const call = receipt.receipt?.Action?.actions.find((action) => action.FunctionCall?.method_name === 'on_unwrap')?.FunctionCall;
    if (!call) continue;
    try {
      const args = JSON.parse(atob(call.args)) as { credit_id?: number };
      if (Number.isSafeInteger(args.credit_id) && tx.receipts_outcome.some((outcome) => outcome.id === receipt.receipt_id &&
        typeof outcome.outcome?.status === 'object' && outcome.outcome.status !== null && 'SuccessValue' in outcome.outcome.status))
        callbacks.add(args.credit_id!);
    } catch { /* No callback proof. */ }
  }
  const found: DeliveryEvidence[] = [];
  for (const receipt of tx.receipts) {
    if (receipt.receiver_id !== contractId || receipt.predecessor_id !== 'wrap.near') continue;
    const call = receipt.receipt?.Action?.actions.find((action) => action.FunctionCall?.method_name === 'ft_on_transfer')?.FunctionCall;
    if (!call || !events.has(receipt.receipt_id)) continue;
    let args: { sender_id?: unknown; amount?: unknown; msg?: unknown };
    try { args = JSON.parse(atob(call.args)) as typeof args; } catch { continue; }
    if (typeof args.sender_id !== 'string' || typeof args.amount !== 'string' || !YOCTO.test(args.amount)) continue;
    let message: { route?: unknown; token_id?: unknown } = {};
    try { message = JSON.parse(String(args.msg)) as typeof message; } catch { /* Held receipt may have malformed msg. */ }
    const matching = events.get(receipt.receipt_id) ?? [];
    const row = matching.find((item) => item.event === 'cross_chain_pending' || item.event === 'cross_chain_held');
    if (!row || row.data.amount !== args.amount) continue;
    if (row.event === 'cross_chain_pending' && (args.sender_id !== 'intents.near' || !Number.isSafeInteger(row.data.credit_id) ||
      row.data.route_id !== message.route || row.data.token_id !== message.token_id)) continue;
    if (row.event === 'cross_chain_held' && (!Number.isSafeInteger(row.data.delivery_id) ||
      row.data.sender_id !== args.sender_id)) continue;
    found.push({ receiptId: receipt.receipt_id, nearTxHash: expectedTx,
      routeId: typeof row.data.route_id === 'string' && ROUTE.test(row.data.route_id) ? row.data.route_id : null,
      tokenId: typeof row.data.token_id === 'string' ? row.data.token_id : null,
      amount: args.amount, kind: row.event === 'cross_chain_held' ? 'held' : 'pending',
      creditId: row.data.credit_id ?? null, heldId: row.data.delivery_id ?? null,
      reason: row.data.reason ?? null, credited: row.data.credit_id !== undefined &&
        credits.get(row.data.credit_id)?.amount === args.amount &&
        credits.get(row.data.credit_id)?.route_id === row.data.route_id &&
        credits.get(row.data.credit_id)?.token_id === row.data.token_id,
      unwrapFailed: failedWithdraw && callbacks.size === 1 && row.data.credit_id !== undefined && callbacks.has(row.data.credit_id) });
  }
  return found;
}

export interface ProviderStatus {
  status: string;
  correlationId?: string;
  swapDetails?: {
    originChainTxHashes?: { hash: string }[];
    destinationChainTxHashes?: { hash: string }[];
    nearTxHashes?: string[];
    depositedAmount?: string;
    refundedAmount?: string;
    refundReason?: string | null;
    amountOut?: string;
  };
  quoteResponse?: { quoteRequest?: { refundTo?: string; originAsset?: string; destinationAsset?: string; recipient?: string;
    customRecipientMsg?: string } };
}

export async function providerStatus(address: string, memo: string | null): Promise<ProviderStatus> {
  const url = new URL(`${ONE_CLICK}/status`);
  url.searchParams.set('depositAddress', address);
  if (memo) url.searchParams.set('depositMemo', memo);
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    if (!response.ok) throw new Error('provider');
    const body = await response.json() as ProviderStatus;
    if (!body || !['KNOWN_DEPOSIT_TX', 'PENDING_DEPOSIT', 'INCOMPLETE_DEPOSIT', 'PROCESSING', 'SUCCESS', 'REFUNDED', 'FAILED'].includes(body.status)) throw new Error('shape');
    return body;
  } catch { throw new ChainUnreachable(); }
}

export async function readDeliveries(env: Env, hashes: string[], txSigner = 'intents.near'): Promise<DeliveryEvidence[]> {
  const all: DeliveryEvidence[] = [];
  for (const hash of hashes) {
    if (!HASH.test(hash)) continue;
    let raw: unknown;
    try {
      raw = await rpcProvider(env).viewTransactionStatus({ txHash: hash, accountId: txSigner, waitUntil: 'FINAL' });
    } catch { continue; }
    all.push(...parseDelivery(raw, hash, env.CONTRACT_ID, txSigner));
  }
  return all;
}

export async function retryOutcome(env: Env, hash: string, creditId: number, routeId: string, tokenId: string,
  amount: string): Promise<'settled' | 'failed' | 'pending'> {
  let raw: unknown;
  try { raw = await rpcProvider(env).viewTransactionStatus({ txHash: hash, accountId: env.GAS_ACCOUNT_ID, waitUntil: 'FINAL' }); }
  catch { return 'pending'; }
  const tx = raw as NearTransaction;
  if (tx.final_execution_status !== 'FINAL' || tx.transaction?.hash !== hash ||
    tx.transaction.signer_id !== env.GAS_ACCOUNT_ID || !Array.isArray(tx.receipts_outcome)) return 'pending';
  const transaction = tx.transaction as NearTransaction['transaction'] & { receiver_id?: string;
    actions?: { FunctionCall?: { method_name?: string; args?: string } }[] };
  if (transaction.receiver_id !== env.CONTRACT_ID) return 'pending';
  const call = transaction.actions?.find((item) => item.FunctionCall?.method_name === 'retry_unwrap')?.FunctionCall;
  if (!call?.args) return 'pending';
  try { if (JSON.parse(atob(call.args))?.credit_id !== creditId) return 'pending'; }
  catch { return 'pending'; }
  for (const outcome of tx.receipts_outcome) {
    if (outcome.outcome?.executor_id !== env.CONTRACT_ID) continue;
    for (const line of outcome.outcome.logs ?? []) {
      const event = recordEvent(line);
      const data = Array.isArray(event?.data) ? event.data[0] : event?.data;
      if (event?.event === 'cross_chain_feed' && data?.credit_id === creditId && data.route_id === routeId &&
        data.token_id === tokenId && data.amount === amount) return 'settled';
    }
  }
  const failed = (tx.receipts ?? []).some((receipt) => receipt.receiver_id === 'wrap.near' &&
    receipt.receipt?.Action?.actions.some((item) => item.FunctionCall?.method_name === 'near_withdraw') &&
    tx.receipts_outcome.some((outcome) => outcome.id === receipt.receipt_id &&
      typeof outcome.outcome?.status === 'object' && outcome.outcome.status !== null && 'Failure' in outcome.outcome.status));
  return failed ? 'failed' : 'pending';
}
