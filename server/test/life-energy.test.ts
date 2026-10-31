import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { desk, enqueueJob } from '../src/pet/desk';
import { energyLeft, readLife, spendEnergy } from '../src/pet/life';
import { run } from '../src/spend';
import { harness } from './helpers/api';
import { NEAR_ACCOUNT } from './helpers/network';

const h = harness();
const OWNER = NEAR_ACCOUNT(1);
const DAY_MS = 86_400_000;
const ONE_NEAR = (10n ** 24n).toString();

const today = () => Math.floor(Date.now() / DAY_MS);
const addPet = (id = '5', patch: Record<string, unknown> = {}) => h.net().contract.addPet(id, OWNER, { given_food: ONE_NEAR, ...patch });
const deep = (id = '5') => run(env, id, { kind: 'reply', mode: 'deep', text: 'Think about this' });
const chat = (id = '5') => run(env, id, { kind: 'reply', mode: 'chat', text: 'Hello' });
const used = async (id = '5') => (await env.DB.prepare('SELECT energy_day, energy_used FROM pet_life WHERE token_id = ?').bind(id).first<{ energy_day: number | null; energy_used: number }>()) ?? { energy_day: null, energy_used: 0 };
const setUsed = (n: number, day = today(), id = '5') =>
  env.DB.prepare('INSERT INTO pet_life (token_id, energy_day, energy_used) VALUES (?1, ?2, ?3) ON CONFLICT (token_id) DO UPDATE SET energy_day = ?2, energy_used = ?3').bind(id, day, n).run();
const depleted = () => h.events().filter((e) => e.name === 'energy_depleted');

