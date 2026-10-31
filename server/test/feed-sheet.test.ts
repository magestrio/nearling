// `feedSheet` (pure) and the pause of the snacks through the route.
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { ceil2, feedSheet, needsGasAccount, snackLine, type SheetInput } from '../src/feeding/sheet';
import { FEED_GAS_YOCTO, fullness, STARTER_FOOD_YOCTO } from '../src/pricing';
import { api, harness } from './helpers/api';
import { NEAR_ACCOUNT, token } from './helpers/network';

const h = harness();
const NEAR = 10n ** 24n;
const MILLI = 10n ** 21n; // 0.001 NEAR
const HOUR_MS = 3_600_000;
const NOW = Date.UTC(2026, 10, 12, 21, 40);
const TODAY = Math.floor(NOW / 86_400_000);
const MIDNIGHT = new Date((TODAY + 1) * 86_400_000).toISOString();
const ASLEEP = fullness(0n);
const HUNGRY = fullness(STARTER_FOOD_YOCTO / 8n);

const input = (patch: Partial<SheetInput> = {}): SheetInput => ({
  viewer: 'owner',
  name: 'Pixel',
  fullness: HUNGRY,
  rate: 4.59,
  wallet: { balance: 310n * MILLI, gasAdded: 0n, topUpGiven: false },
  gasAccountHolds: true,
  pet: { friend_snack_day: 0, friend_snacks: 0, owner_snack_at: '0' },
  friendToday: { thisPet: false, pets: 0 },
  snackPaused: false,
  hatched: true,
  firstName: null,
  nowMs: NOW,
  ...patch,
});
const missing = (patch: Partial<SheetInput>) => feedSheet(input(patch)).portions.map((p) => p.missing);

