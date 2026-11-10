import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { api, harness } from './helpers/api';
import { NEAR_ACCOUNT, token } from './helpers/network';

const h = harness();
const PLAYER = NEAR_ACCOUNT(10);
const signed = () => token('did:privy:hatch-again-owner', PLAYER);

describe('current ownership and birth history', () => {
  // spec: add-hatch-again › Repeat ownership data › historical birth with no pet
  it('returns zero owned pets and the prior birth separately on Hatch and Home', async () => {
    h.net().contract.addPet('3', NEAR_ACCOUNT(20), { name: 'Pixel' });
    h.net().contract.hatchedBy.set(PLAYER, '3');
    const tk = await signed();
    expect((await api('/api/hatch', { token: tk })).body).toMatchObject({ open: true, ownedCount: 0, latestBirth: { tokenId: '3', name: 'Pixel' }, currentPet: null });
    expect((await api('/api/me', { token: tk })).body).toMatchObject({ ownedCount: 0, latestBirth: { tokenId: '3', name: 'Pixel' }, currentPet: null, birth: { open: true } });
  });

  // spec: add-hatch-again › Hatch again screen › already owns a pet
  it('shows a gifted-in pet as owned without a prior birth', async () => {
    h.net().contract.addPet('4', PLAYER, { name: 'Gifted' });
    const tk = await signed();
    expect((await api('/api/hatch', { token: tk })).body).toMatchObject({ ownedCount: 1, latestBirth: null, already: { tokenId: '4', name: 'Gifted' } });
    expect((await api('/api/me', { token: tk })).body).toMatchObject({ ownedCount: 1, latestBirth: null, currentPet: { tokenId: '4', name: 'Gifted' } });
  });

  // spec: add-hatch-again › Repeat eligibility rule › gift after opening Hatch
  it('maps a gift-in between the opening and mint acceptance to the current pet', async () => {
    const tk = await signed();
    expect((await api('/api/hatch', { token: tk })).body).toMatchObject({ open: true, ownedCount: 0 });
    h.net().contract.meanwhile.send_tx = async () => { h.net().contract.addPet('9', PLAYER, { name: 'Gifted' }); };
    const result = await api('/api/hatch', { token: tk, body: { name: 'Second' } });
    expect(result).toMatchObject({ status: 409, body: { code: 'already', currentPet: { tokenId: '9', name: 'Gifted' } } });
    expect(h.net().contract.pets.size).toBe(1);
  });

  // spec: add-hatch-again › Repeat ownership data › repeat name sent
  it('sends the typed name to the mint once, after validation, for a player with a prior birth and no pet', async () => {
    h.net().contract.addPet('3', NEAR_ACCOUNT(20), { name: 'Pixel' });
    h.net().contract.hatchedBy.set(PLAYER, '3');
    h.net().contract.nextId = 4;
    const result = await api('/api/hatch', { token: await signed(), body: { name: 'Nova' } });
    expect(result).toMatchObject({ status: 200, body: { tokenId: '4' } });
    expect(h.net().contract.pets.get('4')).toMatchObject({ name: 'Nova', owner_id: PLAYER });
    expect(h.net().contract.pets.get('3')?.owner_id).toBe(NEAR_ACCOUNT(20));
  });

  // spec: add-hatch-again › Repeat birth flow › confirmed failure
  it('reports a confirmed failed attempt without creating a token', async () => {
    const tk = await signed();
    h.net().contract.mintFails = 'pool_empty';
    expect((await api('/api/hatch', { token: tk, body: { name: 'Second' } })).body).toMatchObject({ code: 'closed', reason: 'pool' });
    expect((await api('/api/hatch', { token: tk })).body).toMatchObject({ failed: true });
    expect((await env.DB.prepare('SELECT failed FROM births_in_flight WHERE account = ?').bind(PLAYER).first())).toEqual({ failed: 1 });
  });
});
