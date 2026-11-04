import { describe, expect, it } from 'vitest';
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import type { NearRpc } from '../seams/rpc';
import { CheckMachine, centsAtRate, outcomeFor, pointerDifferences, verifyPointer, type ThoughtPointer } from './checkMachine';
import { THINK_ID, verificationFakes } from '../../e2e/verification.fixtures';

const hash = 'a'.repeat(64);
const privateKey = new Uint8Array(32).fill(2);
const pub = secp256k1.getPublicKey(privateKey, false);
const signer = `0x${Array.from(keccak_256(pub.slice(1)).slice(-20), (b) => b.toString(16).padStart(2, '0')).join('')}`;
const text = `Qwen/Qwen3.8-27B:${hash}:${hash}`;
const message = new TextEncoder().encode(text);
const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${message.length}`);
const signed = new Uint8Array(prefix.length + message.length);
signed.set(prefix); signed.set(message, prefix.length);
const signatureParts = secp256k1.sign(keccak_256(signed), privateKey);
const signature = `0x${Array.from(new Uint8Array([...signatureParts.toCompactRawBytes(), 27 + signatureParts.recovery!]),
  (b) => b.toString(16).padStart(2, '0')).join('')}`;
const item: ThoughtPointer = {
  id: '1'.repeat(24), tokenId: '5', payingTokenId: '5', status: 'billed',
  debitTxHash: 'TransactionHash', at: Date.now() - 3 * 86_400_000,
  model: 'Qwen/Qwen3.8-27B', priceYocto: '280000000000000000000', nearUsdRate: '5',
  workerTokenId: null, skilled: false, adapterUsed: false, erased: false,
  calls: [{ n: 0, req_sha256: hash, res_sha256: hash, signature, sig_kind: 'provider_tee',
    signer, tokens_in: 12, tokens_out: 4, tokens_reasoning: 0, cut: 0 }],
};
const event = (name: string, data: unknown) => `EVENT_JSON:${JSON.stringify({ standard: 'nearling', version: '1.0.0', event: name, data })}`;
const chainCall = { req_sha256: hash, res_sha256: hash, signature, sig_kind: 'provider_tee' as const,
  signer, tokens_in: 12, tokens_out: 4, tokens_reasoning: 0, cut: false };
const receipt = { token_id: '5', debit_id: 7, model: item.model, price: item.priceYocto, calls: [chainCall] };
const tx = { status: { SuccessValue: '' }, transaction: { receiver_id: 'pets.testnet', signer_id: 'server.testnet',
  actions: [{ FunctionCall: { method_name: 'debit_session', args: btoa(JSON.stringify({ token_id: '5', debit_id: 7 })) } }] },
  receipts_outcome: [{ outcome: { logs: [event('receipt', receipt)] } }] };
const rpc = (result: unknown): NearRpc => ({
  viewFunction: async () => { throw new Error('unused'); }, getBalance: async () => 0n,
  transfer: async () => { throw new Error('unused'); }, transaction: async () => result,
});

describe('selected thought check', () => {
  // spec: add-verification › Verification flow › не сошлось
  it('names each changed pointer field against the on-chain receipt', () => {
    const changed = { ...item, model: 'other/model', calls: [{ ...item.calls[0]!, tokens_in: 30,
      tokens_out: 8, tokens_reasoning: 2, cut: 1 }] };
    expect(pointerDifferences(changed, { ...receipt, worker: null })).toEqual([
      'Model', 'Call 1 input token count', 'Call 1 output token count', 'Call 1 thinking token count', 'Call 1 cut-off',
    ]);
  });
  // spec: add-verification › Verification flow › проверка сошлась
  // spec: add-verification › Verification flow › не сошлось
  // spec: add-verification › Verification flow › токены не сошлись
  // spec: add-verification › Verification flow › поток
  // spec: add-verification › Verification flow › два вызова
  // spec: add-verification › Verification flow › память стёрта
  // spec: add-verification › Verification flow › ответ работника
  // spec: add-verification › Verification flow › вопрос найма
  // spec: add-verification › Verification flow › пустой ответ
  it('checks the recorded-shaped ordinary and worker fixtures before rendering marks', async () => {
    for (const [variant, expected] of [
      ['checked', 'checked'], ['request-mismatch', 'mismatch'], ['mismatch', 'mismatch'],
      ['signature-mismatch', 'mismatch'], ['price-mismatch', 'mismatch'],
      ['fee-mismatch', 'mismatch'], ['skill-mismatch', 'mismatch'], ['tokens-mismatch', 'mismatch'],
      ['stream', 'checked'], ['two-calls', 'checked'], ['memory-cleared', 'checked'],
      ['worker', 'checked'], ['hire-question', 'checked'], ['empty-reply', 'checked'],
    ] as const) {
      const fakes = verificationFakes({ variant });
      const thought = fakes.worker!.verificationThoughts![THINK_ID] as ThoughtPointer;
      const outcome = fakes.rpc!.outcomes![thought.debitTxHash!]!;
      const result = await verifyPointer(rpc(outcome), thought, 'nearling-e2e.testnet', 'server.testnet');
      expect(result.kind, variant).toBe(expected);
      if (variant === 'checked') expect(result.marks?.calls[0]).toEqual({
        request: 'match', reply: 'match', signature: 'match', tokens: 'match',
      });
      if (variant === 'mismatch') expect(result.marks?.calls[0]?.reply).toBe('mismatch');
      if (variant === 'request-mismatch') expect(result.marks?.calls[0]?.request).toBe('mismatch');
      if (variant === 'signature-mismatch') expect(result.marks?.calls[0]?.signature).toBe('mismatch');
      if (variant === 'price-mismatch') expect(result.marks?.price).toBe('mismatch');
      if (variant === 'fee-mismatch') expect(result.marks?.hireFee).toBe('mismatch');
      if (variant === 'skill-mismatch') expect(result.marks?.skill).toBe('mismatch');
      if (variant === 'tokens-mismatch') expect(result.marks?.calls[0]?.tokens).toBe('mismatch');
      if (variant === 'memory-cleared') expect(result.marks?.calls[0]?.request).toBe('unavailable');
      if (variant === 'two-calls') expect(result.marks?.calls.map((call) => call.tokens)).toEqual(['match', 'match']);
      if (variant === 'worker') expect(result.marks?.hireFee).toBe('match');
    }
  });
  // spec: add-verification › Verification flow › проверка сошлась
  it('requires an executed pet-contract debit and selects one receipt', async () => {
    expect((await verifyPointer(rpc(tx), item, 'pets.testnet', 'server.testnet')).kind).toBe('checked');
    const failed = await verifyPointer(rpc({ ...tx, status: { Failure: {} } }), item, 'pets.testnet', 'server.testnet');
    expect(failed.kind).toBe('mismatch');
    expect(failed.marks?.price).toBe('unavailable');
    expect((await verifyPointer(rpc({ ...tx, transaction: { ...tx.transaction, receiver_id: 'other.testnet' } }), item, 'pets.testnet', 'server.testnet')).kind).toBe('mismatch');
    expect((await verifyPointer(rpc({ ...tx, receipts_outcome: [{ outcome: { logs: [event('receipt', receipt), event('receipt', receipt)] } }] }), item, 'pets.testnet', 'server.testnet')).kind).toBe('mismatch');
  });

  // spec: add-verification › Verification flow › не сошлось
  it('selects the unique chain receipt before comparing changed hashes and call count', async () => {
    const changed = { ...item, calls: [{ ...item.calls[0]!, req_sha256: 'b'.repeat(64),
      res_sha256: 'c'.repeat(64) }, { ...item.calls[0]!, n: 1 }] };
    const result = await verifyPointer(rpc(tx), changed, 'pets.testnet', 'server.testnet');
    expect(result.kind).toBe('mismatch');
    expect(result.marks?.receipt?.model).toBe(item.model);
    expect(result.marks?.receipt?.calls).toHaveLength(1);
    expect(pointerDifferences(changed, result.marks!.receipt!)).toEqual([
      'Call count', 'Call 1 request hash', 'Call 1 reply hash',
    ]);
  });

  // spec: add-verification › Verification flow › не сошлось
  it('withholds an ambiguous receipt even when pointer hashes would choose one', async () => {
    const other = { ...receipt, calls: [{ ...chainCall, req_sha256: 'b'.repeat(64) }] };
    const outcome = { ...tx, receipts_outcome: [{ outcome: { logs: [event('receipt', receipt), event('receipt', other)] } }] };
    const result = await verifyPointer(rpc(outcome), item, 'pets.testnet', 'server.testnet');
    expect(result.kind).toBe('mismatch');
    expect(result.marks?.receipt).toBeNull();
  });

  // spec: add-verification › Verification flow › не сошлось
  // spec: add-verification › Verification flow › ответ работника
  it('compares on-chain price and the adjacent hire fee and skill', async () => {
    const changed = { ...item, priceYocto: '1' };
    expect((await verifyPointer(rpc(tx), changed, 'pets.testnet', 'server.testnet')).marks?.price).toBe('mismatch');
    const worker = { ...item, tokenId: '8', workerTokenId: '8', skilled: true,
      fee: { fee_yocto: '9', fee_usd_micros: 1 } };
    const answer = { ...receipt, worker: '8' };
    const hire = { debit_id: 7, hirer: '5', worker: '8', fee: '10', answer_cost: item.priceYocto, skill: false };
    const outcome = { ...tx, receipts_outcome: [{ outcome: { logs: [event('receipt', answer), event('hire', hire)] } }] };
    const result = await verifyPointer(rpc(outcome), worker, 'pets.testnet', 'server.testnet');
    expect(result.marks?.hireFee).toBe('mismatch');
    expect(result.marks?.skill).toBe('mismatch');
    const noRecordedFee = await verifyPointer(rpc({ ...tx, receipts_outcome: [{ outcome: { logs: [event('receipt', answer)] } }] }),
      { ...worker, fee: null }, 'pets.testnet', 'server.testnet');
    expect(noRecordedFee.marks?.hireFee).toBe('unavailable');
  });

  // spec: add-verification › Verification flow › открыл чек
  it('prices the on-chain NEAR amount at the pointer rate in hundredths of a cent', () => {
    expect(centsAtRate('280000000000000000000', '5')).toBe(14);
    expect(centsAtRate('280000000000000000000', null)).toBeNull();
    expect(centsAtRate('280000000000000000000', 'bad')).toBeNull();
  });

  // spec: add-verification › Verification flow › чек ещё не в сети
  // spec: add-verification › Verification flow › заплатил проект
  it('keeps pending and project-paid thoughts free of marks', async () => {
    expect(await verifyPointer(rpc(tx), { ...item, status: 'unbilled', debitTxHash: null }, 'pets.testnet', 'server.testnet')).toEqual({ kind: 'pending', marks: null });
    expect(await verifyPointer(rpc(tx), { ...item, status: 'project', debitTxHash: null }, 'pets.testnet', 'server.testnet')).toEqual({ kind: 'project-paid', marks: null });
  });

  // spec: add-verification › Verification screen › чек слишком старый
  // spec: add-verification › Seal of character rule › check unavailable
  it('distinguishes closed old archive from a transient RPC failure', async () => {
    const missing = (archive: boolean): NearRpc => ({ ...rpc(null), transaction: async (_hash, _signer, useArchive) => {
      throw new Error(useArchive ? (archive ? '403 forbidden' : '429 limit') : 'UNKNOWN_TRANSACTION');
    } });
    expect((await outcomeFor(missing(true), 'h', 's', item.at)).kind).toBe('too-old');
    expect((await outcomeFor(missing(false), 'h', 's', item.at)).kind).toBe('unavailable');
    expect((await outcomeFor(missing(true), 'h', 's', Date.now())).kind).toBe('unavailable');
  });

  // spec: add-verification › Verification flow › открыл чек × select another thought
  // spec: add-verification › Verification flow › открыл чек × reload
  it('drops stale results after selection or reset', async () => {
    let finish!: (state: Awaited<ReturnType<typeof verifyPointer>>) => void;
    const seen: string[] = [];
    const machine = new CheckMachine((state) => seen.push(state.kind));
    const first = machine.select(() => new Promise((resolve) => { finish = resolve; }));
    await machine.select(async () => ({ kind: 'pending', marks: null }));
    finish({ kind: 'checked', marks: { receipt: { ...receipt, worker: null }, calls: [], centsHundredths: 14,
      price: 'match', hireFee: 'unavailable', skill: 'unavailable', pointer: 'match' } });
    await first;
    expect(machine.state.kind).toBe('pending');
    machine.reset();
    expect(machine.state).toEqual({ kind: 'idle', marks: null });
    expect(seen).toEqual(['checking', 'checking', 'pending', 'idle']);
  });
});
