import { env } from 'cloudflare:workers';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { HIRE_FEE_MIN_YOCTO, HIRE_FEE_STEP_YOCTO } from '../src/pricing';
import { loadBoardFacts } from '../src/work/boardFacts';
import { hireRoutes } from '../src/routes/hire';
import type { AppEnv } from '../src/http';
import { setPause, clearPause } from '../src/servicePause';
import { api, harness } from './helpers/api';
import { NEAR_ACCOUNT, token } from './helpers/network';

const h = harness();
const OWNER = NEAR_ACCOUNT(41);
const OTHER = NEAR_ACCOUNT(42);
const board = (path = '/api/hire', tk?: string) => api(path, { token: tk });
const day = () => Math.floor(Date.now() / 86_400_000);

async function skill(id: string, label: string) {
  await env.DB.prepare('INSERT INTO skills (token_id, label, ct, iv, updated_at) VALUES (?, ?, ?, ?, ?)')
    .bind(id, label, new Uint8Array([1, 2, 3]), new Uint8Array(12), Date.now()).run();
}
async function born(id: string) {
  await env.DB.prepare('INSERT INTO pets (token_id, hatched_by, born_at, birth_tx) VALUES (?, ?, ?, ?)')
    .bind(id, OWNER, Date.now(), 'test-birth').run();
}

