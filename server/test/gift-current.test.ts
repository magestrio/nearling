import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { api, harness } from './helpers/api';
import { NEAR_ACCOUNT, token } from './helpers/network';

const h = harness();
const OWNER = NEAR_ACCOUNT(41);
const RECEIVER = NEAR_ACCOUNT(42);
const ownerToken = () => token('did:privy:gift-current-owner', OWNER);
const receiverToken = () => token('did:privy:gift-current-receiver', RECEIVER);

describe('current pet after a gift', () => {
  // spec: add-gift › Several pets rule › текущий
  it('paginates every owned token and makes an opened pet current', async () => {
    const chain = h.net().contract;
    for (let i = 1; i <= 53; i++) chain.addPet(String(i), OWNER, { name: `Pet ${String(i).padStart(2, '0')}` });
    chain.hatchedBy.set(OWNER, '2');
    const tk = await ownerToken();
    const list = await api('/api/me/pets', { token: tk });
    expect(list.status).toBe(200);
    expect(list.body.pets).toHaveLength(53);
    expect(list.body.pets[0]).toMatchObject({ tokenId: '2', born: true });
    expect((await env.DB.prepare('SELECT current_pet FROM players WHERE account_id = ?').bind(OWNER).first<{ current_pet: string }>())?.current_pet).toBe('2');
    expect(chain.reads.filter((r) => r.method === 'nft_tokens_for_owner').map((r) => r.args.from_index)).toEqual(['0', '50']);
    expect((await api('/api/pets/53', { token: tk })).body.viewer).toBe('owner');
    expect((await api('/api/me', { token: tk })).body.currentPet).toEqual({ tokenId: '53', name: 'Pet 53' });
    expect((await api('/api/me/pets', { token: tk })).body.currentPet.tokenId).toBe('53');
    chain.addPet('60', RECEIVER);
    expect((await api('/api/pets/60/advice', { token: tk, body: { payer: '1', text: 'What do you think?', price: '0' } })).body.code).toBe('not_payer');
  });

  // spec: add-gift › Several pets rule › текущий подарен
  it('falls back to the born pet, then name order and token id on a tie', async () => {
    const chain = h.net().contract;
    chain.addPet('70', OWNER, { name: 'Zulu' });
    chain.addPet('71', OWNER, { name: 'Alpha' });
    chain.addPet('72', OWNER, { name: 'Alpha' });
    chain.addPet('73', OWNER, { name: 'Alpha' });
    chain.hatchedBy.set(OWNER, '70');
    const tk = await ownerToken();
    await api('/api/pets/72', { token: tk });
    chain.pets.get('72')!.owner_id = RECEIVER;
    expect((await api('/api/me', { token: tk })).body.currentPet.tokenId).toBe('70');
    chain.pets.get('70')!.owner_id = RECEIVER;
    expect((await api('/api/me', { token: tk })).body.currentPet.tokenId).toBe('71');
  });

  // spec: add-gift › Several pets rule › питомцев не осталось
  it('returns the last gifted pet on sign-in and open or closed Hatch', async () => {
    const chain = h.net().contract;
    chain.addPet('80', RECEIVER, { name: 'Biscuit' });
    chain.hatchedBy.set(OWNER, '80');
    const tk = await ownerToken();
    await env.DB.prepare('UPDATE players SET last_gifted_pet = ? WHERE account_id = ?').bind('80', OWNER).run();
    expect((await api('/api/me', { token: tk })).body).toMatchObject({ ownedCount: 0, currentPet: null, lastGifted: { tokenId: '80', name: 'Biscuit' } });
    expect((await api('/api/hatch', { token: tk })).body).toMatchObject({ noPets: true, lastGifted: { tokenId: '80', name: 'Biscuit' } });
    chain.bornToday = 50;
    expect((await api('/api/hatch', { token: tk })).body).toMatchObject({ open: false, noPets: true, lastGifted: { tokenId: '80', name: 'Biscuit' } });
    const receiver = await receiverToken();
    expect((await api('/api/me', { token: receiver })).body.currentPet).toEqual({ tokenId: '80', name: 'Biscuit' });
  });
});
