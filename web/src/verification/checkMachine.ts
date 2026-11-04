import type { NearRpc } from '../seams/rpc';
import { checkCall, parseEvent, type CallCheck, type ChainHire, type ChainReceipt } from './check';
import type { ThoughtPointer } from './types';
export type { PointerCall, ThoughtPointer } from './types';

export type CheckState =
  | { kind: 'idle' | 'checking' | 'pending' | 'project-paid' | 'erased' | 'unavailable' | 'too-old'; marks: null }
  | { kind: 'checked' | 'mismatch'; marks: ProofMarks };

export interface ProofMarks {
  receipt: ChainReceipt | null;
  calls: CallCheck[];
  /** Hundredths of a cent, rounded from the chain price at the pointer's stored USD/NEAR rate. */
  centsHundredths: number | null;
  price: 'match' | 'mismatch' | 'unavailable';
  hireFee: 'match' | 'mismatch' | 'unavailable';
  skill: 'match' | 'mismatch' | 'unavailable';
  pointer: 'match' | 'mismatch';
}

/** Names the individual Worker fields that differ from the immutable receipt. */
export function pointerDifferences(pointer: ThoughtPointer, receipt: ChainReceipt): string[] {
  const differences: string[] = [];
  if (pointer.model !== receipt.model) differences.push('Model');
  if (pointer.priceYocto !== receipt.price) differences.push('Price');
  if (pointer.calls.length !== receipt.calls.length) differences.push('Call count');
  receipt.calls.forEach((call, n) => {
    const listed = pointer.calls[n];
    if (!listed) return;
    for (const [field, label] of [
      ['req_sha256', 'request hash'], ['res_sha256', 'reply hash'],
      ['signature', 'signature'], ['sig_kind', 'signature kind'], ['signer', 'signer'],
      ['tokens_in', 'input token count'], ['tokens_out', 'output token count'],
      ['tokens_reasoning', 'thinking token count'], ['cut', 'cut-off'],
    ] as const) {
      if ((field === 'cut' ? Boolean(listed.cut) : listed[field]) !== call[field])
        differences.push(`Call ${n + 1} ${label}`);
    }
  });
  return differences;
}

export function centsAtRate(priceYocto: string, nearUsdRate: string | null): number | null {
  if (!/^(0|[1-9][0-9]*)$/.test(priceYocto) || nearUsdRate === null
    || !/^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/.test(nearUsdRate)) return null;
  const [whole, fraction = ''] = nearUsdRate.split('.');
  const rateMicros = BigInt(whole!) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
  const rounded = (BigInt(priceYocto) * rateMicros * 10_000n + 500_000_000_000_000_000_000_000_000_000n)
    / 1_000_000_000_000_000_000_000_000_000_000n;
  return rounded <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(rounded) : null;
}

type Outcome = { status?: Record<string, unknown>; transaction?: { receiver_id?: string; signer_id?: string;
  actions?: Array<{ FunctionCall?: { method_name?: string; args?: string } }> };
  receipts_outcome?: Array<{ outcome?: { logs?: string[] } }> };

function errorText(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  try { return JSON.stringify(error); } catch { return ''; }
}
function missingHistory(error: unknown): boolean {
  return /UNKNOWN_TRANSACTION|UNKNOWN_TX|unknown transaction|does not exist/i.test(errorText(error));
}
function deniedArchive(error: unknown): boolean {
  return /401|402|403|unauthorized|payment required|forbidden|API.?key|access denied/i.test(errorText(error));
}

/** A regular RPC error is not old history unless the node expressly lacks that transaction. */
export async function outcomeFor(rpc: NearRpc, hash: string, signerId: string, at: number,
  now = Date.now()): Promise<{ kind: 'found'; outcome: unknown } | { kind: 'too-old' | 'unavailable' }> {
  try { return { kind: 'found', outcome: await rpc.transaction(hash, signerId) }; }
  catch (error) {
    if (!missingHistory(error)) return { kind: 'unavailable' };
  }
  try { return { kind: 'found', outcome: await rpc.transaction(hash, signerId, true) }; }
  catch (error) {
    return { kind: deniedArchive(error) && at < now - 24 * 60 * 60 * 1000 ? 'too-old' : 'unavailable' };
  }
}

function bytes(base64: string | null | undefined): Uint8Array | null {
  if (base64 === null || base64 === undefined) return null;
  try { return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0)); } catch { return null; }
}

