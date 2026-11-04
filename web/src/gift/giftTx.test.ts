import { KeyType, PublicKey, actions, createTransaction } from 'near-api-js';
import { expect, it } from 'vitest';
import { toBase64 } from '../feeding/feedTx';
import { publicKeyFromImplicitAccount } from '../near/privySigner';
import { checkGiftTx } from './giftTx';

const ACCOUNT = 'a1'.repeat(32);
const CONTRACT = 'nearling-dev.testnet';
const RECEIVER = 'b2'.repeat(32);
const want = { account: ACCOUNT, tokenId: '9', receiver: RECEIVER, contractId: CONTRACT };
const block = new Uint8Array(32).fill(1);
const args = { receiver_id: RECEIVER, token_id: '9', approval_id: null, memo: null };
function tx(change: { signer?: string; key?: PublicKey; contract?: string; method?: string; args?: Record<string, unknown>; deposit?: bigint; gas?: bigint; actions?: ReturnType<typeof actions.functionCall>[] } = {}) {
  return toBase64(createTransaction(change.signer ?? ACCOUNT, change.key ?? publicKeyFromImplicitAccount(ACCOUNT), change.contract ?? CONTRACT, 7n,
    change.actions ?? [actions.functionCall(change.method ?? 'nft_transfer', change.args ?? args, change.gas ?? 5n * 10n ** 12n, change.deposit ?? 1n)], block).encode());
}

// spec: add-gift › Gift transaction data › прислана не та передача
it('signs only the single exact transfer to the accepted receiver', () => {
  expect(checkGiftTx(tx(), want).ok).toBe(true);
  for (const [bad, why] of [
    [{ contract: 'other.testnet' }, 'receiver'],
    [{ method: 'pet_feed' }, 'method'],
    [{ args: { ...args, receiver_id: 'c3'.repeat(32) } }, 'args'],
    [{ args: { ...args, token_id: '10' } }, 'args'],
    [{ args: { ...args, memo: 'hello' } }, 'args'],
    [{ args: { ...args, approval_id: 1 } }, 'args'],
    [{ signer: 'c3'.repeat(32) }, 'signer'],
    [{ key: new PublicKey({ keyType: KeyType.ED25519, data: new Uint8Array(32).fill(3) }) }, 'key'],
    [{ deposit: 0n }, 'deposit'],
    [{ deposit: 2n }, 'deposit'],
    [{ gas: 6n * 10n ** 12n }, 'gas'],
    [{ actions: [actions.functionCall('nft_transfer', args, 5n * 10n ** 12n, 1n), actions.transfer(1n)] }, 'actions'],
  ] as Array<[Parameters<typeof tx>[0], string]>) expect(checkGiftTx(tx(bad), want)).toEqual({ ok: false, why });
});
