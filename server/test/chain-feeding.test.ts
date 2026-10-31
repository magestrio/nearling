// The Worker's reads and sends for feeding (`chain.ts`): a wallet that does not exist, the nonce and
// the block of a transaction the player's key will sign, the send of that signed transaction, and the
// server key's `pet_snack`.
import { env } from 'cloudflare:workers';
import { actions, createTransaction, KeyPairEd25519, KeyPairSigner } from 'near-api-js';
import { describe, expect, it } from 'vitest';
import { accessKeyNonce, accountBalance, ChainUnreachable, gasAccount, recentBlockHash, sendSigned, signAndSendTransfer, txStatus, walletBalance } from '../src/chain';
import { GAS_TOPUP_YOCTO } from '../src/pricing';
import { harness } from './helpers/api';
import { NEAR_ACCOUNT } from './helpers/network';

const h = harness();
const serverKey = () => env.SERVER_KEY.get(env.SERVER_KEY.idFromName('server'));
const NEAR = 10n ** 24n;
const PLAYER = NEAR_ACCOUNT(41);
const MIN_FEED = BigInt(env.MIN_FEED);

/** A transaction the key of `signer` signed, as the browser's Privy would, with the nonce and block the Worker reads. */
async function signedBy(signer: string, receiver: string, action: ReturnType<typeof actions.functionCall> | ReturnType<typeof actions.transfer>) {
  const keys = KeyPairSigner.fromSecretKey(KeyPairEd25519.fromRandom().toString());
  const publicKey = await keys.getPublicKey();
  const nonce = (await accessKeyNonce(env, signer, publicKey)) ?? 0n;
  const tx = createTransaction(signer, publicKey, receiver, nonce + 1n, [action], await recentBlockHash(env));
  return (await keys.signTransaction(tx)).signedTransaction;
}
const feedCall = (tokenId: string, deposit: bigint) => actions.functionCall('pet_feed', { token_id: tokenId }, 5_000_000_000_000n, deposit);

describe('the wallet of a player', () => {
  // spec: add-feeding › Feed sheet screen › без NEAR
  it('is empty when the network has no record of the account, and a balance when it has', async () => {
    const chain = h.net().contract;
    expect(await walletBalance(env, PLAYER)).toBe(0n);
    chain.balances.set(PLAYER, 3n * NEAR);
    expect(await walletBalance(env, PLAYER)).toBe(3n * NEAR);
  });

  // spec: add-feeding › Feed sheet screen › без NEAR
  it('leaves `accountBalance` unreadable for an account that does not exist: it is for the project\'s own accounts', async () => {
    await expect(accountBalance(env, PLAYER)).rejects.toBeInstanceOf(ChainUnreachable);
  });

  // spec: add-feeding › Feeding connection rule › сеть NEAR недоступна
  it('is `ChainUnreachable` when the node is down, never an empty wallet', async () => {
    h.net().contract.down = true;
    await expect(walletBalance(env, PLAYER)).rejects.toBeInstanceOf(ChainUnreachable);
    await expect(accessKeyNonce(env, PLAYER, KeyPairEd25519.fromRandom().getPublicKey())).rejects.toBeInstanceOf(ChainUnreachable);
    await expect(recentBlockHash(env)).rejects.toBeInstanceOf(ChainUnreachable);
  });
});

describe('what a portion is built from', () => {
  // spec: add-feeding › Feeding transaction data › прислана не та порция
  it('reads the nonce of the key (none for a wallet that does not exist) and the hash of a final block', async () => {
    const chain = h.net().contract;
    const key = KeyPairEd25519.fromRandom().getPublicKey();
    expect(await accessKeyNonce(env, PLAYER, key)).toBeNull();
    chain.balances.set(PLAYER, NEAR);
    expect(await accessKeyNonce(env, PLAYER, key)).toBe(100n);
    expect((await recentBlockHash(env)).length).toBe(32);
  });
});

