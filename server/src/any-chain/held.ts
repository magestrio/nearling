import { baseDecode, PublicKey } from 'near-api-js';
import { ChainUnreachable, rpcProvider } from '../chain';
import { ONE_CLICK, QuoteUnavailable, type OneClickQuote, WNEAR } from './quote';
import { providerStatus, type ProviderStatus } from './status';

const SOURCE_HASH = /^[A-Za-z0-9:_-]{16,128}$/;
const CHAIN = /^[a-z0-9_-]{2,32}$/;
const NEAR_HASH = /^[1-9A-HJ-NP-Za-km-z]{32,60}$/;
const ID = /^[0-9a-f]{32}$/;
const NONCE = /^[0-9a-f]{32}$/;

export interface Attestation {
  heldId: number;
  routeId: string;
  nearTxHash: string;
  sourceTxHash: string;
  amount: string;
  chain: string;
  recipient: string;
  quoteReference: string;
  releaseTxHash?: string;
  recoveryTxHash?: string;
  nonce: string;
  publicKey: string;
  signature: string;
}

export function attestationBytes(value: Attestation): Uint8Array {
  return new TextEncoder().encode(`nearling-held-v1\0${JSON.stringify([
    value.heldId, value.routeId, value.nearTxHash, value.sourceTxHash,
    value.amount, value.chain, value.recipient, value.quoteReference,
    value.releaseTxHash ?? null, value.recoveryTxHash ?? null, value.nonce,
  ])}`);
}

/** Only a current full-access key of the game contract may attest; the server's FC key never qualifies. */
export async function operatorSignature(env: Env, value: Attestation): Promise<boolean> {
  if (!Number.isSafeInteger(value.heldId) || value.heldId < 0 || !ID.test(value.routeId) ||
    !NEAR_HASH.test(value.nearTxHash) || !NONCE.test(value.nonce) ||
    !/^\d{1,39}$/.test(value.amount) || !CHAIN.test(value.chain) ||
    !SOURCE_HASH.test(value.sourceTxHash) ||
    typeof value.recipient !== 'string' || value.recipient.length === 0 || value.recipient.length > 256 ||
    (value.releaseTxHash !== undefined && !NEAR_HASH.test(value.releaseTxHash)) ||
    (value.recoveryTxHash !== undefined && !NEAR_HASH.test(value.recoveryTxHash)) ||
    typeof value.quoteReference !== 'string' || value.quoteReference.length > 100) return false;
  try {
    const keys = await rpcProvider(env).viewAccessKeyList({ accountId: env.CONTRACT_ID });
    if (!keys.keys.some((key) => key.public_key === value.publicKey && key.access_key.permission === 'FullAccess')) return false;
    const key = PublicKey.from(value.publicKey);
    const bytes = attestationBytes(value);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    return key.verify(digest, baseDecode(value.signature));
  } catch { throw new ChainUnreachable(); }
}

export async function associatedSource(env: Env, value: Attestation, depositAddress: string, depositMemo: string | null,
  originAsset: string, originChain: string, quoteRefundTo: string): Promise<boolean> {
  if (value.chain !== originChain || value.recipient !== quoteRefundTo) return false;
  const provider = await providerStatus(depositAddress, depositMemo);
  const details = provider.swapDetails;
  if (provider.quoteResponse?.quoteRequest?.refundTo !== quoteRefundTo ||
    provider.quoteResponse.quoteRequest.originAsset !== originAsset ||
    provider.quoteResponse.quoteRequest.destinationAsset !== WNEAR ||
    provider.quoteResponse.quoteRequest.recipient !== env.CONTRACT_ID ||
    provider.correlationId !== value.quoteReference ||
    !details?.originChainTxHashes?.some((item) => item.hash === value.sourceTxHash) ||
    ![...(details.nearTxHashes ?? []), ...(details.destinationChainTxHashes?.map((item) => item.hash) ?? [])].includes(value.nearTxHash)) return false;
  return true;
}

export function reverseRequest(env: Env, amount: string, originAsset: string, recipient: string, refundTo: string): Record<string, unknown> {
  return { dry: false, depositMode: 'SIMPLE', swapType: 'EXACT_INPUT', slippageTolerance: 100,
    originAsset: WNEAR, depositType: 'ORIGIN_CHAIN', destinationAsset: originAsset, amount,
    refundTo, refundType: 'ORIGIN_CHAIN', recipient, recipientType: 'DESTINATION_CHAIN',
    deadline: new Date(Date.now() + 2 * 60 * 60_000).toISOString() };
}