function selectedReceipt(outcome: unknown, pointer: ThoughtPointer, contractId: string):
  { receipt: ChainReceipt; hire: ChainHire | null } | null {
  if (typeof outcome !== 'object' || outcome === null) return null;
  const tx = outcome as Outcome;
  if (!tx.status || !('SuccessValue' in tx.status) || tx.transaction?.receiver_id !== contractId
    || !Array.isArray(tx.transaction.actions) || tx.transaction.actions.length !== 1) return null;
  const action = tx.transaction.actions[0]?.FunctionCall;
  if (action?.method_name !== 'debit_session' || typeof action.args !== 'string') return null;
  let args: { token_id?: unknown; debit_id?: unknown };
  try { args = JSON.parse(atob(action.args)) as typeof args; } catch { return null; }
  if (args.token_id !== pointer.payingTokenId || !Number.isSafeInteger(args.debit_id)) return null;
  const events = (tx.receipts_outcome ?? []).flatMap((r) => r.outcome?.logs ?? [])
    .map(parseEvent).filter((event): event is NonNullable<typeof event> => event !== null);
  const matching = events.flatMap((event, i) => event.event === 'receipt' && event.data.debit_id === args.debit_id
    && event.data.token_id === pointer.payingTokenId
    && event.data.worker === (pointer.kind === 'hire_question' ? null : pointer.workerTokenId)
    ? [{ receipt: event.data, index: i }] : []);
  if (matching.length !== 1) return null;
  const { receipt, index } = matching[0]!;
  const next = events[index + 1];
  const hire = next?.event === 'hire' ? next.data : null;
  return { receipt, hire };
}

export async function verifyPointer(rpc: NearRpc, pointer: ThoughtPointer, contractId: string,
  signerId: string, now = Date.now()): Promise<CheckState> {
  if (pointer.status !== 'billed' || !pointer.debitTxHash) {
    return { kind: pointer.status === 'billed' ? 'unavailable' : pointer.status === 'project'
      ? 'project-paid' : 'pending', marks: null };
  }
  const result = await outcomeFor(rpc, pointer.debitTxHash, signerId, pointer.at, now);
  if (result.kind !== 'found') return { kind: result.kind, marks: null };
  const selected = selectedReceipt(result.outcome, pointer, contractId);
  if (!selected) return { kind: 'mismatch', marks: { receipt: null,
    calls: [], centsHundredths: null, price: 'unavailable', hireFee: 'unavailable', skill: 'unavailable', pointer: 'mismatch' } };
  const { receipt, hire } = selected;
  const calls = await Promise.all(receipt.calls.map((call, n) => {
    const privateCall = pointer.erased ? null : pointer.privateCalls?.find((entry) => entry.n === n);
    return checkCall(call, receipt.model, bytes(privateCall?.requestBase64), bytes(privateCall?.replyBase64),
      pointer.calls[n]?.label === 'search' && call.cut && !call.signature);
  }));
  const price = receipt.price === pointer.priceYocto ? 'match' : 'mismatch';
  const hireFee = pointer.kind === 'hire_question' || pointer.workerTokenId === null ? (hire ? 'mismatch' : 'unavailable')
    : !pointer.fee && !hire ? 'unavailable'
    : hire && pointer.fee && hire.debit_id === receipt.debit_id && hire.hirer === pointer.payingTokenId
      && hire.worker === pointer.workerTokenId && hire.answer_cost === receipt.price
      && hire.fee === pointer.fee.fee_yocto ? 'match' : 'mismatch';
  const skill = pointer.kind === 'hire_question' || pointer.workerTokenId === null || (!pointer.fee && !hire) ? 'unavailable'
    : hire?.skill === pointer.skilled ? 'match' : 'mismatch';
  const pointerMatch = pointerDifferences(pointer, receipt).length === 0 ? 'match' : 'mismatch';
  const marks: ProofMarks = { receipt, calls, centsHundredths: centsAtRate(receipt.price, pointer.nearUsdRate),
    price, hireFee, skill, pointer: pointerMatch };
  const mismatch = price === 'mismatch' || hireFee === 'mismatch' || skill === 'mismatch'
    || pointerMatch === 'mismatch' || calls.some((call) => Object.values(call).includes('mismatch'));
  return { kind: mismatch ? 'mismatch' : 'checked', marks };
}

/** Ephemeral selected-thought state: every reset invalidates in-flight checks. */
export class CheckMachine {
  private generation = 0;
  state: CheckState = { kind: 'idle', marks: null };
  constructor(private readonly onChange: (state: CheckState) => void) {}
  reset(): void { this.generation += 1; this.publish({ kind: 'idle', marks: null }); }
  async select(work: () => Promise<CheckState>): Promise<void> {
    const generation = ++this.generation;
    this.publish({ kind: 'checking', marks: null });
    try {
      const state = await work();
      if (generation === this.generation) this.publish(state);
    } catch {
      if (generation === this.generation) this.publish({ kind: 'unavailable', marks: null });
    }
  }
  private publish(state: CheckState): void { this.state = state; this.onChange(state); }
}
