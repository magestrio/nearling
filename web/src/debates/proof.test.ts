import { afterEach, expect, it, vi } from 'vitest';
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { nearRpc } from '../seams/rpc';
import { sha256Hex, signedText, type ChainCall } from '../verification/check';
import { verifyDebateLine } from './proof';

vi.mock('../config', () => ({ config: { serverAccountId: 'server.testnet', contractId: 'pets.testnet' } }));
vi.mock('../seams/rpc', () => ({ nearRpc: { transaction: vi.fn() } }));
afterEach(() => vi.mocked(nearRpc.transaction).mockReset());

const enc = new TextEncoder();
const request = enc.encode('{"model":"public","messages":[]}');
const response = enc.encode('{"choices":[{"finish_reason":"stop","message":{"content":"A line"}}],"usage":{"prompt_tokens":12,"completion_tokens":4}}');
const privateKey = new Uint8Array(32).fill(1);
const pub = secp256k1.getPublicKey(privateKey, false);
const signer = `0x${Array.from(keccak_256(pub.slice(1)).slice(-20), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
const base64 = (value: Uint8Array) => btoa(String.fromCharCode(...value));
const event = (data: unknown) => `EVENT_JSON:${JSON.stringify({ standard: 'nearling', version: '1.0.0', event: 'receipt', data })}`;

async function fixture() {
  const call: ChainCall = { req_sha256: await sha256Hex(request), res_sha256: await sha256Hex(response),
    signature: '', sig_kind: 'gateway', signer, tokens_in: 12, tokens_out: 4, tokens_reasoning: 0, cut: false };
  const message = enc.encode(signedText(call, 'public'));
  const prefix = enc.encode(`\x19Ethereum Signed Message:\n${message.length}`);
  const signed = new Uint8Array([...prefix, ...message]);
  const sig = secp256k1.sign(keccak_256(signed), privateKey);
  call.signature = `0x${Array.from(new Uint8Array([...sig.toCompactRawBytes(), 27 + sig.recovery!]),
    (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  const id = 'a'.repeat(64);
  const line = { id, order: 1, request_bytes: base64(request), response_bytes: base64(response),
    signed_call: JSON.stringify({ model: 'public', ...call }), receipt_tx_hash: 'tx', price_yocto: '180000000000000000000' };
  const receipt = { token_id: '9', debate_id: id, line_order: 1, price: line.price_yocto, model: 'public', calls: [call] };
  const outcome = { status: { SuccessValue: '' }, transaction: { signer_id: 'server.testnet', receiver_id: 'pets.testnet',
    actions: [{ FunctionCall: { method_name: 'debit_session', args: btoa(JSON.stringify({ token_id: '9',
      thoughts: [{ debate: { id, line_order: 1 } }] })) } }] },
  receipts_outcome: [{ outcome: { logs: [event(receipt)] } }] };
  return { line, outcome };
}

// spec: add-debates › Debate receipt disclosure data › visitor checks line
it('checks the contract event object, exact bytes, debate order and signature', async () => {
  const { line, outcome } = await fixture();
  vi.mocked(nearRpc.transaction).mockResolvedValue(outcome);
  expect(await verifyDebateLine(line, '9')).toMatchObject({ kind: 'checked', signatureKind: 'gateway',
    call: { request: 'match', reply: 'match', signature: 'match', tokens: 'match' } });
  expect(await verifyDebateLine({ ...line, response_bytes: base64(enc.encode('{}')) }, '9')).toMatchObject({ kind: 'mismatch',
    call: { reply: 'mismatch' } });
  expect(await verifyDebateLine({ ...line, order: 2 }, '9')).toMatchObject({ kind: 'mismatch' });
  expect(await verifyDebateLine({ ...line, price_yocto: '1' }, '9')).toMatchObject({ kind: 'mismatch' });
  expect(await verifyDebateLine({ ...line, id: 'b'.repeat(64) }, '9')).toMatchObject({ kind: 'mismatch' });
});
