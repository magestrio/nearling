import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { accountBalance, hatchView, petView, txStatus } from '../src/chain';
import { harness } from './helpers/api';
import { NEAR_ACCOUNT } from './helpers/network';

const h = harness();
const serverKey = () => env.SERVER_KEY.get(env.SERVER_KEY.idFromName('server'));
const mint = (receiver: string) => ({ methodName: 'pet_mint', args: { receiver, name: 'Pixel', character: 'c' }, gas: '5000000000000' });

describe('the Worker\'s reads of the contract', () => {
  // spec: add-pet › Hatch view contract › аккаунт рождал питомца
  it('reads the pet, the hatch state and the balance as the contract returns them', async () => {
    const chain = h.net().contract;
    chain.addPet('5', NEAR_ACCOUNT(1), { name: 'Biscuit' });
    chain.hatchedBy.set(NEAR_ACCOUNT(1), '5');
    expect((await petView(env, '5'))?.name).toBe('Biscuit');
    expect(await petView(env, '6')).toBeNull();
    expect(await hatchView(env, NEAR_ACCOUNT(1))).toMatchObject({ token_id: '5', born_today: 0 });
    expect(await hatchView(env, NEAR_ACCOUNT(2))).toMatchObject({ token_id: null });
    chain.serverBalance = 123456789n;
    expect(await accountBalance(env, env.SERVER_ACCOUNT_ID)).toBe('123456789');
  });
});

describe('the queue of the server key', () => {
  // spec: add-pet › Birth flow › не вылупился
  it('signs transactions sent at once one after the other, each with its own nonce', async () => {
    const chain = h.net().contract;
    const answers = await Promise.all([1, 2, 3].map((n) => serverKey().send(mint(NEAR_ACCOUNT(n)))));
    expect(answers.map((a) => a.status)).toEqual(['ok', 'ok', 'ok']);
    // The key's nonce counter lives as long as the queue does: consecutive, never the same twice.
    const [a, b, c] = chain.sends.map((s) => s.nonce) as [number, number, number];
    expect([b - a, c - b]).toEqual([1, 1]);
    expect(answers.map((a) => (a.status === 'ok' ? a.value : null))).toEqual(['0', '1', '2']);
  });

  // spec: add-pet › Birth flow › не вылупился
  it('answers "unknown" with the hash when the answer is lost, and the hash tells what the network did', async () => {
    const chain = h.net().contract;
    chain.mode = 'executed-but-silent';
    const answer = await serverKey().send(mint(NEAR_ACCOUNT(1)));
    expect(answer.status).toBe('unknown');
    if (answer.status !== 'unknown') return;
    chain.mode = 'normal';
    expect(await txStatus(env, answer.txHash, env.SERVER_ACCOUNT_ID)).toMatchObject({ status: 'ok', value: '0', blockHash: expect.any(String) });
    // a transaction the network never saw
    expect(await txStatus(env, 'Eo9RLnSNy6JCFHEuaYXSHz4aUqLZjQgJA85oYf3nboFT', env.SERVER_ACCOUNT_ID)).toBeNull();
  });

  // spec: add-pet › Birth flow › не вылупился
  it('reports a refusal of the contract with its code', async () => {
    const chain = h.net().contract;
    await serverKey().send(mint(NEAR_ACCOUNT(1)));
    const second = await serverKey().send(mint(NEAR_ACCOUNT(1)));
    expect(second).toMatchObject({ status: 'failed', code: 'already_hatched' });
    expect(chain.pets.size).toBe(1);
  });

  // spec: add-pet › Birth flow › не вылупился
  it('answers "unreachable" when the network cannot be read to sign', async () => {
    h.net().contract.down = true;
    expect(await serverKey().send(mint(NEAR_ACCOUNT(1)))).toEqual({ status: 'unreachable' });
  });
});
