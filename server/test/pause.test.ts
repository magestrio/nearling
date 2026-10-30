import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { tick } from '../src/cron';
import { gasReserve } from '../src/servicePause';
import { api, harness, say } from './helpers/api';
import { NEAR_ACCOUNT, token } from './helpers/network';

const h = harness();
const OWNER = NEAR_ACCOUNT(1);
const MIN = 60_000;
const owner = () => token('did:privy:owner', OWNER);
const pause = async () => (await env.DB.prepare('SELECT reason FROM service_pause WHERE id = 1').first<{ reason: string | null }>())?.reason ?? null;
const rows = async (sql: string) => (await env.DB.prepare(sql).all()).results;

describe('Connection rule', () => {
  // spec: add-pet › Connection rule › разговор на паузе
  it('pauses on a 402 of NEAR AI: the line is not taken, nothing is reserved or spent, the birth is closed', async () => {
    h.net().contract.addPet('5', OWNER);
    const tk = await owner();
    h.net().ai.push({ status: 402 });
    expect((await say(tk, '5', 'Hello?')).code).toBe('paused');
    expect(await pause()).toBe('ai');
    expect(h.logs()).toContain('ai_402');

    // a new line is turned away at the door: no job, no call, no reserve, no spend
    const jobsBefore = (await rows('SELECT * FROM jobs')).length;
    const res = await api('/api/pets/5/thoughts', { token: tk, body: { text: 'Still there?', mode: 'chat' } });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ code: 'paused' });
    expect((await rows('SELECT * FROM jobs')).length).toBe(jobsBefore);
    expect(h.net().ai.calls).toHaveLength(1);
    expect(await rows('SELECT * FROM pet_spend')).toEqual([]);
    expect(await rows('SELECT * FROM project_spend')).toEqual([]);
    expect(await rows('SELECT * FROM thoughts')).toEqual([]);
    // the owner's view says so; the food is as before
    const view = await api('/api/pets/5', { token: tk });
    expect(view.body.paused).toBe(true);
    expect(view.body.fullness.level).toBe(1);
    // the birth is closed with the service reason, and no pet_mint goes to the network
    const closed = await api('/api/hatch', { token: await token('did:privy:player', NEAR_ACCOUNT(10)), body: { name: 'Pixel' } });
    expect(closed.status).toBe(409);
    expect(closed.body).toMatchObject({ code: 'closed', reason: 'service' });
    expect(h.net().contract.sends).toEqual([]);
  });

  // spec: add-pet › Connection rule › разговор на паузе
  it('reads the gas before a birth and before a thought: a low balance needs no cron to stop them', async () => {
    h.net().contract.addPet('5', OWNER);
    const tk = await owner();
    h.net().contract.serverBalance = (await gasReserve(env)) - 1n;
    const birth = await api('/api/hatch', { token: await token('did:privy:player', NEAR_ACCOUNT(10)), body: { name: 'Pixel' } });
    expect(birth.status).toBe(409);
    expect(birth.body).toMatchObject({ code: 'closed', reason: 'service' });
    expect(await pause()).toBe('gas');
    expect(h.net().contract.sends).toEqual([]);

    await env.DB.exec('DELETE FROM service_pause');
    expect((await say(tk, '5', 'Hello?')).code).toBe('paused');
    expect(await pause()).toBe('gas');
    expect(h.net().ai.calls).toEqual([]);
  });

  // spec: add-pet › Connection rule › разговор на паузе
  it('reads the gas before the debits too, and debits what it holds all the same', async () => {
    const chain = h.net().contract;
    chain.addPet('5', OWNER);
    await say(await owner(), '5', 'Hello!');
    chain.serverBalance = (await gasReserve(env)) - 1n;
    await tick(env, Date.now() + 11 * MIN);
    expect(await pause()).toBe('gas');
    expect(chain.debits).toHaveLength(1);
  });

  // spec: add-pet › Connection rule › разговор на паузе
  it('keeps debiting the thoughts it already holds while paused', async () => {
    const pet = h.net().contract.addPet('5', OWNER);
    const tk = await owner();
    await say(tk, '5', 'Hello!');
    h.net().ai.push({ status: 402 });
    await say(tk, '5', 'Hello again!');
    expect(await pause()).toBe('ai');
    await tick(env, Date.now() + 11 * MIN);
    expect(h.net().contract.debits).toHaveLength(1);
    expect(pet.last_debit_id).toBe(1);
  });

  // spec: add-pet › Connection rule › разговор на паузе
  it('pauses on the gas when the server account holds no more than the reserve, and no pet is minted', async () => {
    h.net().contract.addPet('5', OWNER);
    h.net().contract.serverBalance = (await gasReserve(env)) - 1n;
    await tick(env, Date.now());
    expect(await pause()).toBe('gas');
    expect((await api('/api/pets/5/thoughts', { token: await owner(), body: { text: 'hi', mode: 'chat' } })).status).toBe(409);
    const closed = await api('/api/hatch', { token: await token('did:privy:player', NEAR_ACCOUNT(10)), body: { name: 'Pixel' } });
    expect(closed.body).toMatchObject({ code: 'closed', reason: 'service' });
    expect(h.net().contract.sends).toEqual([]);
  });
});

describe('Service pause data', () => {
  // spec: add-pet › Service pause data › пауза снялась
  it('lifts a pause of NEAR AI when the probe passes, every five minutes, and sends nothing of its own', async () => {
    h.net().contract.addPet('5', OWNER);
    const tk = await owner();
    h.net().ai.push({ status: 402 });
    await say(tk, '5', 'Hello?'); // the draft the player keeps in the field
    const t0 = Date.now();
    h.net().ai.probeStatus = 402;
    await tick(env, t0 + MIN);
    expect(h.net().ai.probes).toBe(1);
    await tick(env, t0 + 3 * MIN);
    expect(h.net().ai.probes).toBe(1); // not before five minutes
    expect(await pause()).toBe('ai');
    expect((await api('/api/pets/5', { token: tk })).body.paused).toBe(true);

    h.net().ai.probeStatus = 200;
    await tick(env, t0 + 7 * MIN);
    expect(h.net().ai.probes).toBe(2);
    expect(await pause()).toBeNull();
    // the open screen's next poll has no «paused»; the saved line has not gone anywhere
    const view = await api('/api/pets/5', { token: tk });
    expect(view.body.paused).toBe(false);
    expect((await api('/api/pets/5/state', { token: tk })).body.paused).toBe(false);
    expect(h.net().ai.calls).toHaveLength(1);
    expect(await rows('SELECT * FROM thoughts')).toEqual([]);
    // and the player's own new send is taken again
    expect((await say(tk, '5', 'Hello?')).thought.text).toBe('Hello there, friend.');
  });

  // spec: add-pet › Service pause data › пауза снялась
  it('lifts a gas pause when the balance is back above the reserve', async () => {
    h.net().contract.addPet('5', OWNER);
    const chain = h.net().contract;
    const reserve = await gasReserve(env);
    chain.serverBalance = reserve;
    await tick(env, Date.now());
    expect(await pause()).toBe('gas');
    await tick(env, Date.now() + MIN);
    expect(await pause()).toBe('gas');
    chain.serverBalance = reserve + 1n;
    await tick(env, Date.now() + 2 * MIN);
    expect(await pause()).toBeNull();
    expect(h.net().ai.calls).toEqual([]);
    expect((await api('/api/pets/5', { token: await owner() })).body.paused).toBe(false);
  });
});
