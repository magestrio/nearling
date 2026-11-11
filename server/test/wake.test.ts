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
const CHAIN_ROUTE = 'a'.repeat(32);
async function recordedChainCredit(tokenId: string, wasAsleep: boolean) {
  await env.DB.prepare(`INSERT INTO any_chain_routes
    (id, token_id, origin_asset, amount_in, refund_to, expected_out, min_out, quote_json, state, created_at, request_deadline)
    VALUES (?, ?, 'solana-usdc', '150000', 'payer', '10000000000000000000000',
      '10000000000000000000000', '{}', 'accepted', ?, '2037-01-01')`)
    .bind(CHAIN_ROUTE, tokenId, Date.now()).run();
  await env.DB.prepare(`INSERT INTO any_chain_delivery_evidence
    (receipt_id, route_id, token_id, near_tx_hash, amount_yocto, kind, credit_id, recorded_at)
    VALUES ('receipt', ?, ?, 'near-hash', '10000000000000000000000', 'pending', 7, ?)`)
    .bind(CHAIN_ROUTE, tokenId, Date.now()).run();
  await env.DB.prepare(`INSERT INTO any_chain_credit_evidence
    (credit_id, near_tx_hash, amount_yocto, recorded_at, was_asleep)
    VALUES (7, 'near-hash', '10000000000000000000000', ?, ?)`)
    .bind(Date.now(), wasAsleep ? 1 : 0).run();
}
async function jobsDone() {
  for (let i = 0; i < 400; i += 1) {
    const open = await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status IN ('queued', 'running')").first<{ n: number }>();
    if (open!.n === 0) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('jobs did not finish');
}

describe('Sleep and wake flow', () => {
  // spec: add-any-chain-feed › Cross-chain identity rule › anonymous wake
  it('wakes from a confirmed chain credit without a friend, feeder memory or AI thanks', async () => {
    const pet = await asleepPet();
    const tk = await owner();
    await recordedChainCredit('5', true);
    pet.given_food = S.toString();
    const state = await api('/api/pets/5/state?wakes=0', { token: tk });
    expect(state.body).toMatchObject({ events: ['woke'], wakeSource: 'cross_chain', wakes: 1 });
    expect(state.body).not.toHaveProperty('friend');
    expect(await wakeJobs()).toEqual([]);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM memory_notes WHERE token_id = ?')
      .bind('5').first<{ n: number }>())?.n).toBe(0);
    expect((await api('/api/pets/5/state?wakes=1', { token: tk })).body.events).toEqual([]);
  });

  // spec: add-any-chain-feed › Cross-chain identity rule › anonymous wake
  it('wakes with no source line and no name while the credit receipt has not been read, and does not wake again when it is', async () => {
    const pet = await asleepPet();
    const tk = await owner();
    // the food is already on chain, the Worker has not recorded the receipt that raised it
    pet.given_food = S.toString();
    const first = await api('/api/pets/5/state?wakes=0', { token: tk });
    expect(first.body.events).toEqual(['woke']);
    expect(first.body).not.toHaveProperty('wakeSource');
    expect(first.body).not.toHaveProperty('friend');
    // the receipt is read afterwards: the pet is awake already, nothing wakes twice
    await recordedChainCredit('5', false);
    const second = await api('/api/pets/5/state?wakes=1', { token: tk });
    expect(second.body.events).toEqual([]);
    expect(second.body).not.toHaveProperty('wakeSource');
    expect(h.events().filter((e) => e.name === 'pet_woke')).toEqual([]);
  });

  // spec: add-any-chain-feed › Cross-chain identity rule › anonymous wake
  it('leaves the wake to a friend\'s meal on its way, whose thanks belong to its own flow', async () => {
    const pet = await asleepPet();
    const tk = await owner();
    await recordedChainCredit('5', true);
    await env.DB.prepare("INSERT INTO feedings (id, sub, account, token_id, source, via, created_at) VALUES ('f1', 'did:privy:friend', ?, '5', 'near', 'link', ?)")
      .bind(NEAR_ACCOUNT(2), Date.now()).run();
    pet.given_food = S.toString();
    const poll = await api('/api/pets/5/state?wakes=0', { token: tk });
    expect(poll.body.events).toEqual([]);
    expect(poll.body).not.toHaveProperty('wakeSource');
    expect((await env.DB.prepare('SELECT slept_at FROM pets WHERE token_id = ?').bind('5').first<any>()).slept_at).not.toBeNull();
  });

  // spec: add-any-chain-feed › Cross-chain availability rule › services paused
  it('tells the Feed sheet that new cross-chain payments are closed while services are paused', async () => {
    h.net().contract.addPet('5', OWNER);
    const tk = await owner();
    expect((await api('/api/pets/5/feed', { token: tk })).body.crossChainPaused).toBe(false);
    await env.DB.prepare("INSERT INTO service_pause (id, reason, since) VALUES (1, 'gas', 1)").run();
    expect((await api('/api/pets/5/feed', { token: tk })).body.crossChainPaused).toBe(true);
  });

  // spec: add-any-chain-feed › Cross-chain identity rule › anonymous credit
  it('returns confirmed food to the owner Feed without a payer name or address', async () => {
    h.net().contract.addPet('5', OWNER);
    await recordedChainCredit('5', false);
    const tk = await owner();
    const feed = await api('/api/pets/5/feed', { token: tk });
    expect(feed.status).toBe(200);
    expect(feed.body.crossChainCredits).toEqual([{ id: CHAIN_ROUTE, creditId: 7, wasAsleep: false, route: 'quote' }]);
    const deposits = await api('/api/any-chain/pets/5/deposits', { token: tk });
    expect(deposits.body.credits).toEqual(feed.body.crossChainCredits);
    expect(JSON.stringify(feed.body.crossChainCredits)).not.toContain('payer');
  });

  // spec: add-pet › Sleep and wake flow › разбудил владелец
  it('wakes on the poll without attributing food before its receipt is read', async () => {
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
    // No receipt means no source line, name or owner wake thought.
    expect(poll.body).not.toHaveProperty('wakeSource');
    expect(await wakeJobs()).toHaveLength(0);
    expect((await api('/api/pets/5/state', { token: tk })).body.events).toEqual([]);
    expect(h.events().filter((e) => e.name === 'pet_woke')).toEqual([]);
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
