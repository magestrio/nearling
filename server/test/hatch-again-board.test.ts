import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { api, harness } from './helpers/api';
import { NEAR_ACCOUNT, token } from './helpers/network';

const h = harness();
const FORMER = NEAR_ACCOUNT(71);

describe('known links do not grant owner actions', () => {
  // spec: add-hatch-again › Repeat ownership data › prior owner reads old memory
  // spec: add-hatch-again › Petless discovery flow › advice attempted without a pet
  it('refuses old memory and paid advice before storing a question or payment', async () => {
    h.net().contract.addPet('7', NEAR_ACCOUNT(72), { name: 'Pixel' });
    h.net().contract.addPet('8', NEAR_ACCOUNT(73), { name: 'Worker' });
    await env.DB.prepare("INSERT INTO known_pets (account_id, token_id, reason, interacted_at) VALUES (?, '7', 'gift', 1)").bind(FORMER).run();
    const tk = await token('did:privy:former', FORMER);
    expect((await api('/api/me', { token: tk })).body.knownPets).toMatchObject([{ tokenId: '7', name: 'Pixel' }]);
    expect(await api('/api/pets/7/conversation', { token: tk })).toEqual({ status: 403, body: { error: 'former_owner' } });
    const sent = await api('/api/pets/8/advice', { token: tk, body: { payer: '7', text: 'Private question', price: '1000000000000000000000' } });
    expect(sent).toMatchObject({ status: 403, body: { code: 'not_payer' } });
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM jobs').first())).toEqual({ n: 0 });
    expect(h.net().ai.calls).toHaveLength(0);
  });
});

describe('petless board and advice', () => {
  // spec: add-hatch-again › Petless discovery flow › board opened
  it('keeps board browsing public and reports current petlessness to the signed-in player', async () => {
    h.net().contract.addPet('8', NEAR_ACCOUNT(73), { name: 'Worker' });
    const tk = await token('did:privy:former', FORMER);
    const guest = await api('/api/hire');
    const player = await api('/api/hire', { token: tk });
    expect(guest.status).toBe(200);
    expect(guest.body).not.toHaveProperty('hasOwnedPet');
    expect(player).toMatchObject({ status: 200, body: { hasOwnedPet: false } });
    h.net().contract.addPet('9', FORMER);
    expect((await api('/api/hire', { token: tk })).body.hasOwnedPet).toBe(true);
  });

  // spec: add-hatch-again › Petless discovery flow › advice attempted without a pet
  it('refuses a petless advice POST before its question is parsed or any payment is queued', async () => {
    h.net().contract.addPet('8', NEAR_ACCOUNT(73), { name: 'Worker' });
    const tk = await token('did:privy:former', FORMER);
    const response = await api('/api/pets/8/advice', { token: tk,
      body: { payer: '7', text: 'Private question', price: '1000000000000000000000' } });
    expect(response).toEqual({ status: 403, body: { code: 'not_payer' } });
    expect(h.net().contract.reads.map((read) => read.method)).toEqual(['nft_supply_for_owner']);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM jobs').first()).toEqual({ n: 0 });
    expect(JSON.stringify([h.events(), h.logs()])).not.toContain('Private question');
  });
});
