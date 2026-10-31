import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { ChainUnreachable } from '../src/chain';
import { claimGasTopUp, readWallet } from '../src/feeding/wallet';
import { GAS_TOPUP_YOCTO } from '../src/pricing';
import { harness } from './helpers/api';
import { NEAR_ACCOUNT } from './helpers/network';

const h = harness();
const NEAR = 10n ** 24n;
const SUB = 'did:privy:walker';
const ACCOUNT = NEAR_ACCOUNT(51);
const session = { sub: SUB, accountId: ACCOUNT };
const DEPOSIT = BigInt(env.MIN_FEED);

async function player(seen: bigint = 0n): Promise<void> {
  await env.DB.prepare('INSERT OR REPLACE INTO players (sub, account_id, month, created_at, wallet_seen_yocto) VALUES (?, ?, ?, ?, ?)')
    .bind(SUB, ACCOUNT, '2026-11', 1, seen.toString())
    .run();
}
const seenOf = async () => BigInt((await env.DB.prepare('SELECT wallet_seen_yocto AS s FROM players WHERE sub = ?').bind(SUB).first<{ s: string }>())!.s);
const funded = () => h.events().filter((e) => e.name === 'wallet_funded').length;

describe('the wallet read', () => {
  // spec: add-feeding › Player wallet data › в кошельке только газ проекта × first read of a funded wallet
  it('counts NEAR the player brought as a funding once, and moves `seen` up to the balance', async () => {
    await player();
    h.net().contract.balances.set(ACCOUNT, NEAR);
    const first = await readWallet(env, session);
    expect(first).toMatchObject({ balance: NEAR, funded: true, topUpGiven: false, gasAdded: 0n });
    expect(await seenOf()).toBe(NEAR);
    expect(funded()).toBe(1);
    // read again, and from another tab: nothing more
    expect((await readWallet(env, session)).funded).toBe(false);
    expect(funded()).toBe(1);
    // more NEAR: a funding again, by the rise
    h.net().contract.balances.set(ACCOUNT, 2n * NEAR);
    expect((await readWallet(env, session)).funded).toBe(true);
    expect(funded()).toBe(2);
  });

  // spec: add-feeding › Player wallet data › в кошельке только газ проекта × first read of a funded wallet
  it('counts two reads at the same time once', async () => {
    await player();
    h.net().contract.balances.set(ACCOUNT, NEAR);
    const [a, b] = await Promise.all([readWallet(env, session), readWallet(env, session)]);
    expect([a.funded, b.funded].sort()).toEqual([false, true]);
    expect(funded()).toBe(1);
  });

  // spec: add-feeding › Feed sheet screen › без NEAR
  it('reads a wallet that does not exist as empty, and counts nothing', async () => {
    await player();
    expect(await readWallet(env, session)).toMatchObject({ balance: 0n, funded: false });
    expect(funded()).toBe(0);
  });

  // spec: add-feeding › Feeding connection rule › сеть NEAR недоступна
  it('fails with `ChainUnreachable` when the node is down, and writes nothing', async () => {
    await player(NEAR);
    h.net().contract.down = true;
    await expect(readWallet(env, session)).rejects.toBeInstanceOf(ChainUnreachable);
    expect(await seenOf()).toBe(NEAR);
  });
});