describe('the portions of the sheet', () => {
  // spec: add-feeding › Feed sheet screen › success (владелец)
  it('are three, with the price in cents and the NEAR text, nothing missing for a full wallet, and the balance in yocto', () => {
    const sheet = feedSheet(input());
    expect(sheet.portions).toEqual([
      { near: '0.01', yocto: (10n ** 22n).toString(), cents: 5, missing: null },
      { near: '0.05', yocto: (5n * 10n ** 22n).toString(), cents: 23, missing: null },
      { near: '0.2', yocto: (2n * 10n ** 23n).toString(), cents: 92, missing: null },
    ]);
    expect(sheet.wallet).toEqual({ state: 'some', balance: (310n * MILLI).toString() });
    expect(sheet).toMatchObject({ viewer: 'owner', name: 'Pixel', friend: null, hatched: true });
  });

  // spec: add-feeding › Feed sheet screen › success (гость)
  it('carry the feeder\'s own first name for the thanks, for a guest only', () => {
    expect(feedSheet(input({ viewer: 'guest', firstName: 'Maya', hatched: false }))).toMatchObject({ viewer: 'guest', friend: 'Maya', hatched: false });
    expect(feedSheet(input({ viewer: 'owner', firstName: 'Maya' })).friend).toBeNull();
  });

  // spec: add-feeding › Player wallet data › в кошельке только газ проекта
  it('are all missing, from the whole 0.01, when the wallet holds only the project\'s gas and no top-up was given', () => {
    const only = { balance: 4n * MILLI, gasAdded: 5n * MILLI, topUpGiven: false };
    const sheet = feedSheet(input({ wallet: only, gasAccountHolds: null }));
    expect(sheet.wallet).toEqual({ state: 'none' });
    expect(sheet.portions.map((p) => p.missing)).toEqual(['0.01', '0.05', '0.20']);
    // also with an empty gas account: the amount is `Player wallet data`'s (the edge the user accepted)
    expect(missing({ wallet: only, gasAccountHolds: false })).toEqual(['0.01', '0.05', '0.20']);
    // an empty wallet, and a wallet whose balance is exactly the project's gas
    expect(missing({ wallet: { balance: 0n, gasAdded: 0n, topUpGiven: false }, gasAccountHolds: null })[0]).toBe('0.01');
    expect(feedSheet(input({ wallet: { balance: 5n * MILLI, gasAdded: 5n * MILLI, topUpGiven: false }, gasAccountHolds: null })).wallet.state).toBe('none');
  });

  // spec: add-feeding › Player wallet data › запас газа потрачен
  it('are all missing with the gas, rounded up to two decimals, when the top-up was given and spent: usually 0.02', () => {
    const spent = (balance: bigint) => ({ balance, gasAdded: 5n * MILLI, topUpGiven: true });
    expect(feedSheet(input({ wallet: spent(0n), gasAccountHolds: null })).wallet).toEqual({ state: 'none' });
    expect(missing({ wallet: spent(0n), gasAccountHolds: null })).toEqual(['0.02', '0.06', '0.21']);
    // 0.016 less the little that is left, up: 0.012 -> 0.02, 0.0111 -> 0.02
    expect(missing({ wallet: spent(4n * MILLI) })[0]).toBe('0.02');
    expect(missing({ wallet: spent(4_900n * 10n ** 18n) })[0]).toBe('0.02');
    // the project's gas is the wallet's, not the player's NEAR: the balance is never shown
    expect(feedSheet(input({ wallet: spent(4n * MILLI) })).wallet).toEqual({ state: 'none' });
  });

  // spec: add-feeding › Feed sheet screen › мало NEAR
  it('are short by what the portion and its gas need over the balance, the rows that fit missing nothing', () => {
    // 0.08 NEAR in the wallet, the top-up spent: the 0.2 portion with its 0.006 of gas is short 0.126 -> 0.13
    const wallet = { balance: 80n * MILLI, gasAdded: 5n * MILLI, topUpGiven: true };
    const sheet = feedSheet(input({ wallet, gasAccountHolds: null }));
    expect(sheet.wallet).toEqual({ state: 'some', balance: (80n * MILLI).toString() });
    expect(sheet.portions.map((p) => p.missing)).toEqual([null, null, '0.13']);
  });

  // spec: add-feeding › Feed sheet screen › мало NEAR
  it('count the gas in the need unless the project is still to give it', () => {
    const wallet = { balance: 80n * MILLI, gasAdded: 0n, topUpGiven: false };
    // the top-up is still due and the gas account holds it: the portion alone is the need
    expect(missing({ wallet, gasAccountHolds: true })).toEqual([null, null, '0.12']);
    // nothing to give it with (`Feeding gas data` › «газ доложить нечем»): the gas is the wallet's
    expect(missing({ wallet, gasAccountHolds: false })).toEqual([null, null, '0.13']);
  });

  // spec: add-feeding › Feed sheet screen › мало NEAR
  it('fit at the exact need and miss 0.01 at one yocto less', () => {
    const exact = (p: bigint) => ({ balance: p + FEED_GAS_YOCTO, gasAdded: 1n, topUpGiven: true });
    expect(missing({ wallet: exact(10n ** 22n), gasAccountHolds: null })[0]).toBeNull();
    expect(missing({ wallet: { ...exact(10n ** 22n), balance: 10n ** 22n + FEED_GAS_YOCTO - 1n }, gasAccountHolds: null })[0]).toBe('0.01');
    expect(ceil2(1n)).toBe('0.01');
    expect(ceil2(10n ** 22n)).toBe('0.01');
    expect(ceil2(10n ** 22n + 1n)).toBe('0.02');
    expect(ceil2(125n * 10n ** 21n)).toBe('0.13');
    expect(ceil2(2n * 10n ** 24n)).toBe('2.00');
  });

  // spec: add-feeding › Feeding gas data › запас газа уже доливали
  it('are short with the gas when the top-up was given, whatever the gas account holds', () => {
    // a balance above the project's gas but short of a portion with its own: 0.012 against 0.016
    const wallet = { balance: 12n * MILLI, gasAdded: 5n * MILLI, topUpGiven: true };
    expect(missing({ wallet, gasAccountHolds: null })[0]).toBe('0.01');
    expect(needsGasAccount(wallet)).toBe(false);
  });
});

