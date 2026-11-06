import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { api, harness } from './helpers/api';
import { addPet, owner, PET } from './helpers/errands';
import { NEAR_ACCOUNT, token } from './helpers/network';
import { targetKind } from '../src/watch/target';

const h = harness();
const path = `/api/pets/${PET}/watch`;

describe('Watch target data', () => {
  // spec: add-pet-errands › Watch target data › viewer reads the target
  it('publishes only target and kind on Pet, with details gated to the owner', async () => {
    addPet(h);
    const tk = await owner();
    expect((await api(path, { token: tk, method: 'PUT', body: { target: 'NEAR price' } })).status).toBe(200);
    const publicView = await api(`/api/pets/${PET}`);
    expect(publicView.body.watch).toEqual({ target: 'NEAR price', kind: 'topic' });
    expect(JSON.stringify(publicView.body)).not.toContain('latestReceiptId');
    expect((await api(path, { token: tk })).body).toMatchObject({ target: 'NEAR price', kind: 'topic', savedHourUtc: new Date().getUTCHours(), paused: false });
    expect((await api(path, { token: tk })).body.upTo.yocto).toMatch(/^\d+$/);
    expect(targetKind('https://github.com/rust-lang/rust/releases/tag/1.90.0')).toBe('release');
    const stranger = await token('did:privy:stranger', NEAR_ACCOUNT(7));
    expect((await api(path, { token: stranger })).status).toBe(403);
  });

  // spec: add-pet-errands › Watch target data › viewer reads the target × save same target after paid baseline
  it('keeps the paid baseline, result and saved hour when the owner saves the same target', async () => {
    addPet(h);
    const tk = await owner();
    await api(path, { token: tk, method: 'PUT', body: { target: 'NEAR price' } });
    const before = await env.DB.prepare('SELECT revision, saved_hour_utc, updated_at FROM watch_targets WHERE token_id = ?').bind(PET).first<any>();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO watch_checks (token_id, day, revision, status, price_yocto, receipt_id, started_at) VALUES (?, 1, 1, 'paid', '100', 'paid-one', 1)").bind(PET),
      env.DB.prepare("INSERT INTO watch_observations (token_id, revision, named_content, source_urls, observed_day) VALUES (?, 1, 'NEAR costs 4 dollars', '[]', 1)").bind(PET),
      env.DB.prepare("UPDATE watch_targets SET latest_result = 'first', latest_price_yocto = '100', latest_receipt_id = 'paid-one' WHERE token_id = ?").bind(PET),
    ]);
    const saved = await api(path, { token: tk, method: 'PUT', body: { target: '  NEAR price  ' } });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ target: 'NEAR price', latestResult: 'first', latestReceiptId: 'paid-one', savedHourUtc: before.saved_hour_utc });
    expect(await env.DB.prepare('SELECT revision, saved_hour_utc, updated_at FROM watch_targets WHERE token_id = ?').bind(PET).first()).toEqual(before);
    expect((await env.DB.prepare('SELECT named_content FROM watch_observations WHERE token_id = ?').bind(PET).first<{ named_content: string }>())?.named_content).toBe('NEAR costs 4 dollars');
  });

  // spec: add-pet-errands › Watch target data › target too long
  it('refuses a 501-code-point target and keeps the old watch', async () => {
    addPet(h);
    const tk = await owner();
    expect((await api(path, { token: tk, method: 'PUT', body: { target: 'x'.repeat(500) } })).status).toBe(200);
    await api(path, { token: tk, method: 'PUT', body: { target: 'NEAR price' } });
    expect(await api(path, { token: tk, method: 'PUT', body: { target: '😀'.repeat(501) } })).toMatchObject({ status: 400, body: { code: 'watch_too_long' } });
    expect((await api(path, { token: tk })).body.target).toBe('NEAR price');
  });

  // spec: add-pet-errands › Watch target data › blank target refused
  it('refuses whitespace without saving or scheduling', async () => {
    addPet(h);
    const tk = await owner();
    expect(await api(path, { token: tk, method: 'PUT', body: { target: ' \n\t ' } })).toMatchObject({ status: 400, body: { code: 'watch_blank' } });
    expect(await env.DB.prepare('SELECT 1 FROM watch_targets').first()).toBeNull();
  });

  // spec: add-pet-errands › Watch target data › watch received with a gift
  it('pauses after a gift, and lets the new owner resume or stop it', async () => {
    addPet(h);
    const old = await owner();
    await api(path, { token: old, method: 'PUT', body: { target: 'example.near' } });
    const pet = h.net().contract.pets.get(PET)!;
    pet.owner_id = NEAR_ACCOUNT(2);
    pet.transfer_generation += 1;
    const fresh = await token('did:privy:new', pet.owner_id);
    expect((await api(path, { token: fresh })).body).toMatchObject({ target: 'example.near', kind: 'account', paused: true, nextCheck: null });
    expect((await api(`${path}/resume`, { token: fresh, method: 'POST' })).body.paused).toBe(false);
    expect((await api(path, { token: fresh, method: 'DELETE' })).body.target).toBeNull();
    expect(await env.DB.prepare('SELECT 1 FROM watch_targets WHERE token_id = ?').bind(PET).first()).toBeNull();
  });

  // spec: add-pet-errands › Watch target data › previous owner changes a watch
  it('refuses the stale giver before reading or changing details', async () => {
    addPet(h);
    const old = await owner();
    await api(path, { token: old, method: 'PUT', body: { target: 'NEAR price' } });
    const pet = h.net().contract.pets.get(PET)!;
    pet.owner_id = NEAR_ACCOUNT(2);
    pet.transfer_generation += 1;
    expect((await api(path, { token: old })).status).toBe(403);
    expect((await api(path, { token: old, method: 'PUT', body: { target: 'other' } })).status).toBe(403);
    expect((await api(`${path}/resume`, { token: old, method: 'POST' })).status).toBe(403);
    expect((await api(path, { token: old, method: 'DELETE' })).status).toBe(403);
    expect((await env.DB.prepare('SELECT target FROM watch_targets WHERE token_id = ?').bind(PET).first<{ target: string }>())?.target).toBe('NEAR price');
  });
});
