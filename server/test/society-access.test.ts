import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { api, harness } from './helpers/api';
import { NEAR_ACCOUNT, token } from './helpers/network';

const h = harness();
const first = NEAR_ACCOUNT(710);
const second = NEAR_ACCOUNT(711);
const path = '/api/pets/710/relationships';

async function seeded() {
  const subject = h.net().contract.addPet('710', first, { name: 'Pixel' });
  h.net().contract.addPet('711', second, { name: 'Biscuit' });
  await env.DB.prepare("INSERT INTO society_relations (token_id, other_id, stance, created_at) VALUES ('710', '711', 'liked', 1)").run();
  return subject;
}

describe('Society relationship data', () => {
  // spec: add-pet-society › Society relationship data › owner read
  it('returns only the current owner’s named directed stances after a fresh chain read', async () => {
    await seeded();
    const res = await api(path, { token: await token('did:privy:society-owner', first) });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ tokenId: '710', name: 'Pixel', relationships: [
      { tokenId: '711', name: 'Biscuit', stance: 'liked', breakUntil: null },
    ] });
    expect(h.net().contract.reads.filter((read) => read.method === 'pet_view').map((read) => read.args.token_id))
      .toEqual(['710', '711', '710']);
  });

  // spec: add-pet-society › Society relationship data › visitor read
  it('returns no private row to a visitor or a signed-in non-owner', async () => {
    await seeded();
    expect((await api(path)).status).toBe(401);
    const res = await api(path, { token: await token('did:privy:society-visitor', second) });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ code: 'not_owner' });
    expect((await api('/api/pets/710')).status).toBe(200);
    expect(h.net().contract.reads.filter((read) => read.method === 'pet_view' && read.args.token_id === '711'))
      .toEqual([]);
  });

  // spec: add-pet-society › Society relationship data › ownership unavailable
  it('fails closed when the contract owner cannot be read', async () => {
    await seeded();
    const tk = await token('did:privy:society-unavailable', first);
    h.net().contract.down = true;
    expect(await api(path, { token: tk })).toEqual({ status: 503, body: { code: 'chain_unreachable' } });
    h.net().contract.down = false;
    h.net().contract.failingViews.add('pet_view');
    expect(await api(path, { token: tk })).toEqual({ status: 503, body: { code: 'chain_unreachable' } });
  });

  // spec: add-pet-society › Society relationship data › owner read × open/retry/reload
  it('checks chain ownership anew on each summary read', async () => {
    const pet = await seeded();
    const tk = await token('did:privy:society-reload', first);
    expect((await api(path, { token: tk })).status).toBe(200);
    pet.owner_id = second;
    pet.transfer_generation += 1;
    expect(await api(path, { token: tk })).toEqual({ status: 403, body: { code: 'not_owner' } });
  });
});
