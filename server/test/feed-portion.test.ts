// `POST /api/pets/:id/feed`: the portion built for the browser, and the project's one top-up of gas
// that may come before it (`Feeding gas data`, `Feeding transaction data`).
import { env } from 'cloudflare:workers';
import { Transaction } from 'near-api-js';
import { describe, expect, it } from 'vitest';
import { FEED_GAS_YOCTO, GAS_TOPUP_YOCTO } from '../src/pricing';
import { api, harness } from './helpers/api';
import { keyedPlayer, NEAR_ACCOUNT, token } from './helpers/network';

const h = harness();
const NEAR = 10n ** 24n;
const MILLI = 10n ** 21n;
const OWNER = NEAR_ACCOUNT(71);

const withPet = () => h.net().contract.addPet('7', OWNER);
/** A player with a real key, the NEAR in their wallet, and their token. */
async function player(balance: bigint) {
  const p = keyedPlayer();
  h.net().contract.balances.set(p.account, balance);
  return { ...p, token: await token(`did:privy:${p.account}`, p.account) };
}
const build = (tk: string, portion: string, id = '7') => api(`/api/pets/${id}/feed`, { token: tk, body: { portion } });
const transfers = () => h.net().contract.sends.filter((s) => s.method === 'transfer');
const decode = (b64: string) => Transaction.decode(Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0)));
const topUpAt = async (account: string) =>
  (await env.DB.prepare('SELECT gas_topup_at AS at, gas_added_yocto AS added FROM players WHERE account_id = ?').bind(account).first<{ at: number | null; added: string }>())!;

describe('the portion, built', () => {
  // spec: add-feeding › Feeding transaction data › прислана не та порция
  it('is one pet_feed of this pet from the player\'s account to the contract, with the tapped portion and its prepaid gas', async () => {
    withPet();
    const p = await player(NEAR);
    const res = await build(p.token, '0.05');
    expect(res.status).toBe(200);
    const tx = decode(res.body.tx);
    expect(tx.signerId).toBe(p.account);
    expect(tx.receiverId).toBe(env.CONTRACT_ID);
    expect(tx.actions).toHaveLength(1);
    const call = tx.actions[0]!.functionCall!;
    expect(call.methodName).toBe('pet_feed');
    expect(JSON.parse(new TextDecoder().decode(Uint8Array.from(call.args as ArrayLike<number>)))).toEqual({ token_id: '7' });
    expect(call.deposit).toBe(50n * MILLI);
    expect(call.gas).toBe(5_000_000_000_000n);
    // nothing was stored or sent by building
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM feedings').first<{ n: number }>())!.n).toBe(0);
    expect(h.net().contract.sends).toEqual([]);
  });

  // spec: add-feeding › Feeding outcome rule › отправлено
  it('turns away what is not a portion, a pet that does not exist, a visitor, and a player whose meal is already on its way', async () => {
    withPet();
    const p = await player(NEAR);
    expect((await build(p.token, '0.07')).status).toBe(400);
    expect((await api('/api/pets/7/feed', { token: p.token, body: {} })).status).toBe(400);
    expect((await build(p.token, '0.05', '99')).body).toEqual({ code: 'no_pet' });
    expect((await api('/api/pets/7/feed', { body: { portion: '0.05' } })).status).toBe(401);
    await env.DB.prepare("INSERT INTO feedings (id, sub, account, token_id, source, via, created_at) VALUES ('x', 's', ?, '7', 'near', 'link', 1)").bind(p.account).run();
    expect(await build(p.token, '0.05')).toEqual({ status: 409, body: { code: 'pending' } });
  });

  // spec: add-feeding › Feeding connection rule › сеть NEAR недоступна
  it('is refused as unreachable when the network does not answer, and nothing is sent', async () => {
    withPet();
    const p = await player(NEAR);
    h.net().contract.down = true;
    expect(await build(p.token, '0.05')).toEqual({ status: 503, body: { code: 'chain_unreachable' } });
    expect(h.net().contract.sends).toEqual([]);
  });
});

