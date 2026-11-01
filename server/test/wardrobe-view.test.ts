// What the views of a pet say about its wardrobe (`add-wardrobe` › group 3.2): the owner gets the
// items, the worn one, the notices not yet shown and the price; a guest and a visitor get the worn
// item and nothing else.
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { api, harness } from './helpers/api';
import { NEAR_ACCOUNT, token } from './helpers/network';

const h = harness();
const OWNER = NEAR_ACCOUNT(1);
const OTHER = NEAR_ACCOUNT(2);
const owner = () => token('did:privy:owner', OWNER);
const other = () => token('did:privy:other', OTHER);
const wear = (slug: string | null, id = '5') => env.DB.prepare('INSERT OR REPLACE INTO wardrobe (token_id, worn, seen) VALUES (?, ?, COALESCE((SELECT seen FROM wardrobe WHERE token_id = ?), 0))').bind(id, slug, id).run();

describe('Outfit rule', () => {
  // spec: add-wardrobe › Outfit rule › надел × the guest's read
  it('gives a guest and a visitor the worn item and none of the owner\'s fields', async () => {
    h.net().contract.addPet('5', OWNER, { outfits: [0, 2] });
    await wear('thinking-cap');
    for (const res of [await api('/api/pets/5', { token: await other() }), await api('/api/pets/5')]) {
      expect(res.status).toBe(200);
      expect(res.body.worn).toBe('thinking-cap');
      for (const field of ['outfits', 'notices', 'outfitPrice']) expect(res.body, field).not.toHaveProperty(field);
    }
  });

  // spec: add-wardrobe › Outfit rule › надел × the guest's read
  it('reads the worn item from D1 on each request, so a change of clothes reaches a visitor at once', async () => {
    h.net().contract.addPet('5', OWNER, { outfits: [0, 2] });
    expect((await api('/api/pets/5')).body.worn).toBeNull();
    await wear('daisy-crown');
    expect((await api('/api/pets/5')).body.worn).toBe('daisy-crown');
    await wear(null);
    expect((await api('/api/pets/5')).body.worn).toBeNull();
  });
});

describe('Wardrobe screen', () => {
  // spec: add-wardrobe › Wardrobe screen › success × the view of the owner
  it('gives the owner the items in the catalogue\'s order, the worn one, the notices and the price in cents', async () => {
    h.net().contract.addPet('5', OWNER, { outfits: [0, 2, 5] });
    await wear('thinking-cap');
    for (const path of ['/api/pets/5', '/api/pets/5/state']) {
      const res = await api(path, { token: await owner() });
      expect(res.status, path).toBe(200);
      expect(res.body, path).toMatchObject({
        outfits: ['daisy-crown', 'thinking-cap', 'headphones'],
        worn: 'thinking-cap',
        // the two earned items, neither shown yet; a bought one has no notice
        notices: ['daisy-crown', 'thinking-cap'],
        outfitPrice: { cents: 0.76, yocto: env.OUTFIT_PRICE },
      });
    }
  });

  // spec: add-wardrobe › Wardrobe screen › success × the view of the owner
  it('gives a pet with no item and no row an empty wardrobe', async () => {
    h.net().contract.addPet('5', OWNER);
    const res = await api('/api/pets/5', { token: await owner() });
    expect(res.body).toMatchObject({ outfits: [], worn: null, notices: [] });
  });
});

describe('New outfit notice screen', () => {
  // spec: add-wardrobe › New outfit notice screen › success × a guest gets no notice
  it('never shows a notice to a guest or a visitor, and a notice shown is not due again', async () => {
    h.net().contract.addPet('5', OWNER, { outfits: [1] });
    expect((await api('/api/pets/5', { token: await other() })).body).not.toHaveProperty('notices');
    expect((await api('/api/pets/5')).body).not.toHaveProperty('notices');
    expect((await api('/api/pets/5', { token: await owner() })).body.notices).toEqual(['cozy-scarf']);
    await env.DB.prepare('INSERT INTO wardrobe (token_id, seen) VALUES (?, ?)').bind('5', 1 << 1).run();
    expect((await api('/api/pets/5', { token: await owner() })).body.notices).toEqual([]);
  });
});

describe('Wardrobe data', () => {
  // spec: add-wardrobe › Wardrobe data › после подарка × the new owner has the worn item and the notice
  it('goes with the pet: the new owner has the worn item and the notice not yet shown', async () => {
    h.net().contract.addPet('5', OWNER, { outfits: [0, 3] });
    await wear('smart-glasses');
    h.net().contract.pets.get('5')!.owner_id = OTHER;
    const gone = await api('/api/pets/5', { token: await owner() });
    expect(gone.body).toMatchObject({ viewer: 'guest', worn: 'smart-glasses' });
    expect(gone.body).not.toHaveProperty('notices');
    const now = await api('/api/pets/5', { token: await other() });
    expect(now.body).toMatchObject({ viewer: 'owner', worn: 'smart-glasses', outfits: ['daisy-crown', 'smart-glasses'], notices: ['daisy-crown'] });
  });
});
