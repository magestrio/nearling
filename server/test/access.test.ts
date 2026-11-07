import { describe, expect, it } from 'vitest';
import { api, harness } from './helpers/api';
import { NEAR_ACCOUNT, token } from './helpers/network';

const h = harness();
const OWNER = NEAR_ACCOUNT(1);
const OTHER = NEAR_ACCOUNT(2);

const petReads = () => h.net().contract.reads.filter((r) => r.method === 'pet_view').length;

describe('Conversation access data', () => {
  // spec: add-pet › Conversation access data › чужой питомец
  it('shows a signed-in player who is not the owner the guest view and nothing of the owner', async () => {
    h.net().contract.addPet('9', OWNER, { wish_reserve: '123', wish_active: true });
    const res = await api('/api/pets/9', { token: await token('did:privy:other', OTHER) });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      viewer: 'guest',
      tokenId: '9',
      name: 'Pixel',
      stage: 'baby',
      fullness: { state: 'full', level: 1 },
      // the face of the day goes to every viewer (`add-pet-life` › `Pet life display rule` › «гость»)
      mood: 'calm',
      // the viewer's own meal on its way: nothing of the owner's (`add-feeding` › `Feeding transaction data`)
      myFeed: null,
      // the worn item goes to every viewer (`add-wardrobe` › `Outfit rule`), the other outfit fields do not
      worn: null,
      // the label of the skill goes to every viewer (`add-pet-work` › `Skill rule` › «label on the pet's page»)
      skill: null,
      // spec: add-pet-errands › Watch target data › viewer reads the target
      watch: null,
    });
    // The owner-only fields are not in the answer, and the conversation route does not exist for them yet.
    // spec: add-pet-will › Wish state data › diary input
    // The public reserve remains readable through pet_view; the guest Pet page has no reserve surface.
    for (const field of ['tired', 'paused', 'hello', 'ownedCount', 'pendingJob', 'pendingMode', 'events', 'traits', 'energy', 'outfits', 'notices', 'outfitPrice', 'wish', 'wishActive', 'wishReserveYocto', 'willActivity']) expect(res.body).not.toHaveProperty(field);
  });

  // spec: add-pet › Conversation access data › чужой питомец
  it('gives the owner the owner view', async () => {
    h.net().contract.addPet('9', OWNER, { wish_reserve: '123', wish_active: true });
    const res = await api('/api/pets/9', { token: await token('did:privy:owner', OWNER) });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ viewer: 'owner', tokenId: '9', name: 'Pixel', tired: false, paused: false, hello: true, ownedCount: 1,
      wishReserveYocto: '123', wishActive: true });
  });

  // spec: add-pet › Conversation access data › чужой питомец
  it('reads the owner from the contract at every request: after a gift the old owner is a guest at once', async () => {
    const chain = h.net().contract;
    chain.addPet('9', OWNER);
    const first = await api('/api/pets/9', { token: await token('did:privy:owner', OWNER) });
    expect(first.body.viewer).toBe('owner');
    expect(petReads()).toBe(1);

    chain.pets.get('9')!.owner_id = OTHER; // the pet is given away
    const second = await api('/api/pets/9', { token: await token('did:privy:owner', OWNER) });
    expect(second.body.viewer).toBe('guest');
    expect(petReads()).toBe(2); // two requests, two reads: no copy in between
  });

  // spec: add-pet › Conversation access data › чужой питомец
  it('serves and accepts nothing while the network cannot be read', async () => {
    const chain = h.net().contract;
    chain.addPet('9', OWNER);
    chain.down = true;
    const signedIn = await api('/api/pets/9', { token: await token('did:privy:owner', OWNER) });
    expect(signedIn.status).toBe(503);
    expect(signedIn.body).toEqual({ code: 'chain_unreachable' });
    const visitor = await api('/api/pets/9');
    expect(visitor.status).toBe(503);
    expect(visitor.body).toEqual({ code: 'chain_unreachable' });
    // Nothing reached NEAR AI: the only hosts fetched are the RPC and Privy's key set.
    expect(h.net().fetched.every((u) => u.startsWith('https://test.rpc.fastnear.com') || u === 'https://privy.test/jwks.json')).toBe(true);
  });

  // spec: add-pet › Conversation access data › чужой питомец
  it('shows a visitor with no session only the pet, the name, the stage and the fullness, from the shared copy', async () => {
    h.net().contract.addPet('9', OWNER, { wish_reserve: '123', wish_active: true });
    const first = await api('/api/pets/9');
    expect(first.body).toEqual({ viewer: 'visitor', tokenId: '9', name: 'Pixel', stage: 'baby', fullness: { state: 'full', level: 1 }, mood: 'calm', worn: null, skill: null, watch: null });
    // spec: add-pet-will › Wish state data › diary input
    for (const field of ['wish', 'wishActive', 'wishReserveYocto', 'willActivity']) expect(first.body).not.toHaveProperty(field);
    // The second visitor within 15 s is served from the copy: the network is not read again.
    await api('/api/pets/9');
    await api('/api/pets/9');
    expect(petReads()).toBe(1);
  });

  // spec: add-pet › Conversation access data › чужой питомец
  it('answers 404 for a pet that does not exist and for an id that is not a token id, without a network read', async () => {
    const missing = await api('/api/pets/77', { token: await token('did:privy:owner', OWNER) });
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ code: 'no_pet' });
    const junk = await api('/api/pets/abc');
    expect(junk.status).toBe(404);
    expect(petReads()).toBe(1);
  });

  // spec: add-pet › Conversation access data › чужой питомец
  it('answers 401 signed_out to a token that does not verify (a wrong audience, an expired token)', async () => {
    h.net().contract.addPet('9', OWNER);
    const wrongAudience = await api('/api/pets/9', { token: await token('did:privy:owner', OWNER, { audience: 'someone-else' }) });
    expect(wrongAudience.status).toBe(401);
    expect(wrongAudience.body).toEqual({ code: 'signed_out' });
    const expired = await api('/api/pets/9', { token: await token('did:privy:owner', OWNER, { expiresIn: '-1m' }) });
    expect(expired.status).toBe(401);
    const garbage = await api('/api/pets/9', { token: 'not-a-jwt' });
    expect(garbage.status).toBe(401);
    expect(petReads()).toBe(0);
  });
});

describe('GET /api/me', () => {
  // spec: add-pet › Conversation access data › чужой питомец
  it('says which pet the player hatched, which they have now and how many they own', async () => {
    const chain = h.net().contract;
    chain.addPet('4', OWNER, { name: 'Biscuit' });
    chain.hatchedBy.set(OWNER, '4');
    const own = await api('/api/me', { token: await token('did:privy:owner', OWNER) });
    expect(own.body).toEqual({ accountId: OWNER, hatched: { tokenId: '4', name: 'Biscuit' }, currentPet: { tokenId: '4', name: 'Biscuit' }, ownedCount: 1 });

    chain.pets.get('4')!.owner_id = OTHER; // given away
    const gone = await api('/api/me', { token: await token('did:privy:owner', OWNER) });
    expect(gone.body).toEqual({ accountId: OWNER, hatched: { tokenId: '4', name: 'Biscuit' }, currentPet: null, ownedCount: 0 });

    const stranger = await api('/api/me', { token: await token('did:privy:nobody', NEAR_ACCOUNT(3)) });
    expect(stranger.body).toEqual({ accountId: NEAR_ACCOUNT(3), hatched: null, currentPet: null, ownedCount: 0 });

    expect((await api('/api/me')).status).toBe(401);
  });
});
