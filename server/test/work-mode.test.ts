// The hire mode (`add-pet-work` › `Hire mode rule`): `PUT /api/pets/:id/hire-mode` and the owner's view of it.
// What a Manual pet does with an offer once it has made one is proved in `work-offer.test.ts`; its next turn is here.
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { api, harness, say } from './helpers/api';
import { NEAR_ACCOUNT, token } from './helpers/network';
import { addHirer, addWorker } from './helpers/work';

const h = harness();
const OWNER = NEAR_ACCOUNT(1);
const OTHER = NEAR_ACCOUNT(2);
const owner = () => token('did:privy:owner', OWNER);
const other = () => token('did:privy:other', OTHER);

const put = async (mode: unknown, tk?: string, id = '5') => api(`/api/pets/${id}/hire-mode`, { method: 'PUT', token: tk ?? (await owner()), body: { mode } });
const view = async (tk: string, id = '5') => (await api(`/api/pets/${id}`, { token: tk })).body;
const rows = () => env.DB.prepare("SELECT token_id, mode FROM hire_modes").all<{ token_id: string; mode: string }>().then((r) => r.results);

describe('Hire mode rule', () => {
  // spec: add-pet-work › Hire mode rule › Auto
  it('reads Auto for a new pet in both views of the owner, and switching back to Auto stores it and fires the event with mode auto', async () => {
    h.net().contract.addPet('5', OWNER);
    const tk = await owner();
    expect((await view(tk)).hireMode).toBe('auto');
    expect((await api('/api/pets/5/state', { token: tk })).body.hireMode).toBe('auto');
    expect(await rows()).toEqual([]);

    expect(await put('manual')).toMatchObject({ status: 200, body: { mode: 'manual' } });
    h.events().length = 0;
    expect(await put('auto')).toMatchObject({ status: 200, body: { mode: 'auto' } });
    expect((await view(tk)).hireMode).toBe('auto');
    expect(h.events()).toEqual([{ name: 'hire_mode_changed', props: { mode: 'auto' } }]);
  });

  // spec: add-pet-work › Hire mode rule › Ask me first
  it('stores Manual and reads it in the views, one event with mode manual, none for a repeat of the same mode', async () => {
    h.net().contract.addPet('5', OWNER);
    const tk = await owner();
    expect(await put('manual')).toMatchObject({ status: 200, body: { mode: 'manual' } });
    expect(h.events()).toEqual([{ name: 'hire_mode_changed', props: { mode: 'manual' } }]);
    expect((await view(tk)).hireMode).toBe('manual');
    expect((await api('/api/pets/5/state', { token: tk })).body.hireMode).toBe('manual');
    expect(await rows()).toEqual([{ token_id: '5', mode: 'manual' }]);
    // the same mode again is no switch
    h.events().length = 0;
    expect(await put('manual')).toMatchObject({ status: 200 });
    expect(h.events()).toEqual([]);
    expect(await rows()).toHaveLength(1);
  });

  // spec: add-pet-work › Hire mode rule › Ask me first
  it('turns away a guest with 403 and a call with no session or a bad mode, and writes nothing', async () => {
    h.net().contract.addPet('5', OWNER);
    expect(await put('manual', await other())).toMatchObject({ status: 403, body: { code: 'not_owner' } });
    expect(await api('/api/pets/5/hire-mode', { method: 'PUT', body: { mode: 'manual' } })).toMatchObject({ status: 401 });
    // a bad body without a session is still the missing session
    expect(await api('/api/pets/5/hire-mode', { method: 'PUT', body: { mode: 7 } })).toMatchObject({ status: 401 });
    for (const bad of ['', 'Manual', 'ask', null, 7]) expect(await put(bad)).toMatchObject({ status: 400, body: { code: 'bad_request' } });
    expect(await put('manual', undefined, '77')).toMatchObject({ status: 404, body: { code: 'no_pet' } });
    h.net().contract.down = true;
    expect(await put('manual')).toMatchObject({ status: 503, body: { code: 'chain_unreachable' } });
    expect(await rows()).toEqual([]);
    expect(h.events()).toEqual([]);
  });

  // spec: add-pet-work › Hire mode rule › Ask me first
  it('has no switch for a sleeping pet: 409 asleep, nothing written', async () => {
    h.net().contract.addPet('5', OWNER, { project_food: '0', given_food: '0' });
    expect(await put('manual')).toMatchObject({ status: 409, body: { code: 'asleep' } });
    expect(await rows()).toEqual([]);
    expect(h.events()).toEqual([]);
  });

  // spec: add-pet-work › Hire mode rule › Ask me first × gift
  it('belongs to the token id: a new owner reads the mode of the pet, and only the new owner can switch it', async () => {
    h.net().contract.addPet('5', OWNER);
    await put('manual');
    h.net().contract.pets.get('5')!.owner_id = OTHER;
    expect((await view(await other())).hireMode).toBe('manual');
    expect(await put('auto')).toMatchObject({ status: 403, body: { code: 'not_owner' } });
    expect(await put('auto', await other())).toMatchObject({ status: 200 });
    expect(await rows()).toEqual([{ token_id: '5', mode: 'auto' }]);
  });

  // spec: add-pet-work › Hire mode rule › Ask me first
  it('is read by the next turn only: a turn already running keeps the mode it began with, and the next one stops at an offer', async () => {
    addHirer(h);
    await addWorker(h, '6', 2);
    const tk = await owner();
    // the owner switches to Manual while the pet's turn is on its way: that turn is still Auto and hires
    h.net().ai.push({ content: 'ASK 1: How do I grow radishes?', during: async () => void (await put('manual')) }, { content: 'Plant them in spring.' }, { content: 'Spring.' });
    const first = await say(tk, '5', 'What should I plant?');
    expect(first.thought.text).toBe('Spring.');
    expect(await env.DB.prepare('SELECT mode FROM hires').all()).toMatchObject({ results: [{ mode: 'auto' }] });
    expect((await env.DB.prepare('SELECT 1 FROM hire_offers').all()).results).toEqual([]);

    // the next turn is Manual: the pet stops at an offer
    h.net().ai.push({ content: 'ASK 1: And when do I pick them?' });
    const second = await say(tk, '5', 'And then?');
    expect(second.code).toBe('offer');
    expect((await env.DB.prepare('SELECT worker_id FROM hire_offers').all()).results).toEqual([{ worker_id: '6' }]);
    expect(await env.DB.prepare('SELECT 1 FROM hires').all()).toMatchObject({ results: [expect.anything()] });
  });

  // spec: add-pet-work › Hire mode rule › Ask me first × memory cleared
  it('stays through a clear of the memory', async () => {
    h.net().contract.addPet('5', OWNER);
    const tk = await owner();
    await put('manual');
    expect(await api('/api/pets/5/memory/clear', { token: tk, method: 'POST' })).toMatchObject({ status: 200 });
    expect((await view(tk)).hireMode).toBe('manual');
    expect(await rows()).toEqual([{ token_id: '5', mode: 'manual' }]);
  });
});
