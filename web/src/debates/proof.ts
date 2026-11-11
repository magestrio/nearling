import { config } from '../config';
import { nearRpc } from '../seams/rpc';
import type { DebateLineBytes } from '../seams/worker-types';
import { checkCall, type CallCheck, type ChainCall } from '../verification/check';
import { outcomeFor } from '../verification/checkMachine';

type Json = Record<string, unknown>;
const object = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const bytes = (base64: string) => Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0));

export type DebateProof = { kind: 'checked' | 'mismatch'; call: CallCheck; signatureKind: ChainCall['sig_kind']; signer: string }
  | { kind: 'unavailable' | 'too-old' };

const mismatch = (): DebateProof => ({ kind: 'mismatch',
  call: { request: 'mismatch', reply: 'mismatch', signature: 'unavailable', tokens: 'unavailable' },
  signatureKind: 'gateway', signer: '' });

/** Independently matches the exact public bytes, signed call, debate context and chain transaction. */
export async function verifyDebateLine(line: DebateLineBytes, speakerPet: string): Promise<DebateProof> {
  const found = await outcomeFor(nearRpc, line.receipt_tx_hash, config.serverAccountId, Date.now());
  if (found.kind !== 'found') return { kind: found.kind };
  const outcome = found.outcome;
  if (!object(outcome) || !object(outcome.status) || !('SuccessValue' in outcome.status) || !object(outcome.transaction))
    return mismatch();
  const tx = outcome.transaction;
  if (tx.signer_id !== config.serverAccountId || tx.receiver_id !== config.contractId || !Array.isArray(tx.actions)
    || tx.actions.length !== 1 || !object(tx.actions[0]) || !object(tx.actions[0].FunctionCall))
    return mismatch();
  const action = tx.actions[0].FunctionCall;
  if (action.method_name !== 'debit_session' || typeof action.args !== 'string') return mismatch();
  let args: unknown;
  try { args = JSON.parse(atob(action.args)); } catch { return mismatch(); }
  if (!object(args) || args.token_id !== speakerPet || !Array.isArray(args.thoughts) || args.thoughts.length !== 1
    || !object(args.thoughts[0]) || !object(args.thoughts[0].debate) || args.thoughts[0].debate.id !== line.id
    || args.thoughts[0].debate.line_order !== line.order) return mismatch();
  let signed: Json;
  try { signed = JSON.parse(line.signed_call) as Json; } catch { return mismatch(); }
  if (!object(signed) || typeof signed.model !== 'string') return mismatch();
  const outcomes = Array.isArray(outcome.receipts_outcome) ? outcome.receipts_outcome : [];
  const receipts: Json[] = outcomes.flatMap((r: unknown) => object(r) && object(r.outcome) && Array.isArray(r.outcome.logs)
    ? r.outcome.logs : []).flatMap((log: unknown) => {
      if (typeof log !== 'string' || !log.startsWith('EVENT_JSON:')) return [];
      try {
        const event: unknown = JSON.parse(log.slice(11));
        return object(event) && event.standard === 'nearling' && event.version === '1.0.0' && event.event === 'receipt'
          ? Array.isArray(event.data) ? event.data.filter(object) : object(event.data) ? [event.data] : [] : [];
      } catch { return []; }
    });
  const matching = receipts.filter((receipt) => receipt.token_id === speakerPet && receipt.debate_id === line.id
    && receipt.line_order === line.order && receipt.price === line.price_yocto && receipt.model === signed.model
    && Array.isArray(receipt.calls) && receipt.calls.length === 1);
  if (matching.length !== 1) return mismatch();
  const call = (matching[0]!.calls as ChainCall[])[0]!;
  const signedMatches = Object.entries(signed).every(([field, value]) => field === 'model' ? value === matching[0]!.model
    : (call as unknown as Json)[field] === value);
  const marks = await checkCall(call, signed.model, bytes(line.request_bytes), bytes(line.response_bytes));
  return { kind: signedMatches && Object.values(marks).every((mark) => mark === 'match') ? 'checked' : 'mismatch',
    call: marks, signatureKind: call.sig_kind, signer: call.signer };
}