describe('the gas of a portion', () => {
  // spec: add-feeding › Feeding gas data › запас газа доложен
  it('is topped up once from the gas account before the portion is built, when the wallet holds the portion but not its gas', async () => {
    withPet();
    const p = await player(10n * MILLI);
    const res = await build(p.token, '0.01');
    expect(res.status).toBe(200);
    expect(transfers()).toMatchObject([{ signer: env.GAS_ACCOUNT_ID, deposit: GAS_TOPUP_YOCTO.toString() }]);
    expect(h.net().contract.balances.get(p.account)).toBe(10n * MILLI + GAS_TOPUP_YOCTO);
    expect((await topUpAt(p.account)).at).not.toBeNull();
    // the wallet now holds the portion and its gas: another build gives no second top-up
    expect((await build(p.token, '0.01')).status).toBe(200);
    expect(transfers()).toHaveLength(1);
  });

  // spec: add-feeding › Feeding gas data › запас газа доложен
  it('is not given to a wallet that holds the gas already: no transfer, the portion is built', async () => {
    withPet();
    const p = await player(10n * MILLI + FEED_GAS_YOCTO);
    expect((await build(p.token, '0.01')).status).toBe(200);
    expect(transfers()).toEqual([]);
    expect((await topUpAt(p.account)).at).toBeNull();
  });

  // spec: add-feeding › Feeding gas data › запас газа уже доливали
  it('is not given a second time: the player is told they are short, with the gas, and nothing is transferred or built', async () => {
    withPet();
    const p = await player(12n * MILLI);
    await env.DB.prepare("UPDATE players SET gas_topup_at = 1, gas_added_yocto = ?1 WHERE account_id = ?2").bind(GAS_TOPUP_YOCTO.toString(), p.account).run();
    const res = await build(p.token, '0.01');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('short');
    expect(res.body.sheet.portions[0]).toMatchObject({ near: '0.01', missing: '0.01' });
    expect(res.body.tx).toBeUndefined();
    expect(h.net().contract.sends).toEqual([]);
  });

  // spec: add-feeding › Feeding gas data › газ доложить нечем
  it('is not given when the gas account holds less than the top-up: short, nothing transferred or built', async () => {
    withPet();
    const p = await player(10n * MILLI);
    h.net().contract.balances.set(env.GAS_ACCOUNT_ID, GAS_TOPUP_YOCTO - 1n);
    const res = await build(p.token, '0.01');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('short');
    expect(transfers()).toEqual([]);
    expect((await topUpAt(p.account)).at).toBeNull();
  });

  // spec: add-feeding › Feeding gas data › запас газа доложен × a second tab
  it('is given once when two tabs build at the same moment: one transfer, and the other tab waits or builds on the landed gas', async () => {
    withPet();
    const p = await player(10n * MILLI);
    const [a, b] = await Promise.all([build(p.token, '0.01'), build(p.token, '0.01')]);
    expect(transfers()).toHaveLength(1);
    // the tab that claimed it builds; the other builds on the landed gas, waits (`pending`), or reads
    // the wallet before the transfer lands and is told it is short - never a second top-up
    expect([a.status, b.status]).toContain(200);
    for (const res of [a, b]) expect([200, 409]).toContain(res.status);
  });

  // spec: add-feeding › Feeding gas data › запас газа доложен
  it('gives up with nothing signed when the transfer is refused by the chain, and the top-up is owed again', async () => {
    withPet();
    const p = await player(10n * MILLI);
    h.net().contract.transferFails = 'broken';
    const res = await build(p.token, '0.01');
    expect(res).toEqual({ status: 502, body: { code: 'feed_not_built' } });
    expect(await topUpAt(p.account)).toEqual({ at: null, added: '0' });
    h.net().contract.transferFails = null;
    expect((await build(p.token, '0.01')).status).toBe(200);
  });

  // spec: add-feeding › Feeding gas data › запас газа доложен
  it('gives up the same way when the node refuses the transfer: nothing was included, and the top-up is owed again', async () => {
    withPet();
    const p = await player(10n * MILLI);
    h.net().contract.mode = 'not-enough-balance';
    expect(await build(p.token, '0.01')).toEqual({ status: 502, body: { code: 'feed_not_built' } });
    expect(await topUpAt(p.account)).toEqual({ at: null, added: '0' });
    expect(h.logs()).toContain('topup_failed:not_enough_balance');
    h.net().contract.mode = 'normal';
    expect((await build(p.token, '0.01')).status).toBe(200);
    expect(transfers()).toHaveLength(1);
  });

  // spec: add-feeding › Feeding gas data › запас газа доложен × a second tab
  it('is never given twice after a transfer whose outcome is unknown: nothing is built, and the claim stays', async () => {
    withPet();
    const p = await player(10n * MILLI);
    h.net().contract.mode = 'executed-but-silent';
    const res = await build(p.token, '0.01');
    expect(res).toEqual({ status: 502, body: { code: 'feed_not_built' } });
    expect((await topUpAt(p.account)).at).not.toBeNull();
    h.net().contract.mode = 'normal';
    // the transfer landed after all; asking again gives no second one
    await build(p.token, '0.01');
    expect(transfers()).toHaveLength(1);
    expect(h.logs()).toContain('topup_failed:unknown');
  });
});