describe('what is not a funding', () => {
  // spec: add-feeding › Player wallet data › в кошельке только газ проекта × refund of a refused meal
  it('is the refund of a refused meal: the deposit comes back, `seen` was never lowered', async () => {
    await player(NEAR);
    const chain = h.net().contract;
    // the meal was signed and refused by the contract: the deposit is back, the gas is burnt
    chain.balances.set(ACCOUNT, NEAR - 300_000_000_000_000_000_000n);
    expect((await readWallet(env, session)).funded).toBe(false);
    chain.balances.set(ACCOUNT, NEAR); // and the whole of it, to the yocto
    expect((await readWallet(env, session)).funded).toBe(false);
    expect(await seenOf()).toBe(NEAR);
    expect(funded()).toBe(0);
  });

  // spec: add-feeding › Player wallet data › в кошельке только газ проекта × refund of a refused meal
  it('is anything read while a meal is on its way, and it is counted when the row is gone', async () => {
    await player(NEAR);
    h.net().contract.balances.set(ACCOUNT, NEAR + DEPOSIT);
    await env.DB.prepare("INSERT INTO feedings (id, sub, account, token_id, source, via, created_at) VALUES ('h', ?, ?, '7', 'near', 'link', 1)").bind(SUB, ACCOUNT).run();
    expect((await readWallet(env, session)).funded).toBe(false);
    expect(await seenOf()).toBe(NEAR);
    await env.DB.exec('DELETE FROM feedings');
    expect((await readWallet(env, session)).funded).toBe(true);
    expect(await seenOf()).toBe(NEAR + DEPOSIT);
  });

  // spec: add-feeding › Player wallet data › в кошельке только газ проекта × gas refund after a meal
  it('is the gas refund that lands blocks after a confirmed meal', async () => {
    // `seen` fell by the deposit at the outcome; the balance is lower still by the gas burnt
    const afterMeal = NEAR - DEPOSIT;
    await player(afterMeal);
    const chain = h.net().contract;
    chain.balances.set(ACCOUNT, afterMeal - 3_000_000_000_000_000_000_000n);
    expect((await readWallet(env, session)).funded).toBe(false);
    // the refund of the unused gas arrives: still under `seen`
    chain.balances.set(ACCOUNT, afterMeal - 1_000_000_000_000_000_000_000n);
    expect((await readWallet(env, session)).funded).toBe(false);
    expect(funded()).toBe(0);
  });
});

describe('the top-up of gas', () => {
  // spec: add-feeding › Player wallet data › в кошельке только газ проекта × a top-up
  it('is no funding: the claim raises `seen` and `gas_added` with it, so the transfer reads as the project\'s', async () => {
    await player();
    expect(await claimGasTopUp(env.DB, SUB, GAS_TOPUP_YOCTO, 1234)).toBe(true);
    expect(await seenOf()).toBe(GAS_TOPUP_YOCTO);
    h.net().contract.balances.set(ACCOUNT, GAS_TOPUP_YOCTO); // the transfer landed
    const read = await readWallet(env, session);
    expect(read).toMatchObject({ balance: GAS_TOPUP_YOCTO, funded: false, topUpGiven: true, gasAdded: GAS_TOPUP_YOCTO });
    expect(funded()).toBe(0);
    // NEAR the player adds on top of it is one
    h.net().contract.balances.set(ACCOUNT, GAS_TOPUP_YOCTO + NEAR);
    expect((await readWallet(env, session)).funded).toBe(true);
  });

  // spec: add-feeding › Feeding gas data › запас газа доложен × a second tab
  it('is claimed once: of two at the same time one gets it, a later one never', async () => {
    await player(NEAR);
    const [a, b] = await Promise.all([claimGasTopUp(env.DB, SUB, GAS_TOPUP_YOCTO, 1), claimGasTopUp(env.DB, SUB, GAS_TOPUP_YOCTO, 2)]);
    expect([a, b].sort()).toEqual([false, true]);
    expect(await claimGasTopUp(env.DB, SUB, GAS_TOPUP_YOCTO, 3)).toBe(false);
    expect(await seenOf()).toBe(NEAR + GAS_TOPUP_YOCTO);
    const row = await env.DB.prepare('SELECT gas_added_yocto AS added FROM players WHERE sub = ?').bind(SUB).first<{ added: string }>();
    expect(row!.added).toBe(GAS_TOPUP_YOCTO.toString());
  });

  // spec: add-feeding › Feeding gas data › запас газа доложен × a second tab
  it('is claimed on top of the gas an earlier transfer (the gift\'s) already put there', async () => {
    await player(2n * NEAR);
    await env.DB.prepare("UPDATE players SET gas_added_yocto = '7' WHERE sub = ?").bind(SUB).run();
    expect(await claimGasTopUp(env.DB, SUB, GAS_TOPUP_YOCTO, 1)).toBe(true);
    const row = await env.DB.prepare('SELECT gas_added_yocto AS added FROM players WHERE sub = ?').bind(SUB).first<{ added: string }>();
    expect(row!.added).toBe((GAS_TOPUP_YOCTO + 7n).toString());
  });
});