export async function reverseQuote(request: Record<string, unknown>): Promise<OneClickQuote> {
  let answer: OneClickQuote;
  try {
    const response = await fetch(`${ONE_CLICK}/quote`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request), signal: AbortSignal.timeout(8_000) });
    if (!response.ok) {
      const message = await response.text();
      throw new QuoteUnavailable(response.status === 400
        ? /try at least/i.test(message) ? 'below_return_minimum' : 'no_payable_quote'
        : 'provider_unavailable');
    }
    answer = await response.json() as OneClickQuote;
  } catch (error) {
    if (error instanceof QuoteUnavailable) throw error;
    throw new QuoteUnavailable('provider_unavailable');
  }
  const echo = answer?.quoteRequest;
  const quote = answer?.quote;
  if (!echo || !quote || echo.originAsset !== WNEAR || echo.destinationAsset !== request.destinationAsset ||
    echo.amount !== request.amount || echo.deadline !== request.deadline ||
    echo.refundTo !== request.refundTo || echo.recipient !== request.recipient ||
    echo.depositType !== 'ORIGIN_CHAIN' || echo.refundType !== 'ORIGIN_CHAIN' ||
    echo.recipientType !== 'DESTINATION_CHAIN' || echo.slippageTolerance !== 100 || echo.dry !== false ||
    !/^\d+$/.test(quote.amountOut) || !/^\d+$/.test(quote.minAmountOut) ||
    BigInt(quote.minAmountOut) > BigInt(quote.amountOut) ||
    BigInt(quote.minAmountOut) < BigInt(quote.amountOut) * 99n / 100n ||
    quote.amountIn !== request.amount ||
    !/^\d+$/.test(quote.withdrawFee) || !/^\d+$/.test(quote.refundFee) ||
    !quote.depositAddress || !/^[a-z0-9._-]{2,64}$/.test(quote.depositAddress) ||
    !quote.deadline || Date.parse(quote.deadline) <= Date.now() ||
    !quote.timeWhenInactive || Date.parse(quote.timeWhenInactive) <= Date.now() ||
    typeof answer.signature !== 'string' || !answer.correlationId) throw new ChainUnreachable();
  return answer;
}

export async function reverseStatus(quote: OneClickQuote): Promise<ProviderStatus> {
  if (!quote.quote.depositAddress) throw new ChainUnreachable();
  return providerStatus(quote.quote.depositAddress, quote.quote.depositMemo ?? null);
}

export async function releaseOutcome(env: Env, txHash: string, heldId: number, amount: string): Promise<'released' | 'failed' | 'pending'> {
  let raw: unknown;
  try { raw = await rpcProvider(env).viewTransactionStatus({ txHash, accountId: env.CONTRACT_ID, waitUntil: 'FINAL' }); }
  catch { return 'pending'; }
  const tx = raw as { final_execution_status?: string;
    transaction?: { hash?: string; signer_id?: string; receiver_id?: string; actions?: { FunctionCall?: { method_name?: string; args?: string } }[] };
    receipts_outcome?: { outcome?: { executor_id?: string; logs?: string[] } }[] };
  if (tx.final_execution_status !== 'FINAL') return 'pending';
  if (tx.transaction?.hash !== txHash || tx.transaction.signer_id !== env.CONTRACT_ID ||
    tx.transaction.receiver_id !== env.CONTRACT_ID) return 'pending';
  const call = tx.transaction.actions?.find((item) => item.FunctionCall?.method_name === 'held_refund_release')?.FunctionCall;
  if (!call?.args) return 'pending';
  let args: { delivery_id?: unknown; amount?: unknown; settlement_account?: unknown };
  try { args = JSON.parse(atob(call.args)) as typeof args; } catch { return 'pending'; }
  if (args.delivery_id !== heldId || String(args.amount) !== amount || args.settlement_account !== env.TREASURY_ACCOUNT_ID) return 'pending';
  for (const receipt of tx.receipts_outcome ?? []) {
    if (receipt.outcome?.executor_id !== env.CONTRACT_ID) continue;
    for (const line of receipt.outcome.logs ?? []) {
      if (!line.startsWith('EVENT_JSON:')) continue;
      try {
        const event = JSON.parse(line.slice(11)) as { standard?: string; event?: string; data?: { delivery_id?: number; amount?: string; settlement_account?: string } };
        if (event.standard !== 'nearling' || event.data?.delivery_id !== heldId || event.data.amount !== amount) continue;
        if (event.event === 'cross_chain_held_released' && event.data.settlement_account === env.TREASURY_ACCOUNT_ID) return 'released';
        if (event.event === 'cross_chain_held_release_failed') return 'failed';
      } catch { /* Not this event. */ }
    }
  }
  return 'pending';
}

/** A finalized wrap.near transfer into the project's settlement account, tied to a provider refund hash. */
export async function recoveredWnear(env: Env, txHash: string, minimum: string): Promise<boolean> {
  if (!NEAR_HASH.test(txHash)) return false;
  let raw: unknown;
  try { raw = await rpcProvider(env).viewTransactionStatus({ txHash, accountId: 'intents.near', waitUntil: 'FINAL' }); }
  catch { return false; }
  const tx = raw as { final_execution_status?: string; transaction?: { hash?: string; signer_id?: string };
    receipts?: { receipt_id?: string; predecessor_id?: string; receiver_id?: string;
      receipt?: { Action?: { actions?: { FunctionCall?: { method_name?: string; args?: string } }[] } } }[];
    receipts_outcome?: { id?: string; outcome?: { executor_id?: string; status?: unknown } }[] };
  if (tx.final_execution_status !== 'FINAL' || tx.transaction?.hash !== txHash || tx.transaction.signer_id !== 'intents.near') return false;
  for (const receipt of tx.receipts ?? []) {
    if (receipt.receiver_id !== 'wrap.near' || receipt.predecessor_id !== 'intents.near') continue;
    const call = receipt.receipt?.Action?.actions?.find((item) => item.FunctionCall?.method_name === 'ft_transfer')?.FunctionCall;
    const result = tx.receipts_outcome?.find((item) => item.id === receipt.receipt_id);
    if (!call?.args || result?.outcome?.executor_id !== 'wrap.near' || !('SuccessValue' in (result.outcome.status as object ?? {}))) continue;
    try {
      const args = JSON.parse(atob(call.args)) as { receiver_id?: string; amount?: string };
      if (args.receiver_id === env.TREASURY_ACCOUNT_ID && /^\d+$/.test(args.amount ?? '') && BigInt(args.amount!) >= BigInt(minimum)) return true;
    } catch { /* Not the project transfer. */ }
  }
  return false;
}
