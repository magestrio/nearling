import { env } from 'cloudflare:workers';
import { baseEncode } from 'near-api-js';
import { describe, expect, it, vi } from 'vitest';
import { setPause } from '../src/servicePause';
import { api, harness } from './helpers/api';
import { NEAR_ACCOUNT, token } from './helpers/network';

const h = harness();
const PET = '92';
const GIVER = NEAR_ACCOUNT(1);
const FRIEND = NEAR_ACCOUNT(2);

describe('gift acceptance in the owner poll', () => {
  // spec: add-gift › Gift ownership data › открытая вкладка дарящего
  // spec: add-gift › Gift ownership data › открытая вкладка дарящего × Feed sheet open/transfer
  it('changes open sender and receiver polls and refreshes the sender Feed sheet to guest', async () => {
    h.net().contract.addPet(PET, GIVER);
    const sender = await token('did:privy:gift-live-giver', GIVER);
    const receiver = await token('did:privy:gift-live-friend', FRIEND);
    const code = (await api(`/api/pets/${PET}/gift`, { token: sender, method: 'POST' })).body.code;
    await api(`/api/gifts/${code}/accept`, { token: receiver, method: 'POST' });
    expect((await api(`/api/pets/${PET}/feed`, { token: sender })).body.viewer).toBe('owner');
    h.net().contract.pets.get(PET)!.owner_id = FRIEND;
    await env.DB.prepare("UPDATE gift_links SET status = 'transferred', accepted_name = NULL WHERE code = ?").bind(code).run();
    expect((await api(`/api/pets/${PET}/state`, { token: sender })).status).toBe(403);
    expect((await api(`/api/pets/${PET}`, { token: sender })).body.viewer).toBe('guest');
    expect((await api(`/api/pets/${PET}/feed`, { token: sender })).body.viewer).toBe('guest');
    expect((await api(`/api/gifts/${code}`, { token: receiver })).body.status).toBe('transferred');
    expect((await api(`/api/pets/${PET}`, { token: receiver })).body.viewer).toBe('owner');
    expect((await api(`/api/pets/${PET}/wardrobe/wear`, { token: sender, body: { item: null } })).status).toBe(403);
    expect((await api(`/api/pets/${PET}/hire-mode`, { token: sender, method: 'PUT', body: { mode: 'manual' } })).status).toBe(403);
  });

  // spec: add-gift › Gift flow › друг принял
  it('makes an accepted link visible to an open owner Pet screen, including when the pet is asleep', async () => {
    h.net().contract.addPet(PET, GIVER, { project_food: '0' });
    const giver = await token('did:privy:gift-state-owner', GIVER);
    const friend = await token('did:privy:gift-state-friend', FRIEND);
    await env.DB.prepare('UPDATE players SET first_name = ? WHERE account_id = ?').bind('Maya', FRIEND).run();
    const before = await api(`/api/pets/${PET}/state`, { token: giver });
    expect(before.body.gift).toBeNull();
    const created = await api(`/api/pets/${PET}/gift`, { token: giver, method: 'POST' });
    expect((await api(`/api/gifts/${created.body.code}/accept`, { token: friend, method: 'POST' })).status).toBe(200);
    const after = await api(`/api/pets/${PET}/state`, { token: giver });
    expect(after.body.gift).toMatchObject({ code: created.body.code, status: 'accepted', acceptedName: 'Maya', acceptedAccount: FRIEND });
  });

  // spec: add-gift › Gift flow › друг принял × service pause/00:00 UTC
  it('keeps acceptance across a service pause and a UTC day change', async () => {
    h.net().contract.addPet(PET, GIVER);
    const giver = await token('did:privy:gift-pause-owner', GIVER);
    const friend = await token('did:privy:gift-pause-friend', FRIEND);
    const code = (await api(`/api/pets/${PET}/gift`, { token: giver, method: 'POST' })).body.code;
    await api(`/api/gifts/${code}/accept`, { token: friend, method: 'POST' });
    await setPause(env.DB, 'ai', Date.now());
    vi.setSystemTime(new Date(Date.now() + 86_400_000));
    const renewed = await token('did:privy:gift-pause-owner', GIVER);
    expect((await api(`/api/pets/${PET}/state`, { token: renewed })).body.gift).toMatchObject({ code, status: 'accepted' });
    expect((await api(`/api/pets/${PET}/gift`, { token: renewed })).body.status).toBe('accepted');
  });

  // spec: add-gift › Gift flow › исход неизвестен × reload / tab hidden and back
  it('restores an unresolved flight from D1 and keeps the accepted link uncancellable', async () => {
    h.net().contract.addPet(PET, GIVER);
    const giver = await token('did:privy:gift-state-flight-giver', GIVER);
    const friend = await token('did:privy:gift-state-flight-friend', FRIEND);
    const code = (await api(`/api/pets/${PET}/gift`, { token: giver, method: 'POST' })).body.code;
    await api(`/api/gifts/${code}/accept`, { token: friend, method: 'POST' });
    await env.DB.prepare("INSERT INTO gift_flights (token_id, code, sender, receiver, tx_hash, signed_bytes, state, created_at) VALUES (?, ?, ?, ?, ?, x'00', 'unknown', ?)")
      .bind(PET, code, GIVER, FRIEND, baseEncode(new Uint8Array(32).fill(11)), Date.now()).run();
    expect((await api(`/api/pets/${PET}/gift/outcome`, { token: giver })).body.status).toBe('unknown');
    expect((await api(`/api/pets/${PET}/gift`, { token: giver, method: 'DELETE' })).status).toBe(409);
    expect((await api(`/api/pets/${PET}/state`, { token: giver })).body.gift).toMatchObject({ code, status: 'accepted' });
  });
});
