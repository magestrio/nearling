import { env } from 'cloudflare:workers';
import { runDurableObjectAlarm } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { wakeIfFed } from '../src/pet/wake';
import { api, harness, say } from './helpers/api';
import { NEAR_ACCOUNT, token } from './helpers/network';

const h = harness();
const OWNER = NEAR_ACCOUNT(1);
const S = BigInt(env.STARTER_FOOD);
const owner = () => token('did:privy:owner', OWNER);
const alarm = async (id: string) => runDurableObjectAlarm(env.PET_DESK.get(env.PET_DESK.idFromName(id)));

/** A pet that fell asleep: nearly no food, the server's note of the sleep in place. */
async function asleepPet(id = '5') {
  const pet = h.net().contract.addPet(id, OWNER, { project_food: (S / 100n).toString() });
  await env.DB.prepare('INSERT INTO pets (token_id, hatched_by, born_at, birth_tx, slept_at) VALUES (?, ?, 1, ?, 1)').bind(id, OWNER, '').run();
  return pet;
}
const wakeJobs = async () => (await env.DB.prepare("SELECT * FROM jobs WHERE kind = 'wake'").all<any>()).results;
const lastRequest = () => h.net().ai.calls.at(-1)!.body.messages;
async function jobsDone() {
  for (let i = 0; i < 400; i += 1) {
    const open = await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status IN ('queued', 'running')").first<{ n: number }>();
    if (open!.n === 0) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('jobs did not finish');
}

describe('Sleep and wake flow', () => {
  // spec: add-pet › Sleep and wake flow › разбудил владелец
  it('wakes on the owner\'s poll once the food is back, tells what it missed first, and takes lines again', async () => {
    const pet = await asleepPet();
    const tk = await owner();
    // asleep: no line is taken
    expect((await say(tk, '5', 'Hello?')).code).toBe('asleep');
    expect(h.net().ai.calls).toEqual([]);
    // a poll while the food has not grown wakes nothing
    expect((await api('/api/pets/5/state', { token: tk })).body.events).toEqual([]);
    // the owner fed the pet (the feeding itself is add-feeding's): the network shows more food
    pet.given_food = S.toString();
    const poll = await api('/api/pets/5/state', { token: tk });
    expect(poll.body.events).toEqual(['woke']);
    await jobsDone();
    // the first thought is what it missed; a second poll does not wake it again
    expect(lastRequest().at(-1)!.content).toMatch(/missed/);
    expect(lastRequest().at(-1)!.content).not.toMatch(/Maya/);
    expect(await wakeJobs()).toHaveLength(1);
    expect((await api('/api/pets/5/state', { token: tk })).body.events).toEqual([]);
    expect(h.events().filter((e) => e.name === 'pet_woke')).toEqual([{ name: 'pet_woke', props: { via: 'owner' } }]);
    expect((await env.DB.prepare('SELECT slept_at FROM pets WHERE token_id = ?').bind('5').first<any>()).slept_at).toBeNull();
    const out = await say(tk, '5', 'Welcome back!');
    expect(out.thought.text).toBe('Hello there, friend.');
  });

  // spec: add-pet › Sleep and wake flow › разбудил заработок
  it('wakes from a worker\'s earnings at one scale thought of food, whatever the rate, and the first thought is about the work', async () => {
    const pet = await asleepPet();
    // not even a scale thought of food: stays asleep
    expect(await wakeIfFed(env, '5', 'work')).toBe(false);
    expect(await wakeJobs()).toEqual([]);
    pet.given_food = S.toString();
    expect(await wakeIfFed(env, '5', 'work')).toBe(true);
    expect(await alarm('5')).toBe(true);
    expect(lastRequest().at(-1)!.content).toMatch(/earned/);
    expect(h.events().filter((e) => e.name === 'pet_woke')).toEqual([{ name: 'pet_woke', props: { via: 'work' } }]);
    // and the pet takes lines again
    const tk = await owner();
    expect((await say(tk, '5', 'Nice!')).thought.text).toBe('Hello there, friend.');
  });
});

describe('Sleep and wake flow, the rate', () => {
  // spec: add-pet › Sleep and wake flow › разбудил заработок
  it('wakes at 1.1 scale thoughts also at a rate where that is less than a typical thought', async () => {
    const pet = await asleepPet();
    pet.given_food = ((S * 11n) / 120n).toString();
    const cheap = Object.assign(Object.create(env), { NEAR_USD_RATE: '3.0' }) as Env;
    expect(await wakeIfFed(cheap, '5', 'work')).toBe(true);
    expect(await wakeJobs()).toHaveLength(1);
  });
});

describe('Connection rule', () => {
  /** A pet woken by a friend whose wake thought failed. */
  async function failedWake() {
    const pet = await asleepPet();
    pet.given_food = S.toString();
    await wakeIfFed(env, '5', 'link', 'Maya');
    h.net().ai.push({ status: 500 });
    await alarm('5');
    const [job] = await wakeJobs();
    expect(job.status).toBe('done');
    expect(JSON.parse(job.result)).toEqual({ code: 'ai_unavailable' });
    return job;
  }

  // spec: add-pet › Connection rule › AI-провайдер недоступен
  it('tells the page a failed job is a wake thought, and «Try again» queues the same thought with its friend', async () => {
    const failed = await failedWake();
    const tk = await owner();
    const seen = await api(`/api/pets/5/state?job=${failed.id}`, { token: tk });
    expect(seen.body).toMatchObject({ code: 'ai_unavailable', jobKind: 'wake' });

    const retry = await api('/api/pets/5/wake', { token: tk, method: 'POST' });
    expect(retry.status).toBe(202);
    expect(retry.body.job).not.toBe(failed.id);
    await jobsDone();
    expect(lastRequest().at(-1)!.content).toContain('Maya');
    expect(h.net().ai.calls).toHaveLength(2);
    // the failed row gave up what it held; a second tap has nothing to retry
    expect((await api('/api/pets/5/wake', { token: tk, method: 'POST' })).body).toEqual({ job: null });
  });

  // spec: add-pet › Connection rule › AI-провайдер недоступен
  it('has nothing to retry for a pet that never woke, and refuses a stranger', async () => {
    h.net().contract.addPet('5', OWNER);
    expect((await api('/api/pets/5/wake', { token: await owner(), method: 'POST' })).body).toEqual({ job: null });
    const other = await api('/api/pets/5/wake', { token: await token('did:privy:other', NEAR_ACCOUNT(2)), method: 'POST' });
    expect(other.status).toBe(403);
  });
});

describe('Memory rule', () => {
  // spec: add-pet › Memory rule › помнит кормивших
  it('names the friend who fed the pet in the next thought and in every later request; a feeder without a name is «a friend»', async () => {
    const pet = await asleepPet();
    pet.given_food = S.toString();
    expect(await wakeIfFed(env, '5', 'link', 'Maya')).toBe(true);
    await alarm('5');
    // the wake thought thanks her by name
    expect(lastRequest().at(-1)!.content).toContain('Maya');
    expect(h.events().filter((e) => e.name === 'pet_woke')).toEqual([{ name: 'pet_woke', props: { via: 'link' } }]);

    const tk = await owner();
    await say(tk, '5', 'Who visited you?');
    expect(lastRequest()[0]!.content).toContain('Maya');
    await say(tk, '5', 'And later?');
    expect(lastRequest()[0]!.content).toContain('Maya');

    // a second feeder gave no name
    await env.DB.prepare('UPDATE pets SET slept_at = 2 WHERE token_id = ?').bind('5').run();
    expect(await wakeIfFed(env, '5', 'link')).toBe(true);
    await alarm('5');
    await say(tk, '5', 'Anyone else?');
    const memory = lastRequest()[0]!.content;
    expect(memory).toContain('Maya');
    expect(memory).toContain('a friend');
    // names go to the model; the owner's account id and the friend's never do
    expect(JSON.stringify(h.net().ai.calls.map((c) => c.body))).not.toContain(OWNER);
  });
});