describe('when the gas account is read', () => {
  // spec: add-feeding › Feeding gas data › газ доложить нечем
  it('only for a wallet with NEAR, a top-up still due and a portion that does not fit with its gas', () => {
    expect(needsGasAccount({ balance: 80n * MILLI, gasAdded: 0n, topUpGiven: false })).toBe(true);
    expect(needsGasAccount({ balance: 0n, gasAdded: 0n, topUpGiven: false })).toBe(false); // nothing in the wallet
    expect(needsGasAccount({ balance: 4n * MILLI, gasAdded: 5n * MILLI, topUpGiven: false })).toBe(false); // only the project's gas
    expect(needsGasAccount({ balance: 80n * MILLI, gasAdded: 0n, topUpGiven: true })).toBe(false);
    // enough for the biggest portion with its gas: the answer cannot depend on it
    expect(needsGasAccount({ balance: 200n * MILLI + FEED_GAS_YOCTO, gasAdded: 0n, topUpGiven: false })).toBe(false);
    expect(needsGasAccount({ balance: 200n * MILLI + FEED_GAS_YOCTO - 1n, gasAdded: 0n, topUpGiven: false })).toBe(true);
  });

  // spec: add-feeding › Feeding gas data › газ доложить нечем
  it('is a defect of the caller to build the sheet without it when it was needed', () => {
    expect(() => feedSheet(input({ wallet: { balance: 80n * MILLI, gasAdded: 0n, topUpGiven: false }, gasAccountHolds: null }))).toThrow('gas_account_unread');
  });
});

describe('the snack line', () => {
  const owner = (patch: Partial<SheetInput> = {}) => snackLine(input({ viewer: 'owner', fullness: ASLEEP, ...patch }));
  const friend = (patch: Partial<SheetInput> = {}) => snackLine(input({ viewer: 'guest', ...patch }));

  // spec: add-feeding › Snack rule › питомец владельца не спит
  it('is none for an owner whose pet is awake', () => {
    expect(snackLine(input({ viewer: 'owner', fullness: HUNGRY })).state).toBe('none');
    expect(snackLine(input({ viewer: 'owner', fullness: fullness(STARTER_FOOD_YOCTO) })).state).toBe('none');
  });

  // spec: add-feeding › Snack rule › перекус владельцу ещё не готов
  it('is ready for an owner of a sleeping pet who never had one, and at exactly 72 hours since the last', () => {
    expect(owner().state).toBe('ready');
    const last = BigInt(NOW - 72 * HOUR_MS) * 1_000_000n;
    expect(owner({ pet: { friend_snack_day: 0, friend_snacks: 0, owner_snack_at: last.toString() } }).state).toBe('ready');
  });

  // spec: add-feeding › Snack rule › перекус владельцу ещё не готов
  it('is not ready until 72 hours after the last, and says when', () => {
    const last = BigInt(NOW - 72 * HOUR_MS + 1000) * 1_000_000n; // a second short of 72 hours
    expect(owner({ pet: { friend_snack_day: 0, friend_snacks: 0, owner_snack_at: last.toString() } })).toEqual({ state: 'not_ready', at: new Date(NOW + 1000).toISOString() });
  });

  // spec: add-feeding › Snack rule › друг уже давал перекус сегодня
  it('is «given» for a friend who gave this pet a snack today', () => {
    expect(friend({ friendToday: { thisPet: true, pets: 1 } }).state).toBe('given');
  });

  // spec: add-feeding › Snack rule › три перекуса за сутки
  it('is «pet_full» when friends gave the pet three today, with the next 00:00 UTC; an earlier day counts nothing', () => {
    expect(friend({ pet: { friend_snack_day: TODAY, friend_snacks: 3, owner_snack_at: '0' } })).toEqual({ state: 'pet_full', until: MIDNIGHT });
    expect(friend({ pet: { friend_snack_day: TODAY, friend_snacks: 2, owner_snack_at: '0' } }).state).toBe('ready');
    expect(friend({ pet: { friend_snack_day: TODAY - 1, friend_snacks: 3, owner_snack_at: '0' } }).state).toBe('ready');
  });

  // spec: add-feeding › Snack rule › друг сегодня уже кормил многих
  it('is «shared_all» for a friend who gave three other pets a snack today', () => {
    expect(friend({ friendToday: { thisPet: false, pets: 3 } })).toEqual({ state: 'shared_all', until: MIDNIGHT });
    expect(friend({ friendToday: { thisPet: false, pets: 2 } }).state).toBe('ready');
  });

  // spec: add-feeding › Snack rule › several lines at once
  it('is the first line that holds: a friend\'s order is given, pet_full, shared_all', () => {
    const full = { friend_snack_day: TODAY, friend_snacks: 3, owner_snack_at: '0' };
    expect(friend({ pet: full, friendToday: { thisPet: true, pets: 3 } }).state).toBe('given');
    expect(friend({ pet: full, friendToday: { thisPet: false, pets: 3 } }).state).toBe('pet_full');
    expect(friend({ friendToday: { thisPet: true, pets: 3 } }).state).toBe('given');
  });

  // spec: add-feeding › Snack rule › several lines at once
  it('is the pause only where the snack would be allowed: it never stands over another line', () => {
    const paused = (patch: Partial<SheetInput>) => feedSheet(input({ snackPaused: true, ...patch })).snack.state;
    expect(paused({ viewer: 'guest' })).toBe('paused');
    expect(paused({ viewer: 'guest', friendToday: { thisPet: true, pets: 1 } })).toBe('given');
    expect(paused({ viewer: 'guest', pet: { friend_snack_day: TODAY, friend_snacks: 3, owner_snack_at: '0' } })).toBe('pet_full');
    expect(paused({ viewer: 'guest', friendToday: { thisPet: false, pets: 3 } })).toBe('shared_all');
    expect(paused({ viewer: 'owner', fullness: ASLEEP })).toBe('paused');
    expect(paused({ viewer: 'owner', fullness: ASLEEP, pet: { friend_snack_day: 0, friend_snacks: 0, owner_snack_at: (BigInt(NOW - HOUR_MS) * 1_000_000n).toString() } })).toBe('not_ready');
    expect(paused({ viewer: 'owner', fullness: HUNGRY })).toBe('none');
  });
});

