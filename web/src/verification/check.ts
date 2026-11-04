import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';

export interface ChainCall {
  req_sha256: string; res_sha256: string; signature: string;
  sig_kind: 'provider_tee' | 'gateway'; signer: string;
  tokens_in: number; tokens_out: number; tokens_reasoning: number; cut: boolean;
}

export interface ChainReceipt {
  token_id: string; debit_id: number; model: string; price: string;
  worker: string | null; calls: ChainCall[];
}

export interface ChainHire {
  debit_id: number; hirer: string; worker: string; fee: string;
  answer_cost: string; skill: boolean;
}

type Json = Record<string, unknown>;
const hex64 = /^[0-9a-f]{64}$/i;
const yocto = /^(0|[1-9][0-9]*)$/;
const obj = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

export type ChainEvent = { event: 'receipt'; data: ChainReceipt } | { event: 'hire'; data: ChainHire };
export function parseEvent(log: string): ChainEvent | null {
  if (!log.startsWith('EVENT_JSON:')) return null;
  let raw: unknown;
  try { raw = JSON.parse(log.slice('EVENT_JSON:'.length)); } catch { return null; }
  if (!obj(raw) || raw.standard !== 'nearling' || raw.version !== '1.0.0' || !obj(raw.data)) return null;
  const d = raw.data;
  if (raw.event === 'receipt') {
    if (typeof d.token_id !== 'string' || !count(d.debit_id) || typeof d.model !== 'string'
      || typeof d.price !== 'string' || !yocto.test(d.price) || !Array.isArray(d.calls)
      || d.calls.length < 1 || d.calls.length > 4 || (d.worker !== undefined && typeof d.worker !== 'string')) return null;
    const calls: ChainCall[] = [];
    for (const call of d.calls) {
      if (!obj(call) || typeof call.req_sha256 !== 'string' || !hex64.test(call.req_sha256)
        || typeof call.res_sha256 !== 'string' || !hex64.test(call.res_sha256)
        || typeof call.signature !== 'string' || typeof call.signer !== 'string'
        || (call.sig_kind !== 'provider_tee' && call.sig_kind !== 'gateway')
        || !count(call.tokens_in) || !count(call.tokens_out) || !count(call.tokens_reasoning)
        || typeof call.cut !== 'boolean') return null;
      calls.push(call as unknown as ChainCall);
    }
    return { event: 'receipt', data: { token_id: d.token_id, debit_id: d.debit_id,
      model: d.model, price: d.price, worker: typeof d.worker === 'string' ? d.worker : null, calls } };
  }
  if (raw.event === 'hire' && count(d.debit_id) && typeof d.hirer === 'string'
    && typeof d.worker === 'string' && typeof d.fee === 'string' && yocto.test(d.fee)
    && typeof d.answer_cost === 'string' && yocto.test(d.answer_cost) && typeof d.skill === 'boolean') {
    return { event: 'hire', data: d as unknown as ChainHire };
  }
  return null;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice().buffer));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function signedText(call: Pick<ChainCall, 'req_sha256' | 'res_sha256' | 'sig_kind'>, model: string): string {
  const pair = `${call.req_sha256}:${call.res_sha256}`;
  return call.sig_kind === 'gateway' ? pair : `${model}:${pair}`;
}

/** EIP-191 personal-sign over the exact signature text recorded in the receipt. */
export function recoverSigner(text: string, signature: string): string | null {
  if (!/^0x[0-9a-f]{130}$/i.test(signature)) return null;
  try {
    const bytes = Uint8Array.from(signature.slice(2).match(/../g)!, (part) => Number.parseInt(part, 16));
    const recovery = bytes[64]! >= 27 ? bytes[64]! - 27 : bytes[64]!;
    if (recovery < 0 || recovery > 3) return null;
    const message = new TextEncoder().encode(text);
    const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${message.length}`);
    const signed = new Uint8Array(prefix.length + message.length);
    signed.set(prefix); signed.set(message, prefix.length);
    const digest = keccak_256(signed);
    const key = secp256k1.Signature.fromCompact(bytes.slice(0, 64)).addRecoveryBit(recovery)
      .recoverPublicKey(digest).toRawBytes(false);
    return `0x${Array.from(keccak_256(key.slice(1)).slice(-20), (b) => b.toString(16).padStart(2, '0')).join('')}`;
  } catch { return null; }
}

function usageOf(bytes: Uint8Array): { input: number; output: number; reasoning: number; cut: boolean } | null {
  try {
    const raw: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!obj(raw) || !obj(raw.usage) || !Array.isArray(raw.choices) || !obj(raw.choices[0])) return null;
    const usage = raw.usage;
    const detail = usage.completion_tokens_details;
    const reasoning = obj(detail) ? detail.reasoning_tokens : undefined;
    if (!count(usage.prompt_tokens) || !count(usage.completion_tokens)
      || typeof raw.choices[0].finish_reason !== 'string'
      || (reasoning !== undefined && !count(reasoning))) return null;
    return { input: usage.prompt_tokens, output: usage.completion_tokens,
      reasoning: reasoning ?? 0, cut: raw.choices[0].finish_reason === 'length' } as { input: number; output: number; reasoning: number; cut: boolean };
  } catch { return null; }
}

export interface CallCheck {
  request: 'match' | 'mismatch' | 'unavailable';
  reply: 'match' | 'mismatch' | 'unavailable';
  signature: 'match' | 'mismatch' | 'unavailable';
  tokens: 'match' | 'mismatch' | 'unavailable';
}

/** Missing bytes never make a check mark. A cut errand search has hashes but no signature or token evidence. */
export async function checkCall(call: ChainCall, model: string, request?: Uint8Array | null,
  reply?: Uint8Array | null, stoppedByGame = false): Promise<CallCheck> {
  const requestMark = request === undefined || request === null ? 'unavailable'
    : (await sha256Hex(request)).toLowerCase() === call.req_sha256.toLowerCase() ? 'match' : 'mismatch';
  const replyMark = reply === undefined || reply === null ? 'unavailable'
    : (await sha256Hex(reply)).toLowerCase() === call.res_sha256.toLowerCase() ? 'match' : 'mismatch';
  const recovered = stoppedByGame ? null : recoverSigner(signedText(call, model), call.signature);
  const signatureMark = stoppedByGame ? 'unavailable'
    : recovered?.toLowerCase() === call.signer.toLowerCase() ? 'match' : 'mismatch';
  const usage = reply && replyMark === 'match' && !stoppedByGame ? usageOf(reply) : null;
  const tokenMark = !usage ? 'unavailable' : usage.input === call.tokens_in
    && usage.output === call.tokens_out && usage.reasoning === call.tokens_reasoning
    && usage.cut === call.cut ? 'match' : 'mismatch';
  return { request: requestMark, reply: replyMark, signature: signatureMark, tokens: tokenMark };
}
