import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { api, harness } from './helpers/api';
import { NEAR_ACCOUNT, token } from './helpers/network';

const h = harness();
const OWNER = NEAR_ACCOUNT(1);
const OTHER = NEAR_ACCOUNT(2);
const DAY_MS = 86_400_000;
const today = () => Math.floor(Date.now() / DAY_MS);
const STARTER = BigInt(env.STARTER_FOOD);

const setLife = (patch: { mood_day?: number | null; energy_day?: number | null; energy_used?: number }, id = '5') =>
  env.DB.prepare('INSERT OR REPLACE INTO pet_life (token_id, mood_day, energy_day, energy_used) VALUES (?, ?, ?, ?)')
    .bind(id, patch.mood_day ?? null, patch.energy_day ?? null, patch.energy_used ?? 0)
    .run();
const owner = () => token('did:privy:owner', OWNER);
const guest = () => token('did:privy:other', OTHER);

describe('Pet life display rule', () => {
  // spec: add-pet-life › Pet life display rule › гость
  it('gives a guest and a visitor the mood and the stage, never the traits, the energy or the time of its end', async () => {
    h.net().contract.addPet('5', OWNER, { stage: 'Adult', traits: ['clever', 'clever'] });
    await setLife({ energy_day: today(), energy_used: 10 });
    const seen = [await api('/api/pets/5', { token: await guest() }), await api('/api/pets/5')];
    for (const { status, body } of seen) {
      expect(status).toBe(200);
      expect(body).toMatchObject({ stage: 'adult', mood: 'calm' });
      for (const field of ['traits', 'energy', 'until', 'tired']) expect(body, field).not.toHaveProperty(field);
    }
  });

  // spec: add-pet-life › Pet life display rule › гость × the guest's answer
  it('gives every viewer the face of the day: happy after an event of today, sleepy hungry, none asleep', async () => {
    h.net().contract.addPet('5', OWNER);
    const faces = async () => [(await api('/api/pets/5', { token: await owner() })).body.mood, (await api('/api/pets/5', { token: await guest() })).body.mood];
    expect(await faces()).toEqual(['calm', 'calm']);

    await setLife({ mood_day: today() });
    expect(await faces()).toEqual(['happy', 'happy']);
    // the same event of an earlier day is a calm day again, with no write at 00:00
    await setLife({ mood_day: today() - 1 });
    expect(await faces()).toEqual(['calm', 'calm']);

    // hunger puts the event of the day under it
    await setLife({ mood_day: today() });
    h.net().contract.pets.get('5')!.project_food = (STARTER / 2n).toString();
    expect(await faces()).toEqual(['sleepy', 'sleepy']);

    h.net().contract.pets.get('5')!.project_food = '0';
    expect(await faces()).toEqual([null, null]);
  });

  // spec: add-pet-life › Pet life display rule › гость × the guest's answer
  it('gives a visitor the same face from the shared copy', async () => {
    h.net().contract.addPet('5', OWNER);
    await setLife({ mood_day: today() });
    const visitor = await api('/api/pets/5');
    expect(visitor.body).toMatchObject({ viewer: 'visitor', mood: 'happy' });
  });

  // spec: add-pet-life › Pet life display rule › владелец
  it('gives the owner the traits as words each once in the order gained, the stage and the energy', async () => {
    h.net().contract.addPet('5', OWNER, { stage: 'Adult', traits: ['hard_working', 'hard_working'] });
    const strong = await api('/api/pets/5', { token: await owner() });
    expect(strong.body).toMatchObject({ viewer: 'owner', stage: 'adult', traits: ['hard-working'], energy: 10, mood: 'calm' });
    expect(strong.body).not.toHaveProperty('until');

    h.net().contract.pets.get('5')!.traits = ['clever', 'cozy'];
    const state = await api('/api/pets/5/state', { token: await owner() });
    expect(state.body).toMatchObject({ traits: ['clever', 'cozy'], energy: 10, mood: 'calm' });

    h.net().contract.pets.get('5')!.traits = [];
    expect((await api('/api/pets/5', { token: await owner() })).body.traits).toEqual([]);
  });

  // spec: add-pet-life › Energy rule › энергия на нуле
  it('counts the energy in steps, gives the end of the day at zero and reads full on another day', async () => {
    h.net().contract.addPet('5', OWNER);
    await setLife({ energy_day: today(), energy_used: 3 });
    expect((await api('/api/pets/5', { token: await owner() })).body).toMatchObject({ energy: 7, tired: false });

    await setLife({ energy_day: today(), energy_used: 10 });
    const out = (await api('/api/pets/5', { token: await owner() })).body;
    expect(out).toMatchObject({ energy: 0, tired: false, until: new Date((today() + 1) * DAY_MS).toISOString() });
    expect((await api('/api/pets/5/state', { token: await owner() })).body).toMatchObject({ energy: 0, until: out.until });

    // yesterday's steps are not today's
    await setLife({ energy_day: today() - 1, energy_used: 10 });
    const fresh = (await api('/api/pets/5', { token: await owner() })).body;
    expect(fresh.energy).toBe(10);
    expect(fresh).not.toHaveProperty('until');
  });

  // spec: add-pet-life › Growth flow › переход записан позже ответа
  it('gives the line of a transition to a closed page as an event line, first among the pet\'s words', async () => {
    h.net().contract.addPet('5', OWNER);
    const now = Date.now();
    await env.DB.prepare("INSERT INTO thoughts (id, token_id, created_at, kind, reply_text, model, price_yocto, price_usd_micros, payer, status) VALUES ('a', '5', ?, 'reply', 'Hello', 'm', '0', 0, 'pet', 'billed')").bind(now).run();
    await env.DB.prepare("INSERT INTO thoughts (id, token_id, created_at, kind, reply_text, model, price_yocto, price_usd_micros, payer, status) VALUES ('b', '5', ?, 'growth', 'Pixel is a teen now — and turned out cozy!', '', '0', 0, 'project', 'project')").bind(now + 1).run();
    const out = await api('/api/pets/5/conversation', { token: await owner() });
    expect(out.body.lines).toEqual([
      { id: 'a', who: 'pet', text: 'Hello', at: now, cut: null },
      { id: 'b', who: 'event', text: 'Pixel is a teen now — and turned out cozy!', at: now + 1 },
    ]);
    // an open page learns of it by the poll: the newest thought with words
    expect((await api('/api/pets/5/state', { token: await owner() })).body.lastThought).toBe('b');
  });
});
