import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { tick } from '../src/cron';
import { desk, enqueueJob } from '../src/pet/desk';
import { api, harness } from './helpers/api';
import { NEAR_ACCOUNT, token } from './helpers/network';

const h = harness();
const OWNER = NEAR_ACCOUNT(1);
const owner = () => token('did:privy:owner', OWNER);
const MIN = 60_000;
const job = (id: string) => env.DB.prepare('SELECT status, result, payload FROM jobs WHERE id = ?').bind(id).first<{ status: string; result: string | null; payload: string | null }>();

/** The desk works in the background of a request; wait for it in D1. */
async function until(id: string, status: string) {
  for (let i = 0; i < 1000; i += 1) {
    if ((await job(id))?.status === status) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`job ${id} never became ${status}`);
}

describe('Thought queue data', () => {
  // spec: add-pet › Thought queue data › параллельные запросы ждут очереди × перезагрузка посреди мысли
  it('runs a queued job the moment anyone polls the pet, though no request or alarm is left to start it', async () => {
    h.net().contract.addPet('5', OWNER);
    const id = await enqueueJob(env.DB, '5', { kind: 'reply', mode: 'chat', text: 'Are you there?' });
    await api('/api/pets/5/state', { token: await owner() });
    await until(id, 'done');
    expect(h.net().ai.calls).toHaveLength(1);
  });

  // spec: add-pet › Thought queue data › параллельные запросы ждут очереди × перезагрузка посреди мысли
  it('ends a job left running by a dead object, at the next poll, and goes on with the jobs behind it', async () => {
    h.net().contract.addPet('5', OWNER);
    const dead = await enqueueJob(env.DB, '5', { kind: 'reply', mode: 'chat', text: 'First' });
    await env.DB.prepare("UPDATE jobs SET status = 'running', created_at = ? WHERE id = ?").bind(Date.now() - 6 * MIN, dead).run();
    const next = await enqueueJob(env.DB, '5', { kind: 'reply', mode: 'chat', text: 'Second' });
    const tk = await owner();
    await api('/api/pets/5/state', { token: tk });
    await until(next, 'done');
    expect(await job(dead)).toEqual({ status: 'failed', result: JSON.stringify({ code: 'ai_unavailable' }), payload: null });
    const out = (await api(`/api/pets/5/state?job=${dead}`, { token: tk })).body;
    expect(out.code).toBe('ai_unavailable');
    expect(out.pendingJob).toBeNull();
  });

  // spec: add-pet › Thought queue data › параллельные запросы ждут очереди × перезагрузка посреди мысли
  it('starts a dead desk from `POST …/greeting` too, with the greeting already queued', async () => {
    h.net().contract.addPet('5', OWNER);
    const id = await enqueueJob(env.DB, '5', { kind: 'greeting' });
    const res = await api('/api/pets/5/greeting', { token: await owner(), method: 'POST' });
    expect(res.body.job).toBe(id);
    await until(id, 'done');
    expect(h.net().ai.calls).toHaveLength(1);
  });

  // spec: add-pet › First thought flow › Приветствие
  it('keeps the token id itself: the alarm of an object does not rest on its name', async () => {
    const stub = desk(env, '5');
    await stub.arm('5');
    expect(await runInDurableObject(stub, (_, state) => state.storage.get('tokenId'))).toBe('5');
  });

  // spec: add-pet › Thought queue data › параллельные запросы ждут очереди × перезагрузка посреди мысли
  it('keeps an alarm armed while a job runs, and none once the queue is empty', async () => {
    h.net().contract.addPet('5', OWNER);
    // held open by the test, not by a wall-clock delay: a loaded machine let the call end before the check
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.net().ai.push({ during: () => gate });
    const id = await enqueueJob(env.DB, '5', { kind: 'reply', mode: 'chat', text: 'Slowly' });
    const stub = desk(env, '5');
    const done = stub.process('5');
    await until(id, 'running');
    await new Promise((resolve) => setTimeout(resolve, 20));
    const armed = await runInDurableObject(stub, (_, state) => state.storage.getAlarm());
    expect(armed).toBeGreaterThanOrEqual(Date.now() + 4 * MIN);
    release();
    await done;
    expect(await runInDurableObject(stub, (_, state) => state.storage.getAlarm())).toBeNull();
  });

  // spec: add-pet › Thought queue data › параллельные запросы ждут очереди × перезагрузка посреди мысли
  it('sweeps the orphan by that alarm, with no page open', async () => {
    h.net().contract.addPet('5', OWNER);
    const dead = await enqueueJob(env.DB, '5', { kind: 'reply', mode: 'chat', text: 'First' });
    await env.DB.prepare("UPDATE jobs SET status = 'running', created_at = ? WHERE id = ?").bind(Date.now() - 6 * MIN, dead).run();
    const stub = desk(env, '5');
    await stub.arm('5');
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect((await job(dead))!.status).toBe('failed');
  });

  // spec: add-pet › Return after absence flow › дневник без игрока
  it('does not let a dead desk hold a slot of the night\'s diary', async () => {
    vi.setSystemTime(new Date(Date.UTC(2036, 10, 2, 0, 10, 0)));
    for (let n = 0; n < 8; n += 1) {
      const id = String(100 + n);
      h.net().contract.addPet(id, OWNER);
      const j = await enqueueJob(env.DB, id, { kind: 'diary', day: 1 });
      await env.DB.prepare("UPDATE jobs SET status = 'running', created_at = ? WHERE id = ?").bind(Date.now() - 6 * MIN, j).run();
    }
    h.net().contract.addPet('5', OWNER);
    await env.DB.prepare("INSERT INTO pets (token_id, hatched_by, born_at, birth_tx) VALUES ('5', ?, 1, '')").bind(OWNER).run();
    await tick(env, Date.now());
    const rows = (await env.DB.prepare("SELECT token_id, status FROM jobs WHERE kind = 'diary' AND token_id = '5'").all<{ status: string }>()).results;
    expect(rows).toHaveLength(1);
  });
});