describe('the send of a signed transaction', () => {
  // spec: add-feeding › Feeding outcome rule › отправлено
  it('sends the player\'s own signed meal and answers ok with its hash, the food in the contract and the NEAR gone', async () => {
    const chain = h.net().contract;
    chain.addPet('7', NEAR_ACCOUNT(1));
    chain.balances.set(PLAYER, NEAR);
    const signed = await signedBy(PLAYER, env.CONTRACT_ID, feedCall('7', MIN_FEED));
    const result = await sendSigned(env, signed);
    expect(result).toMatchObject({ status: 'ok', value: 'true' });
    expect(chain.pets.get('7')!.given_food).toBe(MIN_FEED.toString());
    expect(chain.balances.get(PLAYER)).toBe(NEAR - MIN_FEED);
    expect(chain.sends[0]).toMatchObject({ method: 'pet_feed', signer: PLAYER, deposit: MIN_FEED.toString() });
    // the hash is the network's: it finds the transaction
    expect(await txStatus(env, result.txHash, PLAYER)).toMatchObject({ status: 'ok' });
  });

  // spec: add-feeding › Feeding outcome rule › не прошло
  it('reports a panic of the contract with its code, and the deposit stays in the wallet', async () => {
    const chain = h.net().contract;
    chain.addPet('7', NEAR_ACCOUNT(1));
    chain.balances.set(PLAYER, NEAR);
    expect(await sendSigned(env, await signedBy(PLAYER, env.CONTRACT_ID, feedCall('7', MIN_FEED - 1n)))).toMatchObject({ status: 'failed', code: 'feed_too_small' });
    expect(await sendSigned(env, await signedBy(PLAYER, env.CONTRACT_ID, feedCall('404', MIN_FEED)))).toMatchObject({ status: 'failed', code: 'no_pet' });
    expect(chain.balances.get(PLAYER)).toBe(NEAR);
    expect(chain.pets.get('7')!.given_food).toBe('0');
  });

  // spec: add-feeding › Feeding outcome rule › не прошло
  it('is a definite `failed` when the node refuses the transaction: a wallet that cannot pay, a stale nonce', async () => {
    const chain = h.net().contract;
    chain.addPet('7', NEAR_ACCOUNT(1));
    chain.balances.set(PLAYER, 1n);
    const signed = await signedBy(PLAYER, env.CONTRACT_ID, feedCall('7', MIN_FEED));
    // the wallet is short of the deposit: nothing was included
    expect(await sendSigned(env, signed)).toMatchObject({ status: 'failed', code: 'not_enough_balance' });
    expect(chain.sends).toEqual([]);
    chain.balances.set(PLAYER, NEAR);
    chain.mode = 'not-enough-balance';
    expect(await sendSigned(env, signed)).toMatchObject({ status: 'failed', code: 'not_enough_balance' });
    // another transaction took the nonce, and these bytes never landed
    chain.mode = 'invalid-nonce';
    expect(await sendSigned(env, signed)).toMatchObject({ status: 'failed', code: 'invalid_nonce' });
    expect(chain.sends).toEqual([]);
  });

  // spec: add-feeding › Feeding outcome rule › исход неизвестен
  it('answers what happened when the same bytes are sent again after they landed: the node says InvalidNonce, the hash says ok', async () => {
    const chain = h.net().contract;
    chain.addPet('7', NEAR_ACCOUNT(1));
    chain.balances.set(PLAYER, NEAR);
    const signed = await signedBy(PLAYER, env.CONTRACT_ID, feedCall('7', MIN_FEED));
    const first = await sendSigned(env, signed);
    expect(first.status).toBe('ok');
    chain.mode = 'invalid-nonce';
    expect(await sendSigned(env, signed)).toEqual(first);
    expect(chain.pets.get('7')!.given_food).toBe(MIN_FEED.toString()); // fed once
  });

  // spec: add-feeding › Feeding outcome rule › исход неизвестен
  it('is `unknown` when the answer is lost or never comes, and the hash tells later what the network did', async () => {
    const chain = h.net().contract;
    chain.addPet('7', NEAR_ACCOUNT(1));
    chain.balances.set(PLAYER, NEAR);
    const signed = await signedBy(PLAYER, env.CONTRACT_ID, feedCall('7', MIN_FEED));
    chain.mode = 'executed-but-silent';
    const silent = await sendSigned(env, signed);
    expect(silent.status).toBe('unknown');
    chain.mode = 'normal';
    expect(await txStatus(env, silent.txHash, PLAYER)).toMatchObject({ status: 'ok' });
    // a transaction the network never took
    const other = await signedBy(PLAYER, env.CONTRACT_ID, feedCall('7', MIN_FEED + 1n));
    chain.mode = 'lost';
    const lost = await sendSigned(env, other);
    expect(lost.status).toBe('unknown');
    chain.mode = 'normal';
    expect(await txStatus(env, lost.txHash, PLAYER)).toBeNull();
  });

  // spec: add-feeding › Feeding outcome rule › не прошло
  it('is the same for a transaction of a project key: a typed refusal is `failed` with its code, silence stays `unknown`', async () => {
    const chain = h.net().contract;
    const keys = gasAccount(env);
    chain.mode = 'not-enough-balance';
    expect(await signAndSendTransfer(keys, PLAYER, 1n)).toMatchObject({ status: 'failed', code: 'not_enough_balance' });
    chain.mode = 'lost';
    expect(await signAndSendTransfer(keys, PLAYER, 1n)).toMatchObject({ status: 'unknown' });
    // a stale nonce is signed again with a fresh one, and goes through
    chain.mode = 'nonce-once';
    expect(await signAndSendTransfer(keys, PLAYER, 1n)).toMatchObject({ status: 'ok' });
  });

  // spec: add-feeding › Feeding gas data › запас газа доложен
  it('sends a plain transfer from the gas account to a wallet that did not exist, and creates it', async () => {
    const chain = h.net().contract;
    const gas = env.GAS_ACCOUNT_ID;
    const before = chain.balances.get(gas)!;
    const signed = await signedBy(gas, PLAYER, actions.transfer(GAS_TOPUP_YOCTO));
    expect(await sendSigned(env, signed)).toMatchObject({ status: 'ok' });
    expect(chain.balances.get(PLAYER)).toBe(GAS_TOPUP_YOCTO);
    expect(chain.balances.get(gas)).toBe(before - GAS_TOPUP_YOCTO);
    expect(chain.sends[0]).toMatchObject({ method: 'transfer', signer: gas, deposit: GAS_TOPUP_YOCTO.toString(), args: { receiver: PLAYER } });
  });
});

