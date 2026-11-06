import { KeyType, PublicKey, actions, createTransaction } from 'near-api-js';
import { describe, expect, it } from 'vitest';
import { publicKeyFromImplicitAccount } from '../near/privySigner';
import { checkFeedTx, fromBase64, MAX_FEED_GAS, PORTION_YOCTO, sha256Hex, toBase64, type Expected } from './feedTx';
import fixture from './feedTx.fixture.json';

const ACCOUNT = 'a1'.repeat(32);
const CONTRACT = 'nearling-dev.testnet';
const BLOCK = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const WANT: Expected = { account: ACCOUNT, tokenId: '9', portion: '0.01', contractId: CONTRACT };

// What the Worker's own code path gives (server/src/feeding/portion.ts › buildPortion: createTransaction + encode, base64) for
// this account, contract, token and portion, nonce 7, 5 Tgas — recorded once from the same near-api-js 7.4.0, so a change in
// either copy of the library's encoding fails here.
const SERVER_BUILT = fixture.tx;

interface Variant {
  signer?: string;
  key?: PublicKey;
  receiver?: string;
  acts?: ReturnType<typeof actions.functionCall>[];
  method?: string;
  args?: Record<string, unknown>;
  deposit?: bigint;
  gas?: bigint;
}

/** A transaction as the Worker would build it, with one thing different. */
function build(v: Variant = {}): string {
  const key = v.key ?? publicKeyFromImplicitAccount(ACCOUNT);
  const call = actions.functionCall(v.method ?? 'pet_feed', v.args ?? { token_id: '9' }, v.gas ?? 5_000_000_000_000n, v.deposit ?? PORTION_YOCTO['0.01']);
  const tx = createTransaction(v.signer ?? ACCOUNT, key, v.receiver ?? CONTRACT, 7n, v.acts ?? [call], BLOCK);
  return toBase64(tx.encode());
}

describe('the check before signing', () => {
  // spec: add-feeding › Feed by link flow › friend opens feeding from a shared errand
  it('accepts one linked pet_feed and refuses its unlinked form or unrelated args', () => {
    const job_hash = 'b'.repeat(64);
    const linked = build({ args: { token_id: '9', job_hash } });
    expect(checkFeedTx(linked, { ...WANT, linked: true, jobHash: job_hash }).ok).toBe(true);
    expect(checkFeedTx(linked, { ...WANT, linked: true, jobHash: 'c'.repeat(64) })).toEqual({ ok: false, why: 'args' });
    expect(checkFeedTx(linked, WANT)).toEqual({ ok: false, why: 'args' });
    expect(checkFeedTx(build(), { ...WANT, linked: true })).toEqual({ ok: false, why: 'args' });
    expect(checkFeedTx(build({ args: { token_id: '9', job_hash, receiver: 'thief' } }), { ...WANT, linked: true })).toEqual({ ok: false, why: 'args' });
  });
  // spec: add-feeding › Feeding transaction data › прислана не та порция
  it('accepts the bytes the Worker builds, and the transaction made the same way', () => {
    const served = checkFeedTx(SERVER_BUILT, WANT);
    expect(served.ok).toBe(true);
    expect(toBase64((served as { bytes: Uint8Array }).bytes)).toBe(SERVER_BUILT);
    expect(build()).toBe(SERVER_BUILT);
  });

  // spec: add-feeding › Feeding transaction data › прислана не та порция
  it.each<[string, () => string, string]>([
    ['another method', () => build({ method: 'pet_snack' }), 'method'],
    ['another receiver', () => build({ receiver: 'thief.testnet' }), 'receiver'],
    ['another signer', () => build({ signer: 'b2'.repeat(32) }), 'signer'],
    ['another key', () => build({ key: new PublicKey({ keyType: KeyType.ED25519, data: new Uint8Array(32).fill(3) }) }), 'key'],
    ['another token', () => build({ args: { token_id: '10' } }), 'args'],
    ['an argument besides the token', () => build({ args: { token_id: '9', to: 'thief.testnet' } }), 'args'],
    ['a deposit of another portion', () => build({ deposit: PORTION_YOCTO['0.05'] }), 'deposit'],
    ['a deposit not on the list', () => build({ deposit: PORTION_YOCTO['0.01'] + 1n }), 'deposit'],
    ['a larger deposit', () => build({ deposit: 10n ** 24n }), 'deposit'],
    ['an oversized gas', () => build({ gas: MAX_FEED_GAS + 1n }), 'gas'],
    ['a second action', () => build({ acts: [actions.functionCall('pet_feed', { token_id: '9' }, 5_000_000_000_000n, PORTION_YOCTO['0.01']), actions.transfer(1n)] }), 'actions'],
    ['a transfer only', () => build({ acts: [actions.transfer(PORTION_YOCTO['0.01'])] }), 'actions'],
    ['no action', () => build({ acts: [] }), 'actions'],
  ])('refuses %s: nothing to sign', (_name, make, why) => {
    expect(checkFeedTx(make(), WANT)).toEqual({ ok: false, why });
  });

  // spec: add-feeding › Feeding transaction data › прислана не та порция
  it('accepts the gas at the limit and refuses the portion the player did not tap', () => {
    expect(checkFeedTx(build({ gas: MAX_FEED_GAS }), WANT).ok).toBe(true);
    expect(checkFeedTx(SERVER_BUILT, { ...WANT, portion: '0.2' })).toEqual({ ok: false, why: 'deposit' });
    expect(checkFeedTx(SERVER_BUILT, { ...WANT, tokenId: '2' })).toEqual({ ok: false, why: 'args' });
    expect(checkFeedTx(SERVER_BUILT, { ...WANT, account: 'b2'.repeat(32) })).toEqual({ ok: false, why: 'signer' });
  });

  // spec: add-feeding › Feeding transaction data › прислана не та порция
  it('refuses trailing bytes, garbage and nothing', () => {
    const bytes = fromBase64(SERVER_BUILT)!;
    expect(checkFeedTx(toBase64(Uint8Array.from([...bytes, 0])), WANT)).toEqual({ ok: false, why: 'trailing' });
    expect(checkFeedTx(toBase64(bytes.slice(0, 20)), WANT).ok).toBe(false);
    expect(checkFeedTx('not base64 !!', WANT)).toEqual({ ok: false, why: 'bytes' });
    expect(checkFeedTx('', WANT)).toEqual({ ok: false, why: 'bytes' });
  });

  it('hashes the bytes the way the network does: sha256, hex, no 0x', async () => {
    expect(await sha256Hex(new TextEncoder().encode('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