describe('Energy rule', () => {
  // spec: add-pet-life › Energy rule › энергия на нуле × the last step
  it('takes a step of every answer of «Think hard» and fires energy_depleted once, at the tenth', async () => {
    addPet();
    for (let step = 1; step <= 10; step += 1) {
      expect('thoughtId' in (await deep())).toBe(true);
      expect(await used()).toEqual({ energy_day: today(), energy_used: step });
      expect(depleted()).toHaveLength(step === 10 ? 1 : 0);
    }
    expect(depleted()[0]!.props).toEqual({ by: 'deep' });
    // the energy is out: the eleventh is refused before a call, nothing more is spent
    const calls = h.net().ai.calls.length;
    expect(await deep()).toEqual({ code: 'no_energy' });
    expect(h.net().ai.calls).toHaveLength(calls);
    expect(await used()).toEqual({ energy_day: today(), energy_used: 10 });
    expect(depleted()).toHaveLength(1);
  });

  // spec: add-pet-life › Energy rule › энергия на нуле
  it('takes no step for chat, and chatting still works at zero energy', async () => {
    addPet();
    await chat();
    expect(await used()).toEqual({ energy_day: null, energy_used: 0 });
    await setUsed(10);
    expect('thoughtId' in (await chat())).toBe(true);
    expect(await used()).toEqual({ energy_day: today(), energy_used: 10 });
  });

  // spec: add-pet-life › Energy rule › энергия на нуле × the last step by work
  it('fires energy_depleted by work when work takes the last step, and not again at zero', async () => {
    addPet();
    await setUsed(8);
    expect(await spendEnergy(env.DB, '5', 'work', Date.now())).toEqual({ spent: true, left: 1 });
    expect(depleted()).toHaveLength(0);
    expect(await spendEnergy(env.DB, '5', 'work', Date.now())).toEqual({ spent: true, left: 0 });
    expect(depleted().map((e) => e.props)).toEqual([{ by: 'work' }]);
    expect(await spendEnergy(env.DB, '5', 'work', Date.now())).toEqual({ spent: false, left: 0 });
    expect(depleted()).toHaveLength(1);
    expect(await used()).toEqual({ energy_day: today(), energy_used: 10 });
  });

  // spec: add-pet-life › Energy rule › энергия на нуле × a refused job
  it('refuses «Think hard» at zero with nothing reserved, called or spent, also on a hungry pet', async () => {
    // half the starter food: hungry, not asleep
    addPet('5', { project_food: '0', given_food: (BigInt(env.STARTER_FOOD) / 2n).toString() });
    await setUsed(10);
    // hungry and without energy: the energy's words, not the hunger's
    expect(await deep()).toEqual({ code: 'no_energy' });
    expect(h.net().ai.calls).toHaveLength(0);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM pet_spend').first()).toEqual({ n: 0 });
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM thoughts').first()).toEqual({ n: 0 });
    expect(await used()).toEqual({ energy_day: today(), energy_used: 10 });
    // the same pet with energy is refused for its hunger, as before
    await setUsed(0);
    expect(await deep()).toEqual({ code: 'too_hungry' });
  });

  // spec: add-pet-life › Energy rule › энергия на нуле × a refused job
  it('lets sleep and the tired day speak before the energy, and a thought that did not come take no step', async () => {
    addPet('5', { project_food: '0', given_food: '0' });
    await setUsed(10);
    expect(await deep()).toEqual({ code: 'asleep' });

    addPet('6');
    h.net().ai.push({ status: 500 });
    expect(await deep('6')).toEqual({ code: 'ai_unavailable' });
    expect(await used('6')).toEqual({ energy_day: null, energy_used: 0 });
    h.net().ai.push({ content: '' });
    expect(await deep('6')).toEqual({ code: 'ai_unavailable' });
    expect(await used('6')).toEqual({ energy_day: null, energy_used: 0 });
  });

  // spec: add-pet-life › Energy rule › энергия на нуле × a queued second Think hard
  it('refuses a second «Think hard» that waited in the queue behind the one that took the last step', async () => {
    addPet();
    await setUsed(9);
    const first = await enqueueJob(env.DB, '5', { kind: 'reply', mode: 'deep', text: 'First' });
    const second = await enqueueJob(env.DB, '5', { kind: 'reply', mode: 'deep', text: 'Second' });
    await desk(env, '5').process('5');
    const result = async (id: string) => JSON.parse((await env.DB.prepare('SELECT result FROM jobs WHERE id = ?').bind(id).first<{ result: string }>())!.result);
    expect(await result(first)).toMatchObject({ cut: null });
    expect(await result(second)).toEqual({ code: 'no_energy' });
    expect(h.net().ai.calls).toHaveLength(1);
    expect(await used()).toEqual({ energy_day: today(), energy_used: 10 });
    expect(depleted()).toHaveLength(1);
  });

  // spec: add-pet-life › Energy rule › энергия на нуле × a re-ask
  it('takes one step for a re-asked «Think hard»: one thought, two calls', async () => {
    addPet();
    h.net().ai.push({ content: '', finish: 'length', tokensOut: 3000, reasoning: 3000 }, { content: 'Short and clear.', tokensOut: 25 });
    const out = await deep();
    expect(out).toMatchObject({ reasked: true });
    expect(h.net().ai.calls).toHaveLength(2);
    expect(await used()).toEqual({ energy_day: today(), energy_used: 1 });
  });

  // spec: add-pet-life › Energy rule › энергия на нуле
  it('is full again at 00:00 UTC with no write, and the first step of the new day starts at one', async () => {
    addPet();
    await setUsed(10, today() - 1);
    expect(energyLeft(await readLife(env.DB, '5'), today())).toBe(10);
    expect('thoughtId' in (await deep())).toBe(true);
    expect(await used()).toEqual({ energy_day: today(), energy_used: 1 });
  });

  // spec: add-pet-life › Energy rule › совет питомцу на нуле
  it('refuses work at zero by the seam: nothing is taken and no event fires', async () => {
    addPet();
    await setUsed(10);
    expect(await spendEnergy(env.DB, '5', 'work', Date.now())).toEqual({ spent: false, left: 0 });
    expect(await used()).toEqual({ energy_day: today(), energy_used: 10 });
    expect(depleted()).toHaveLength(0);
    // the pet is fed as always: its food is the contract's and the energy does not touch it
    expect(h.net().contract.pets.get('5')!.given_food).toBe(ONE_NEAR);
  });

  // spec: add-pet-life › Energy rule › совет питомцу на нуле × work at zero
  it('takes a step from a pet with no row yet: a new pet has full energy', async () => {
    addPet();
    expect(await spendEnergy(env.DB, '5', 'work', Date.now())).toEqual({ spent: true, left: 9 });
    expect(await used()).toEqual({ energy_day: today(), energy_used: 1 });
  });
});
