import { env } from 'cloudflare:workers';
import { evictDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { api, harness } from './helpers/api';
import { NEAR_ACCOUNT, token } from './helpers/network';
import { publicVisits } from '../src/pet/publicVisits';

const h = harness();
const owner = NEAR_ACCOUNT(41);
const oneMinute = 60_000;

async function born(id: string) {
  await env.DB.prepare('INSERT INTO pets (token_id, hatched_by, born_at, birth_tx) VALUES (?, ?, ?, ?)')
    .bind(id, owner, Date.now(), 'test-birth').run();
}

describe('Showcase data', () => {
  // spec: add-account › Showcase data › one copy for everyone
  it('starts sampled pet reads together and keeps the sample order when they finish', async () => {
    const pets = new Map<string, ReturnType<ReturnType<typeof h.net>['contract']['addPet']>>();
    for (const id of ['711', '712', '713']) {
      pets.set(id, h.net().contract.addPet(id, owner, { name: `Pet ${id}` }));
      await born(id);
    }
    const started: string[] = [];
    const release = new Map<string, () => void>();
    let released = false;
    const visitEnv = {
      ...env,
      GUEST_VIEW: {
        idFromName: (name: string) => name,
        get: (name: string) => ({
          readPet: (id: string) => {
            expect(name).toBe(`pet:${id}`);
            started.push(id);
            const copy = { ok: true as const, value: pets.get(id)! };
            if (released) return Promise.resolve(copy);
            return new Promise<typeof copy>((resolve) => { release.set(id, () => resolve(copy)); });
          },
        }),
      },
    } as unknown as Env;
    const pending = publicVisits(visitEnv);
    try {
      await vi.waitFor(() => expect(started).toHaveLength(3));
    } finally {
      released = true;
      for (const id of [...started].reverse()) release.get(id)?.();
    }
    const visits = await pending;
    expect(visits?.map(({ tokenId, name }) => [tokenId, name]))
      .toEqual(started.map((id) => [id, `Pet ${id}`]));
  });

  // spec: add-account › Showcase data › one copy for everyone
  // spec: add-account › Showcase data › one copy for everyone × simultaneous visitors / reload
  it('shares one public pet and totals read across simultaneous visitors and an object restart', async () => {
    const pet = h.net().contract.addPet('701', owner, { name: 'Juniper', stage: 'Teen', outfits: [1] });
    h.net().contract.showcaseNumbers = { pets_hatched: 7, thoughts_paid: 12, spent: '1230000000000000000000000' };
    await born('701');
    await env.DB.prepare("INSERT INTO wardrobe (token_id, worn, seen) VALUES ('701', 'cozy-scarf', 0)").run();
    const stub = env.SHOWCASE.getByName('stage14-concurrent');
    const [first, second] = await Promise.all([stub.read(), stub.read()]);
    expect(first).toEqual(second);
    expect(first).toEqual({ pets: [{ tokenId: '701', name: 'Juniper', stage: 'teen', fullness: 'full', worn: 'cozy-scarf' }],
      numbers: h.net().contract.showcaseNumbers });
    expect(JSON.stringify(first)).not.toMatch(/owner|memory|character|instruction|hatched_by/);
    expect(h.net().contract.reads.filter((read) => read.method === 'showcase_view')).toHaveLength(1);
    expect(h.net().contract.reads.filter((read) => read.method === 'pet_view')).toHaveLength(1);
    pet.name = 'Changed';
    await evictDurableObject(stub);
    expect(await stub.read()).toEqual(first);
    expect(h.net().contract.reads.filter((read) => read.method === 'showcase_view')).toHaveLength(1);
    vi.setSystemTime(Date.now() + oneMinute - 1);
    expect(await stub.read()).toEqual(first);
    vi.setSystemTime(Date.now() + 1);
    expect((await stub.read())?.pets[0]?.name).toBe('Changed');
    expect(h.net().contract.reads.filter((read) => read.method === 'showcase_view')).toHaveLength(2);
  });

  // spec: add-account › Showcase data › NEAR can't be read
  // spec: add-account › Showcase data › NEAR can't be read × stale refresh / tab returns
  it('keeps the last copy through failed reads at exactly ten minutes, then returns none', async () => {
    h.net().contract.addPet('702', owner);
    await born('702');
    const stub = env.SHOWCASE.getByName('stage14-stale');
    const first = await stub.read();
    vi.setSystemTime(Date.now() + oneMinute);
    h.net().contract.failingViews.add('showcase_view');
    expect(await stub.read()).toEqual(first);
    const readsAfterFailure = h.net().contract.reads.length;
    expect(await stub.read()).toEqual(first);
    expect(h.net().contract.reads).toHaveLength(readsAfterFailure);
    vi.setSystemTime(Date.now() + 9 * oneMinute);
    expect(await stub.read()).toEqual(first);
    vi.setSystemTime(Date.now() + 1);
    expect(await stub.read()).toBeNull();
  });

  // spec: add-account › Showcase data › NEAR can't be read
  it('uses the same stale copy when D1 cannot supply the hatched-pet sample', async () => {
    h.net().contract.addPet('704', owner);
    await born('704');
    const stub = env.SHOWCASE.getByName('stage14-d1-failure');
    const first = await stub.read();
    vi.setSystemTime(Date.now() + oneMinute);
    await env.DB.exec('ALTER TABLE pets RENAME TO pets_stage14_hold');
    try {
      expect(await stub.read()).toEqual(first);
      expect(h.logs()).toContain('showcase_unavailable');
    } finally {
      await env.DB.exec('ALTER TABLE pets_stage14_hold RENAME TO pets');
    }
  });

  // spec: add-account › Showcase data › no pet yet
  it('returns no pets and no numbers without reading any private data', async () => {
    const stub = env.SHOWCASE.getByName('stage14-empty');
    expect(await stub.read()).toBeNull();
    expect(h.net().contract.reads).toEqual([{ method: 'showcase_view', args: {} }]);
  });

  // spec: add-account › Showcase data › one copy for everyone
  it('has a public route with one copy for a guest and a signed-in player, no event, and an IP limit', async () => {
    const ip = '198.51.100.71';
    expect(await api('/api/showcase', { ip })).toEqual({ status: 200, body: { pets: [], numbers: null } });
    h.net().contract.addPet('703', owner);
    await born('703');
    vi.setSystemTime(Date.now() + oneMinute);
    const guest = await api('/api/showcase', { ip });
    const signed = await api('/api/showcase', { ip, token: await token('did:privy:showcase', owner) });
    expect(guest.status).toBe(200);
    expect(signed).toEqual(guest);
    expect(h.events()).toEqual([]);
    expect(h.net().fetched).not.toContain(env.PRIVY_JWKS_URL);
    const limiter = env.LIMITER.getByName(`ip:${ip}`);
    for (let n = 2; n < 120; n += 1) await limiter.hit(Math.floor(Date.now() / oneMinute), 120);
    expect(await api('/api/showcase', { ip })).toEqual({ status: 429, body: { code: 'rate_limited' } });
  });
});

describe('Shared job close recovery data', () => {
  it('reserves only the signed word-free close state for an unsettled job', async () => {
    await env.DB.prepare('INSERT INTO shared_job_close_recovery (token_id, job_hash, approval, close_state) VALUES (?, ?, ?, ?)')
      .bind('7', 'a'.repeat(64), new Uint8Array([1, 2, 3]), 'pending').run();
    const row = await env.DB.prepare('SELECT * FROM shared_job_close_recovery').first();
    expect(Object.keys(row ?? {}).sort()).toEqual(['approval', 'attempts', 'close_state', 'job_hash', 'retry_at', 'token_id']);
    expect(JSON.stringify(row)).not.toMatch(/owner|name|word|link|contributor|report/);
  });
});
