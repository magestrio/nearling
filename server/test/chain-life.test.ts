// The Worker's reads and sends for the pet's life (`chain.ts`): the chain's day, the traits of
// `pet_view`, and the server key's `pet_grow` as the fake plays it in the contract's order of checks.
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { chainDay, petView, PET_GROW_TGAS, RIDDLE_COMMIT_TGAS, RIDDLE_REVEAL_TGAS, riddleView, STREAK_MARK_TGAS } from '../src/chain';
import { harness } from './helpers/api';
import { NEAR_ACCOUNT } from './helpers/network';

const h = harness();
const serverKey = () => env.SERVER_KEY.get(env.SERVER_KEY.idFromName('server'));
const today = () => Math.floor(Date.now() / 86_400_000);
const grow = (token_id: string, stage: string, trait: string) => ({ methodName: 'pet_grow', args: { token_id, stage, trait }, gas: (PET_GROW_TGAS * 10n ** 12n).toString() });

describe('the chain\'s day', () => {
  // spec: add-pet-life › Growth flow › стал подростком × 00:00 UTC between the line and the answer
  it('is the contract\'s own UTC day, read from hatch_view of the server account', async () => {
    expect(await chainDay(env)).toBe(today());
    expect(h.net().contract.reads.at(-1)).toEqual({ method: 'hatch_view', args: { account_id: env.SERVER_ACCOUNT_ID } });
    h.net().contract.dayOverride = today() + 3;
    expect(await chainDay(env)).toBe(today() + 3);
  });

  // spec: add-pet-life › Pet life display rule › владелец
  it('reads the traits of a pet in the order gained, a repeat twice', async () => {
    h.net().contract.addPet('7', NEAR_ACCOUNT(1), { traits: ['clever', 'clever'] });
    expect((await petView(env, '7'))!.traits).toEqual(['clever', 'clever']);
  });
});

describe('pet_grow by the server key', () => {
  // spec: add-pet-life › Pet growth contract › стадия не следующая
  it('is checked in the contract\'s order: the pet, the next stage, then the day, and a trait outside the list fails first', async () => {
    const chain = h.net().contract;
    chain.addPet('7', NEAR_ACCOUNT(1), { stage_day: today() - 1 });
    expect(await serverKey().send(grow('8', 'Teen', 'clever'))).toMatchObject({ status: 'failed', code: 'no_pet' });
    // the same stage, a stage skipped: refused, nothing changes
    expect(await serverKey().send(grow('7', 'Baby', 'clever'))).toMatchObject({ status: 'failed', code: 'bad_stage' });
    expect(await serverKey().send(grow('7', 'Adult', 'clever'))).toMatchObject({ status: 'failed', code: 'bad_stage' });
    expect(await serverKey().send(grow('7', 'Teen', 'brave'))).toMatchObject({ status: 'failed', code: 'failed' });
    expect(chain.pets.get('7')).toMatchObject({ stage: 'Baby', traits: [] });
    expect(chain.sends.at(-1)!.gas).toBe('5000000000000');
  });

  // spec: add-pet-life › Pet growth contract › второе изменение стадии за сутки × a server that waits
  it('reads stage_today for a second change in a UTC day and takes the change after the day', async () => {
    const chain = h.net().contract;
    chain.addPet('7', NEAR_ACCOUNT(1));
    // born today: the birth counts as the day's change
    expect(await serverKey().send(grow('7', 'Teen', 'clever'))).toMatchObject({ status: 'failed', code: 'stage_today' });
    chain.dayOverride = today() + 1;
    expect(await serverKey().send(grow('7', 'Teen', 'clever'))).toMatchObject({ status: 'ok' });
    expect(await serverKey().send(grow('7', 'Adult', 'clever'))).toMatchObject({ status: 'failed', code: 'stage_today' });
    chain.dayOverride = today() + 2;
    expect(await serverKey().send(grow('7', 'Adult', 'clever'))).toMatchObject({ status: 'ok' });
    expect(chain.pets.get('7')).toMatchObject({ stage: 'Adult', traits: ['clever', 'clever'] });
    expect(chain.grows).toEqual([
      { token_id: '7', stage: 'Teen', trait: 'clever' },
      { token_id: '7', stage: 'Adult', trait: 'clever' },
    ]);
  });
});

