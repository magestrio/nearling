import { describe, expect, it } from 'vitest';
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { checkCall, parseEvent, recoverSigner, sha256Hex, signedText, type ChainCall } from './check';

const enc = new TextEncoder();
const privateKey = new Uint8Array(32).fill(1);
const pub = secp256k1.getPublicKey(privateKey, false);
const signer = `0x${Array.from(keccak_256(pub.slice(1)).slice(-20), (b) => b.toString(16).padStart(2, '0')).join('')}`;
const request = enc.encode('{"model":"Qwen/Qwen3.8-27B","messages":[]}');
const reply = enc.encode('{"choices":[{"finish_reason":"stop","message":{"content":"Hi"}}],"usage":{"prompt_tokens":12,"completion_tokens":4,"completion_tokens_details":{"reasoning_tokens":0}}}');
const model = 'Qwen/Qwen3.8-27B';

function signatureFor(text: string): string {
  const msg = enc.encode(text);
  const prefix = enc.encode(`\x19Ethereum Signed Message:\n${msg.length}`);
  const combined = new Uint8Array(prefix.length + msg.length);
  combined.set(prefix); combined.set(msg, prefix.length);
  const signature = secp256k1.sign(keccak_256(combined), privateKey);
  const raw = new Uint8Array([...signature.toCompactRawBytes(), 27 + signature.recovery!]);
  return `0x${Array.from(raw, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

async function call(kind: ChainCall['sig_kind'] = 'provider_tee'): Promise<ChainCall> {
  const item: ChainCall = { req_sha256: await sha256Hex(request), res_sha256: await sha256Hex(reply),
    signature: '', sig_kind: kind, signer, tokens_in: 12, tokens_out: 4, tokens_reasoning: 0, cut: false };
  item.signature = signatureFor(signedText(item, model));
  return item;
}

describe('exact-byte receipt check', () => {
  // spec: add-verification › Verification flow › проверка сошлась
  // spec: add-verification › Receipt link flow › independent check
  it('checks raw hashes, a recovered EIP-191 signer, signed usage and finish reason', async () => {
    const item = await call();
    expect(recoverSigner(signedText(item, model), item.signature)).toBe(signer);
    expect(await checkCall(item, model, request, reply)).toEqual({ request: 'match', reply: 'match', signature: 'match', tokens: 'match' });
  });

  // spec: add-verification › Verification flow › не сошлось
  it('marks only the changed byte or signer as mismatched', async () => {
    const item = await call();
    expect((await checkCall(item, model, enc.encode('{}'), reply)).request).toBe('mismatch');
    expect((await checkCall(item, model, request, enc.encode('{}'))).reply).toBe('mismatch');
    expect((await checkCall(item, model, request, enc.encode('{}'))).tokens).toBe('unavailable');
    expect((await checkCall({ ...item, signer: '0x' + '0'.repeat(40) }, model, request, reply)).signature).toBe('mismatch');
    expect((await checkCall({ ...item, signature: '0x' + '0'.repeat(130) }, model, request, reply)).signature).toBe('mismatch');
  });

  // spec: add-verification › Verification flow › токены не сошлись
  it('compares each token count and the cut flag against the signed reply', async () => {
    const item = await call();
    expect((await checkCall({ ...item, tokens_in: 13 }, model, request, reply)).tokens).toBe('mismatch');
    expect((await checkCall({ ...item, tokens_out: 5 }, model, request, reply)).tokens).toBe('mismatch');
    expect((await checkCall({ ...item, cut: true }, model, request, reply)).tokens).toBe('mismatch');
  });

  // spec: add-verification › Verification flow › поток
  it('accepts gateway signed text only with the gateway kind', async () => {
    const item = await call('gateway');
    expect((await checkCall(item, model, request, reply)).signature).toBe('match');
    expect((await checkCall({ ...item, sig_kind: 'provider_tee' }, model, request, reply)).signature).toBe('mismatch');
  });

  // spec: add-verification › Verification flow › errand report with a cut search
  it('does not grant signature or token marks to a stopped search', async () => {
    const item = await call();
    const result = await checkCall({ ...item, signature: '', cut: true }, model, request, reply, true);
    expect(result.signature).toBe('unavailable');
    expect(result.tokens).toBe('unavailable');
  });

  // spec: add-verification › Verification flow › skilled answer
  // spec: add-verification › Verification flow › errand report with a skill
  it('checks a private-skill reply without claiming a request match', async () => {
    const item = await call();
    expect(await checkCall(item, model, null, reply)).toEqual({
      request: 'unavailable', reply: 'match', signature: 'match', tokens: 'match',
    });
  });

  // spec: add-verification › Verification flow › проверка сошлась
  it('parses only exact NEP-297 receipt and hire event shapes', async () => {
    const item = await call();
    // near-sdk #[near(event_json)] emits `data` as an object (contract/src/events.rs).
    const event = (data: unknown, name = 'receipt') => `EVENT_JSON:${JSON.stringify({ standard: 'nearling', version: '1.0.0', event: name, data })}`;
    const receipt = { token_id: '9', debit_id: 8, model, price: '280000000000000000000', calls: [item] };
    expect(parseEvent(event(receipt))).toMatchObject({ event: 'receipt', data: { token_id: '9', calls: [item] } });
    expect(parseEvent(event({ ...receipt, calls: [{ ...item, req_sha256: 'bad' }] }))).toBeNull();
    expect(parseEvent(event(receipt).replace('nearling', 'other'))).toBeNull();
    expect(parseEvent(event({ debit_id: 8, hirer: '9', worker: '5', fee: '1', answer_cost: '1', skill: false }, 'hire'))).toMatchObject({ event: 'hire' });
  });
});