describe('Hire board data', () => {
  // spec: add-pet-work › Hire board data › public board read
  it('bulk loads 125 skilled pets with their day, energy and unpaid-food facts', async () => {
    for (let i = 1; i <= 125; i += 1) {
      const id = String(i);
      h.net().contract.addPet(id, OWNER, { name: `Pet ${i}` });
      await skill(id, `Skill ${i}`);
    }
    await env.DB.prepare('INSERT INTO worker_answers (token_id, day, n, held) VALUES (?, ?, 2, 1)').bind('5', day()).run();
    await env.DB.prepare('INSERT INTO pet_life (token_id, energy_day, energy_used) VALUES (?, ?, 4)').bind('5', day()).run();
    await env.DB.prepare("INSERT INTO thoughts (id, token_id, created_at, kind, model, price_yocto, price_usd_micros, payer, status) VALUES ('board-unpaid', '5', 1, 'reply', 'test', '100', 0, 'pet', 'unbilled')").run();
    await env.DB.prepare("INSERT INTO thoughts (id, token_id, created_at, kind, model, price_yocto, price_usd_micros, payer, status) VALUES ('board-hired', '5', 2, 'hire_answer', 'test', '200', 0, 'pet', 'unbilled')").run();
    await env.DB.prepare("INSERT INTO hires (id, hirer_id, worker_id, worker_name, kind, fee_yocto, fee_usd_micros, answer_thought_id, status, created_at) VALUES ('board-hire', '5', '6', 'Pet 6', 'player', '300', 0, 'board-hired', 'unbilled', 2)").run();
    let statements = 0;
    const counted = { prepare(sql: string) { statements += 1; return env.DB.prepare(sql); } } as D1Database;
    const facts = await loadBoardFacts(counted, day());
    expect(statements).toBeLessThanOrEqual(3);
    expect(facts.size).toBe(125);
    expect(facts.get('5')).toMatchObject({ count: 3, energyDay: day(), energyUsed: 4, unbilled: 400n });
    expect(facts.get('5')?.opaqueId).toMatch(/^[a-f0-9]{32}$/);
    // Run the real route under a small D1 statement budget. The former per-card route
    // exhausted this budget before the third pet, regardless of the local D1 emulator's limit.
    let routeStatements = 0;
    const limitedDb = { prepare(sql: string) {
      if (++routeStatements > 12) throw new Error('D1 statement budget exceeded');
      return env.DB.prepare(sql);
    } } as D1Database;
    const limitedEnv = new Proxy(env, { get(target, key) { return key === 'DB' ? limitedDb : Reflect.get(target, key); } });
    const direct = new Hono<AppEnv>();
    direct.use('/api/*', async (c, next) => { c.set('session', null); await next(); });
    direct.route('/', hireRoutes);
    const response = await direct.fetch(new Request('https://game.test/api/hire'), limitedEnv);
    expect(response.status).toBe(200);
    expect(routeStatements).toBeLessThanOrEqual(12);
    const result = await response.json() as { pets: { tokenId: string; price: { yocto: string }; status: string }[] };
    expect(result.pets).toHaveLength(125);
    expect(result.pets.find((pet) => pet.tokenId === '5')).toMatchObject({
      price: { yocto: (HIRE_FEE_MIN_YOCTO + 3n * HIRE_FEE_STEP_YOCTO).toString() }, status: 'available',
    });
    expect(h.net().contract.sends).toEqual([]);
  }, 30_000);

  // spec: add-pet-work › Hire board data › public board read
  it('lists old saved skills with stable independent opaque ids, including after a gift, with no private fields or chain write', async () => {
    const first = h.net().contract.addPet('5', OWNER, { name: 'Nori' });
    h.net().contract.addPet('6', OTHER, { name: 'Juno' });
    await skill('5', 'Copywriting');
    await skill('6', 'Puzzles');
    const one = await board();
    expect(one.status).toBe(200);
    expect(one.body.visits).toEqual([]);
    expect(one.body.pets).toHaveLength(2);
    expect(one.body.pets[0]).toMatchObject({ tokenId: '5', name: 'Nori', label: 'Copywriting', status: 'available', yours: false,
      price: { yocto: HIRE_FEE_MIN_YOCTO.toString() } });
    const ids = one.body.pets.map((pet: { opaqueId: string }) => pet.opaqueId);
    expect(ids[0]).toMatch(/^[a-f0-9]{32}$/);
    expect(ids[0]).not.toBe(ids[1]);
    expect((await board()).body.pets.map((pet: { opaqueId: string }) => pet.opaqueId)).toEqual(ids);
    first.owner_id = OTHER;
    expect((await board()).body.pets[0].opaqueId).toBe(ids[0]);
    expect((await board('/api/hire', await token('did:privy:other-board', OTHER))).body.pets[0].yours).toBe(true);
    const serialized = JSON.stringify(one.body);
    expect(serialized).not.toMatch(/owner_id|character|instruction|ciphertext|"ct"|"iv"|source|code|length/i);
    expect(serialized).not.toContain(OWNER);
    expect(h.net().contract.sends).toEqual([]);
    expect(h.net().contract.known.size).toBe(0);
  });

  // spec: add-pet-work › Hire board data › public board read
  it('gives a completed mint its id before the board reads it', async () => {
    const tk = await token('did:privy:hatch-board', OWNER);
    const minted = await api('/api/hatch', { token: tk, body: { name: 'Biscuit' } });
    expect(minted.status).toBe(200);
    const id = minted.body.tokenId as string;
    const before = await env.DB.prepare('SELECT opaque_id FROM pet_public_ids WHERE token_id = ?').bind(id).first<{ opaque_id: string }>();
    expect(before?.opaque_id).toMatch(/^[a-f0-9]{32}$/);
    await skill(id, 'Storytelling');
    expect((await board()).body.pets[0].opaqueId).toBe(before?.opaque_id);
  });

  // spec: add-pet-work › Hire board data › public board read
  it('takes empty-board visits from real hatched pets only and never exposes their owners or memory', async () => {
    expect((await board()).body).toEqual({ pets: [], visits: [] });
    h.net().contract.addPet('5', OWNER, { name: 'Juniper', stage: 'Adult' });
    h.net().contract.addPet('6', OTHER, { name: 'Lumen', stage: 'Teen' });
    await born('5');
    expect((await board()).body.visits).toEqual([{ tokenId: '5', name: 'Juniper', stage: 'adult', fullness: 'full', worn: null }]);
    await born('6');
    const visits = (await board()).body.visits;
    expect(visits.map((pet: { tokenId: string }) => pet.tokenId).sort()).toEqual(['5', '6']);
    expect(JSON.stringify(visits)).not.toMatch(/owner|memory|character|instruction|ciphertext|hatched_by/);
  });

  // spec: add-pet-work › Hire board data › skill removed
  it('removes a forgotten skill from the next derived read without a copied index', async () => {
    h.net().contract.addPet('5', OWNER);
    await skill('5', 'Baking');
    expect((await board()).body.pets).toHaveLength(1);
    await env.DB.prepare('DELETE FROM skills WHERE token_id = ?').bind('5').run();
    expect((await board()).body).toEqual({ pets: [], visits: [] });
  });

  // spec: add-pet-work › Hire board data › quote or availability changed
  // spec: add-pet-work › Hire board data › quote or availability changed × worker hired
  // spec: add-pet-work › Hire board data › quote or availability changed × worker fed
  // spec: add-pet-work › Hire board data › quote or availability changed × energy spent
  // spec: add-pet-work › Hire board data › quote or availability changed × ten works
  // spec: add-pet-work › Hire board data › quote or availability changed × 00:00 UTC
  it('refreshes quote and status, with a chain copy no older than 15 seconds', async () => {
    const pet = h.net().contract.addPet('5', OWNER);
    await skill('5', 'Baking');
    expect((await board()).body.pets[0].status).toBe('available');
    await env.DB.prepare('INSERT INTO worker_answers (token_id, day, n) VALUES (?, ?, 1)').bind('5', day()).run();
    expect((await board()).body.pets[0].price.yocto).toBe((HIRE_FEE_MIN_YOCTO + HIRE_FEE_STEP_YOCTO).toString());
    pet.project_food = '0';
    expect((await board()).body.pets[0].status).toBe('available'); // the current 15-second copy
    vi.setSystemTime(Date.now() + 15_001);
    expect((await board()).body.pets[0].status).toBe('asleep');
    pet.project_food = env.STARTER_FOOD;
    vi.setSystemTime(Date.now() + 15_001);
    expect((await board()).body.pets[0].status).toBe('available');
    await env.DB.prepare('INSERT INTO pet_life (token_id, energy_day, energy_used) VALUES (?, ?, 10)').bind('5', day()).run();
    expect((await board()).body.pets[0].status).toBe('resting');
    await env.DB.prepare('UPDATE pet_life SET energy_used = 0 WHERE token_id = ?').bind('5').run();
    pet.jobs_today = 10;
    vi.setSystemTime(Date.now() + 15_001);
    expect((await board()).body.pets[0].status).toBe('resting');
    vi.setSystemTime(new Date((day() + 1) * 86_400_000 + 1000));
    pet.jobs_today = 0;
    expect((await board()).body.pets[0]).toMatchObject({ status: 'available', price: { yocto: HIRE_FEE_MIN_YOCTO.toString() } });
  });

  // spec: add-pet-work › Hire board data › quote or availability changed
  it('gives service pause precedence and refuses a failed chain read without guessing a price', async () => {
    h.net().contract.addPet('52', OWNER, { project_food: '0', jobs_today: 10 });
    await skill('52', 'Baking');
    await setPause(env.DB, 'ai', Date.now());
    expect((await board()).body.pets[0].status).toBe('paused');
    await clearPause(env.DB);
    expect((await board()).body.pets[0].status).toBe('asleep');
    h.net().contract.down = true;
    vi.setSystemTime(Date.now() + 15_001);
    expect(await board()).toEqual({ status: 503, body: { code: 'chain_unreachable' } });
  });

  // spec: add-pet-work › Hire board data › public board read
  // 242 sequential requests traverse the full Worker harness; allow for contention during the full verification run.
  it('keeps label search words out of the Worker and uses the public gate for visitor and player', { timeout: 30_000 }, async () => {
    h.net().contract.addPet('5', OWNER);
    await skill('5', 'Baking');
    const guest = await board('/api/hire?q=secret-search-words');
    expect(guest.status).toBe(200);
    expect(JSON.stringify(guest.body)).not.toContain('secret-search-words');
    expect(h.logs().join(' ')).not.toContain('secret-search-words');
    for (let i = 1; i < 120; i += 1) expect((await board()).status).toBe(200);
    expect((await board()).status).toBe(429);
    const tk = await token('did:privy:board-player', OTHER);
    for (let i = 0; i < 120; i += 1) expect((await board('/api/hire', tk)).status).toBe(200);
    expect((await board('/api/hire', tk)).status).toBe(429);
  });
});