describe('the pause of the snacks, through the route', () => {
  const OWNER = NEAR_ACCOUNT(61);
  const FRIEND = NEAR_ACCOUNT(62);
  const sheetFor = async (account: string, tokenId = '7') => (await api(`/api/pets/${tokenId}/feed`, { token: await token(`did:privy:${account}`, account) })).body;

  // spec: add-feeding › Feeding connection rule › перекусы на паузе
  it('stands in place of the snack while the services are paused, and lifts with the pause', async () => {
    h.net().contract.addPet('7', OWNER);
    expect((await sheetFor(FRIEND)).snack).toEqual({ state: 'ready' });
    await env.DB.exec("INSERT INTO service_pause (id, reason, since, last_probe) VALUES (1, 'gas', 1, NULL)");
    expect((await sheetFor(FRIEND)).snack).toEqual({ state: 'paused' });
    await env.DB.exec("UPDATE service_pause SET reason = 'ai' WHERE id = 1");
    expect((await sheetFor(FRIEND)).snack).toEqual({ state: 'paused' });
    await env.DB.exec('UPDATE service_pause SET reason = NULL, since = NULL WHERE id = 1');
    expect((await sheetFor(FRIEND)).snack).toEqual({ state: 'ready' });
  });

  // spec: add-feeding › Feeding connection rule › перекусы на паузе
  it('stands in place of the snack while the pool is under the amount of a snack, and not at exactly the amount', async () => {
    const chain = h.net().contract;
    chain.addPet('7', OWNER);
    chain.pool = BigInt(env.SNACK_AMOUNT) - 1n;
    expect((await sheetFor(FRIEND)).snack).toEqual({ state: 'paused' });
    chain.pool = BigInt(env.SNACK_AMOUNT);
    expect((await sheetFor(FRIEND)).snack).toEqual({ state: 'ready' });
  });

  // spec: add-feeding › Feeding connection rule › перекусы на паузе
  it('shows no line over an owner\'s awake pet, the pause or not, and the pause over a sleeping one', async () => {
    const chain = h.net().contract;
    chain.addPet('7', OWNER);
    await env.DB.exec("INSERT INTO service_pause (id, reason, since, last_probe) VALUES (1, 'gas', 1, NULL)");
    expect((await sheetFor(OWNER)).snack).toEqual({ state: 'none' });
    chain.pets.get('7')!.project_food = '0';
    expect((await sheetFor(OWNER)).snack).toEqual({ state: 'paused' });
  });
});