describe('the server key\'s snack', () => {
  const snack = (token_id: string, feeder: string, kind: string) => ({ methodName: 'pet_snack', args: { token_id, feeder, kind }, gas: '5000000000000' });

  // spec: add-feeding › Pet snack contract › четвёртый перекус от друзей за сутки
  it('reports the codes of the new refusals and whether an acquaintance was written', async () => {
    const chain = h.net().contract;
    chain.addPet('7', NEAR_ACCOUNT(1));
    const first = await serverKey().send(snack('7', PLAYER, 'friend'));
    expect(first).toMatchObject({ status: 'ok', value: 'true' });
    expect(chain.known.has(`7:${PLAYER}`)).toBe(true);
    // the same friend again: no second record, the snack goes through
    expect(await serverKey().send(snack('7', PLAYER, 'friend'))).toMatchObject({ status: 'ok', value: 'false' });
    expect(await serverKey().send(snack('7', NEAR_ACCOUNT(3), 'friend'))).toMatchObject({ status: 'ok' });
    expect(await serverKey().send(snack('7', NEAR_ACCOUNT(4), 'friend'))).toMatchObject({ status: 'failed', code: 'snacks_today' });
    // the owner's kind
    expect(await serverKey().send(snack('7', PLAYER, 'owner'))).toMatchObject({ status: 'failed', code: 'feeder_not_owner' });
    expect(await serverKey().send(snack('7', NEAR_ACCOUNT(1), 'owner'))).toMatchObject({ status: 'ok', value: 'false' });
    expect(await serverKey().send(snack('7', NEAR_ACCOUNT(1), 'owner'))).toMatchObject({ status: 'failed', code: 'snack_too_soon' });
    expect(chain.pets.get('7')!.project_food).toBe((BigInt(env.STARTER_FOOD) + 4n * BigInt(env.SNACK_AMOUNT)).toString());
  });

  // spec: add-feeding › Pet snack contract › пул проекта пуст
  it('reports an empty pool', async () => {
    const chain = h.net().contract;
    chain.addPet('7', NEAR_ACCOUNT(1));
    chain.pool = BigInt(env.SNACK_AMOUNT) - 1n;
    expect(await serverKey().send(snack('7', PLAYER, 'friend'))).toMatchObject({ status: 'failed', code: 'pool_empty' });
  });
});
