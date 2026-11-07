import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { api, harness } from './helpers/api';
import { NEAR_ACCOUNT, token } from './helpers/network';

const h = harness();
const OWNER = NEAR_ACCOUNT(801);
const NEW_OWNER = NEAR_ACCOUNT(802);
const PET = '801';
const reserve = '1000000000000000000000';
const oldToken = () => token('did:privy:will-old', OWNER);
const newToken = () => token('did:privy:will-new', NEW_OWNER);

async function setup(): Promise<void> {
  h.net().contract.addPet(PET, OWNER, { name: 'Pixel', wish_active: true, wish_reserve: reserve });
  await env.DB.prepare("INSERT INTO pets (token_id, hatched_by, born_at, birth_tx) VALUES (?, ?, 1, '')")
    .bind(PET, OWNER).run();
  await env.DB.prepare(`INSERT INTO pet_wishes
    (token_id, item, reason, status, owner_generation, memory_epoch, diary_day, start_op, created_at)
    VALUES (?, 'bow-tie', 'It fits me', 'active', 0, 0, 1, 'first-start', 1)`).bind(PET).run();
  await env.DB.prepare("INSERT INTO will_diary_lines (token_id, day, line, memory_epoch) VALUES (?, 1, 'I want a bow tie.', 0)")
    .bind(PET).run();
  await env.DB.prepare(`INSERT INTO work_invitations
    (id, sender_token, recipient_token, day, created_at, expires_at, sender_generation, recipient_generation)
    VALUES (?, ?, '802', 1, 1, 9999999999999, 0, 0)`).bind('a'.repeat(24), PET).run();
  await env.DB.prepare(`INSERT INTO will_refusals
    (id, payer_token, worker_token, reason, signed_bytes, worker_code, created_at, payer_generation, worker_generation)
    VALUES (?, ?, '802', 'I decline.', x'01', 'character', 1, 0, 0)`).bind('b'.repeat(24), PET).run();
}

describe('will ownership and clear', () => {
  // spec: add-pet-will › Will ownership rule › gift confirmed
  // spec: add-pet-will › Will ownership rule › former owner opens
  // spec: add-pet-will › Will ownership rule › new owner continues
  it('keeps public reserve through an outside gift, denies the old owner and resumes only for the new owner', async () => {
    await setup();
    const moved = h.net().contract.pets.get(PET)!;
    moved.owner_id = NEW_OWNER;
    moved.transfer_generation = 1;
    moved.wish_active = false;
    expect((await api(`/api/pets/${PET}/wish`, { token: await oldToken() })).status).toBe(403);
    expect((await api(`/api/pets/${PET}/wish`, { token: await newToken() })).body).toMatchObject({
      wish: { status: 'paused' }, reserveYocto: reserve,
    });
    expect((await env.DB.prepare('SELECT status FROM work_invitations WHERE id = ?').bind('a'.repeat(24))
      .first<{ status: string }>())?.status).toBe('expired');
    expect((await api(`/api/pets/${PET}/invitations`, { token: await newToken() })).body.invitations).toEqual([]);
    const resumed = await api(`/api/pets/${PET}/wish/continue`, { token: await newToken(), method: 'POST' });
    expect(resumed).toMatchObject({ status: 200, body: { status: 'active' } });
    expect(moved.wish_reserve).toBe(reserve);
    expect((await env.DB.prepare('SELECT owner_generation FROM pet_wishes WHERE token_id = ?').bind(PET)
      .first<{ owner_generation: number }>())?.owner_generation).toBe(1);
  });

  // spec: add-pet-will › Will ownership rule › gift confirmed
  it('lets the new owner cancel the transferred wish without changing other food', async () => {
    await setup();
    const moved = h.net().contract.pets.get(PET)!;
    moved.owner_id = NEW_OWNER;
    moved.transfer_generation = 1;
    moved.wish_active = false;
    const before = BigInt(moved.given_food);
    expect((await api(`/api/pets/${PET}/wish/cancel`, { token: await oldToken(), method: 'POST' })).status).toBe(403);
    const out = await api(`/api/pets/${PET}/wish/cancel`, { token: await newToken(), method: 'POST' });
    expect(out).toMatchObject({ status: 200, body: { status: 'released' } });
    expect(moved.wish_reserve).toBe('0');
    expect(BigInt(moved.given_food)).toBe(before + BigInt(reserve));
  });

  // spec: add-pet-will › Will memory clear flow › release fails
  it('leaves private memory and reserve intact when the chain rejects release', async () => {
    await setup();
    h.net().contract.willReleaseFails = 'release_failed';
    const out = await api(`/api/pets/${PET}/memory/clear`, { token: await oldToken(), method: 'POST' });
    expect(out.status).toBe(503);
    expect(h.net().contract.pets.get(PET)?.wish_reserve).toBe(reserve);
    expect(await env.DB.prepare('SELECT reason FROM pet_wishes WHERE token_id = ?').bind(PET).first()).not.toBeNull();
    expect(await env.DB.prepare('SELECT line FROM will_diary_lines WHERE token_id = ?').bind(PET).first()).not.toBeNull();
  });

  // spec: add-pet-will › Will memory clear flow › deletion fails after release
  it('preserves a paused wish after D1 rollback and allows Continue', async () => {
    await setup();
    await env.DB.exec("CREATE TRIGGER fail_will_clear BEFORE DELETE ON will_diary_lines BEGIN SELECT RAISE(ABORT, 'broken clear'); END");
    try {
      const out = await api(`/api/pets/${PET}/memory/clear`, { token: await oldToken(), method: 'POST' });
      expect(out.status).toBe(500);
    } finally { await env.DB.exec('DROP TRIGGER fail_will_clear'); }
    expect(h.net().contract.pets.get(PET)?.wish_reserve).toBe('0');
    expect((await env.DB.prepare('SELECT status FROM pet_wishes WHERE token_id = ?').bind(PET)
      .first<{ status: string }>())?.status).toBe('paused');
    expect(await env.DB.prepare('SELECT line FROM will_diary_lines WHERE token_id = ?').bind(PET).first()).not.toBeNull();
    expect((await api(`/api/pets/${PET}/wish/continue`, { token: await oldToken(), method: 'POST' })).status).toBe(200);
  });

  // spec: add-pet-will › Will memory clear flow › clear confirmed
  it('releases the reserve and erases all private will rows in the clear batch', async () => {
    await setup();
    const out = await api(`/api/pets/${PET}/memory/clear`, { token: await oldToken(), method: 'POST' });
    expect(out.status).toBe(200);
    expect(h.net().contract.pets.get(PET)?.wish_reserve).toBe('0');
    for (const table of ['pet_wishes', 'will_operations', 'will_diary_lines', 'work_invitations', 'will_refusals']) {
      expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())?.n).toBe(0);
    }
  });

  // spec: add-pet-will › Will memory clear flow › clear confirmed
  it('deactivates a zero-reserve wish before erasing its target', async () => {
    await setup();
    const moved = h.net().contract.pets.get(PET)!;
    moved.wish_reserve = '0';
    expect((await api(`/api/pets/${PET}/memory/clear`, { token: await oldToken(), method: 'POST' })).status).toBe(200);
    expect(moved.wish_active).toBe(false);
    expect(await env.DB.prepare('SELECT 1 FROM pet_wishes WHERE token_id = ?').bind(PET).first()).toBeNull();
  });
});