describe('the reads and sends of the daily ritual', () => {
  it('reads the last streak day of a pet, null before the first mark', async () => {
    h.net().contract.addPet('7', NEAR_ACCOUNT(1));
    h.net().contract.addPet('8', NEAR_ACCOUNT(2), { last_streak_day: today() - 1 });
    expect((await petView(env, '7'))!.last_streak_day).toBeNull();
    expect((await petView(env, '8'))!.last_streak_day).toBe(today() - 1);
  });

  it('reads the commit of a day, the reserve and the price of a commit with riddle_view', async () => {
    const chain = h.net().contract;
    chain.fundRiddles();
    expect(await riddleView(env, today())).toEqual({ hash: null, reserve: '10000000000000000000000', commit_cost: '810000000000000000000' });
    expect(chain.reads.at(-1)).toEqual({ method: 'riddle_view', args: { day: today() } });
    expect((await serverKey().send({ methodName: 'riddle_commit', args: { hash: 'ab'.repeat(32) }, gas: (RIDDLE_COMMIT_TGAS * 10n ** 12n).toString() })).status).toBe('ok');
    expect((await riddleView(env, today())).hash).toBe('ab'.repeat(32));
    expect(chain.sends.at(-1)!.gas).toBe('5000000000000');
    expect(await riddleView(env, today() + 1)).toMatchObject({ hash: null, reserve: '9190000000000000000000' });
  });

  it('reads the refusals of the three server methods as the contract\'s codes', async () => {
    const chain = h.net().contract;
    chain.fundRiddles();
    chain.addPet('7', NEAR_ACCOUNT(1));
    const call = (methodName: string, args: Record<string, unknown>, tgas: bigint) => serverKey().send({ methodName, args, gas: (tgas * 10n ** 12n).toString() });
    // a day outside the window is `bad_day`, before the last day and the skipped days are read
    expect(await call('streak_mark', { token_id: '7', day: today() - 2, skipped: 0 }, STREAK_MARK_TGAS)).toMatchObject({ status: 'failed', code: 'bad_day' });
    expect(await call('streak_mark', { token_id: '7', day: today(), skipped: 0 }, STREAK_MARK_TGAS)).toMatchObject({ status: 'ok' });
    expect(await call('streak_mark', { token_id: '7', day: today(), skipped: 0 }, STREAK_MARK_TGAS)).toMatchObject({ status: 'failed', code: 'day_marked' });
    chain.dayOverride = today() + 1;
    expect(await call('streak_mark', { token_id: '7', day: today() + 1, skipped: 1 }, STREAK_MARK_TGAS)).toMatchObject({ status: 'failed', code: 'too_many_skipped' });
    expect(await call('riddle_commit', { hash: 'xyz' }, RIDDLE_COMMIT_TGAS)).toMatchObject({ status: 'failed', code: 'bad_hash' });
    expect(await call('riddle_commit', { hash: 'cd'.repeat(32) }, RIDDLE_COMMIT_TGAS)).toMatchObject({ status: 'ok' });
    expect(await call('riddle_commit', { hash: 'cd'.repeat(32) }, RIDDLE_COMMIT_TGAS)).toMatchObject({ status: 'failed', code: 'commit_today' });
    chain.riddleReserve = 0n;
    chain.dayOverride = today() + 2;
    expect(await call('riddle_commit', { hash: 'ef'.repeat(32) }, RIDDLE_COMMIT_TGAS)).toMatchObject({ status: 'failed', code: 'reserve_empty' });
    expect(await call('riddle_reveal', { day: today() + 2, riddle: 'r', answers: ['a'], salt: 's' }, RIDDLE_REVEAL_TGAS)).toMatchObject({ status: 'failed', code: 'reveal_too_early' });
    expect(await call('riddle_reveal', { day: today() + 1, riddle: 'r', answers: ['a'], salt: 's' }, RIDDLE_REVEAL_TGAS)).toMatchObject({ status: 'failed', code: 'bad_reveal' });
    expect(await call('riddle_reveal', { day: today() - 5, riddle: 'r', answers: ['a'], salt: 's' }, RIDDLE_REVEAL_TGAS)).toMatchObject({ status: 'failed', code: 'no_commit' });
  });
});
