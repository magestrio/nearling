import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { fullRead, need, upToFor } from '../src/errands/price';
import { utcDay } from '../src/http';
import { DAILY_CAP_YOCTO } from '../src/pricing';
import { api, harness } from './helpers/api';
import { addPet, noEnergy, owner, pauseServices, PET, quote, tiredToday } from './helpers/errands';
import { NEAR_ACCOUNT, token } from './helpers/network';

const h = harness();

/** A pet with food for any search form: the starter food and three times it given. */
const rich = { given_food: (3n * BigInt(env.STARTER_FOOD)).toString() };
const food = (yocto: bigint) => ({ project_food: yocto.toString() });
/** Debited today so that this much of the daily cap is left. */
const capLeft = (yocto: bigint) => ({ debited_today: (DAILY_CAP_YOCTO - yocto).toString() });

describe('Errand sheet screen', () => {
  // spec: add-pet-errands › Errand sheet screen › food covers fewer searches
  it('lowers the «up to» to what the food pays and says how many searches that is', async () => {
    // 1.38¢: one search with its report (≈ 1.1¢) but not two (≈ 1.7¢)
    addPet(h, food(3_000_000_000_000_000_000_000n));
    const { status, body } = await quote(await owner(), 'find');
    expect(status).toBe(200);
    expect(body.block).toBeNull();
    expect(body.search).toMatchObject({ full: false, short: true, searches: 1, allowance: 3 });
    expect(body.search.upTo.cents).toBe(1.4);
    expect(body.search.upTo.yocto).toBe('3000000000000000000000');
  });

  // spec: add-pet-errands › Errand sheet screen › success
  it('quotes a read by its typical price and gives the sheet what it needs to price a pasted text', async () => {
    addPet(h, rich);
    const { body } = await quote(await owner());
    expect(body.read.typical.cents).toBe(0.19);
    expect(BigInt(body.read.base)).toBeGreaterThan(0n);
    expect(BigInt(body.read.perToken)).toBeGreaterThan(0n);
    expect(body.search).toMatchObject({ full: true, short: false, searches: 3 });
    expect(body.search.upTo.cents).toBe(2);
    expect(body.labels).toEqual([]);
  });

  // spec: add-pet-errands › Errand sheet screen › a skill with outside data
  it('gives the labels of the skill\'s data sources and the allowance of two searches', async () => {
    addPet(h, rich);
    await env.DB.prepare(
      "INSERT INTO data_sources (id, token_id, added_by, label, addr_ct, addr_iv, tools, created_at, updated_at) VALUES ('s1', ?, 'a', 'Daybook', x'00', x'00', '[]', 1, 1)",
    )
      .bind(PET)
      .run();
    const { body } = await quote(await owner(), 'check');
    expect(body.labels).toEqual(['Daybook']);
    expect(body.search).toMatchObject({ full: true, searches: 2, allowance: 2 });
    expect(body.search.upTo.yocto).toBe(upToFor(env, 2, true).yocto.toString());
  });

  // spec: add-pet-errands › Errand flow › can't pay
  it('says what a start needs when the food cannot start the form, asleep included', async () => {
    addPet(h, food(1_000_000_000_000_000_000_000n));
    const tk = await owner();
    // 0.46¢: a full read needs ≈ 0.50¢, a search form ≈ 0.92¢
    const read = (await quote(tk, 'read')).body.block;
    expect(read).toMatchObject({ reason: 'food', need: { cents: 0.5, yocto: need(env, 'read').yocto.toString() } });
    const find = (await quote(tk, 'find')).body.block;
    expect(find).toMatchObject({ reason: 'food', need: { yocto: need(env, 'find').yocto.toString() } });
    expect(find.need.cents).toBeCloseTo(0.93, 1);
    // asleep: below one scale thought
    h.net().contract.pets.get(PET)!.project_food = '100000000000000000000';
    expect((await quote(tk, 'check')).body.block).toMatchObject({ reason: 'asleep' });
  });

  // spec: add-pet-errands › Errand flow › can't pay
  it('starts a read at exactly what it needs and not a yocto below', async () => {
    addPet(h, food(need(env, 'read').yocto));
    const tk = await owner();
    expect((await quote(tk, 'read')).body.block).toBeNull();
    h.net().contract.pets.get(PET)!.project_food = (need(env, 'read').yocto - 1n).toString();
    expect((await quote(tk, 'read')).body.block).toMatchObject({ reason: 'food' });
  });

  // spec: add-pet-errands › Errand flow › out of energy
  it('rests a pet at zero energy until 00:00 UTC and spends nothing', async () => {
    addPet(h, rich);
    await noEnergy();
    const block = (await quote(await owner(), 'find')).body.block;
    expect(block).toEqual({ reason: 'energy', until: new Date((utcDay(Date.now()) + 1) * 86_400_000).toISOString() });
  });

  // spec: add-pet-errands › Errand flow › tired for today
  it('tires a pet at its daily cap, and when the highest price would take it over', async () => {
    addPet(h, { ...rich, ...capLeft(fullRead(env).yocto) });
    const tk = await owner();
    // the cap left is exactly a full read: it passes
    expect((await quote(tk, 'read')).body.block).toBeNull();
    // one yocto less: the highest price of a read would take it over
    h.net().contract.pets.get(PET)!.debited_today = (DAILY_CAP_YOCTO - fullRead(env).yocto + 1n).toString();
    expect((await quote(tk, 'read')).body.block).toMatchObject({ reason: 'cap' });
    // a search form's highest price is what the food pays of the searches
    h.net().contract.pets.get(PET)!.debited_today = (DAILY_CAP_YOCTO - upToFor(env, 3).yocto + 1n).toString();
    expect((await quote(tk, 'find')).body.block).toMatchObject({ reason: 'cap' });
    h.net().contract.pets.get(PET)!.debited_today = (DAILY_CAP_YOCTO - upToFor(env, 3).yocto).toString();
    expect((await quote(tk, 'find')).body.block).toBeNull();
    // and a pet already marked tired today
    h.net().contract.pets.get(PET)!.debited_today = '0';
    await tiredToday();
    expect((await quote(tk, 'read')).body.block).toMatchObject({ reason: 'cap' });
  });

  // spec: add-pet-errands › Errand flow › several blocks at once
  it('tells only the first block of every subset of the four, in the spec\'s order', async () => {
    const order = ['paused', 'food', 'energy', 'cap'] as const;
    for (let mask = 1; mask < 16; mask += 1) {
      const holds = order.filter((_, i) => (mask & (1 << i)) !== 0);
      for (const table of ['service_pause', 'pet_life', 'pets']) await env.DB.exec(`DELETE FROM ${table}`);
      h.net().contract.pets.clear();
      addPet(h, holds.includes('food') ? food(1_000_000_000_000_000_000_000n) : rich);
      if (holds.includes('paused')) await pauseServices();
      if (holds.includes('energy')) await noEnergy();
      if (holds.includes('cap')) {
        await tiredToday();
      }
      const { body } = await quote(await owner(), 'find');
      expect(body.block?.reason, `holding ${holds.join('+')}`).toBe(holds[0] === 'food' ? 'food' : holds[0]);
      expect(body.paused).toBe(holds[0] === 'paused');
    }
  });

  // spec: add-pet-errands › Data source data › not the owner
  it('turns away a signed-in player who is not the owner, and a signed-out caller', async () => {
    addPet(h);
    const stranger = await token('did:privy:stranger', NEAR_ACCOUNT(2));
    const refused = await quote(stranger);
    expect(refused.status).toBe(403);
    expect(refused.body).toEqual({ code: 'not_owner' });
    expect((await api(`/api/pets/${PET}/errand`)).status).toBe(401);
  });
});
