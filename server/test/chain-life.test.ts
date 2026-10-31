// The Worker's reads and sends for the pet's life (`chain.ts`): the chain's day, the traits of
// `pet_view`, and the server key's `pet_grow` as the fake plays it in the contract's order of checks.
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { chainDay, petView, PET_GROW_TGAS } from '../src/chain';
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
