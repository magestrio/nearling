import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { tick } from '../src/cron';
import { parseWish } from '../src/will/diary';
import { api, harness } from './helpers/api';
import { NEAR_ACCOUNT, token } from './helpers/network';

const h = harness();
const OWNER = NEAR_ACCOUNT(701);
const OTHER = NEAR_ACCOUNT(702);
const at = (day: number) => Date.UTC(2036, 10, day, 0, 5);

async function setup(outfits: number[] = []): Promise<string> {
  h.net().contract.addPet('701', OWNER, { name: 'Pixel', outfits });
  await env.DB.prepare('INSERT INTO pets (token_id, hatched_by, born_at, birth_tx) VALUES (?, ?, 1, ?)')
    .bind('701', OWNER, '').run();
  return token('did:privy:will-diary', OWNER);
}

describe('private will migration', () => {
  // spec: add-pet-will › Wish state data › diary input
  it('keeps one wish, one line per day and one invitation per sender/day, with atomic batch rollback', async () => {
    const tables = (await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'will_%' OR name IN ('pet_wishes', 'work_invitations')")
      .all<{ name: string }>()).results.map((row) => row.name);
    expect(tables).toEqual(expect.arrayContaining(['pet_wishes', 'will_diary_lines', 'will_operations', 'will_screenings', 'will_refusals', 'work_invitations']));
    await env.DB.prepare("INSERT INTO pet_wishes (token_id, item, reason, status, owner_generation, memory_epoch, diary_day, start_op, created_at) VALUES ('701', 'bow-tie', 'It fits me', 'active', 0, 0, 1, 'start-a', 1)").run();
    await expect(env.DB.prepare("INSERT INTO pet_wishes (token_id, item, reason, status, owner_generation, memory_epoch, diary_day, start_op, created_at) VALUES ('701', 'party-hat', 'Fun', 'active', 0, 0, 1, 'start-b', 1)").run()).rejects.toThrow();
    await env.DB.prepare("INSERT INTO will_diary_lines (token_id, day, line, memory_epoch) VALUES ('701', 1, 'A wish', 0)").run();
    await expect(env.DB.batch([
      env.DB.prepare("INSERT INTO will_diary_lines (token_id, day, line, memory_epoch) VALUES ('701', 2, 'Another', 0)"),
      env.DB.prepare("INSERT INTO will_diary_lines (token_id, day, line, memory_epoch) VALUES ('701', 1, 'Duplicate', 0)"),
    ])).rejects.toThrow();
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM will_diary_lines WHERE token_id = '701'").first<{ n: number }>())?.n).toBe(1);
    await env.DB.prepare("INSERT INTO work_invitations (id, sender_token, recipient_token, day, created_at, expires_at, sender_generation, recipient_generation) VALUES ('a', '701', '702', 1, 1, 2, 0, 0)").run();
    await expect(env.DB.prepare("INSERT INTO work_invitations (id, sender_token, recipient_token, day, created_at, expires_at, sender_generation, recipient_generation) VALUES ('b', '701', '703', 1, 1, 2, 0, 0)").run()).rejects.toThrow();
  });
});

describe('one paid diary wish', () => {
  // spec: add-pet-will › Wish sheet screen › success
  it('returns the chain-backed reserve only to the current owner', async () => {
    const tk = await setup();
    const pet = h.net().contract.pets.get('701')!;
    pet.wish_active = true;
    pet.wish_reserve = '660000000000000000000';
    pet.given_food = '9000000000000000000000';
    await env.DB.prepare("INSERT INTO pet_wishes (token_id, item, reason, status, owner_generation, memory_epoch, diary_day, start_op, created_at) VALUES ('701', 'smart-glasses', 'I like details', 'active', 0, 0, 1, 'start-a', 1)").run();
    const owner = await api('/api/pets/701/wish', { token: tk });
    expect(owner.body).toMatchObject({ reserveYocto: '660000000000000000000' });
    expect(owner.body).not.toHaveProperty('eligibleEarnedFoodYocto');
    expect(owner.body.wish).toMatchObject({ item: 'smart-glasses' });
    expect((await api('/api/pets/701/wish')).status).toBe(401);
    expect((await api('/api/pets/701/wish', { token: await token('did:privy:will-other', OTHER) })).status).toBe(403);
    expect((await api('/api/pets/701', { token: await token('did:privy:will-other-guest', OTHER) })).body).not.toHaveProperty('eligibleEarnedFoodYocto');
  });

  // spec: add-pet-will › Wish pursuit flow › wish chosen
  // spec: add-pet-will › Wish state data › diary input
  // spec: add-pet-will › Wish pursuit flow › wish chosen × Reload diary
  it('sends eligible slugs once, validates choice, starts chain reserve and keeps reason owner-only', async () => {
    vi.setSystemTime(at(2));
    const tk = await setup([3]);
    h.net().ai.push({ content: 'I saw the sun.\nWISH bow-tie | I like formal things | I imagine wearing a bow tie.\nHow was your day?' });
    await tick(env, Date.now());
    expect(h.net().ai.calls).toHaveLength(1);
    const input = JSON.stringify(h.net().ai.calls[0]!.body.messages);
    expect(input).toContain('bow-tie');
    expect(input).not.toContain('smart-glasses');
    expect(input).not.toContain(OWNER);
    expect(h.net().contract.sends.filter((send) => send.method === 'will_start')).toHaveLength(1);
    expect(h.net().contract.sends.find((send) => send.method === 'will_start')?.args).toEqual({ token_id: '701' });
    expect(h.net().contract.pets.get('701')?.wish_active).toBe(true);
    const wish = await api('/api/pets/701/wish', { token: tk });
    expect(wish.body.wish).toMatchObject({ item: 'bow-tie', reason: 'I like formal things', status: 'active' });
    const diary = await api('/api/pets/701/diary', { token: tk });
    expect(diary.body.entry.willLine).toBe('I imagine wearing a bow tie.');
    expect(diary.body.entry.lines).toEqual(['I saw the sun.']);
    expect((await api('/api/pets/701/diary', { token: tk })).body.entry.willLine).toBe('I imagine wearing a bow tie.');
    const ownerView = await api('/api/pets/701', { token: tk });
    expect(ownerView.body).toMatchObject({ wishReserveYocto: '0', wishActive: true });
    const visitor = await api('/api/pets/701');
    expect(JSON.stringify(visitor.body)).not.toContain('bow-tie');
    expect(visitor.body).not.toHaveProperty('wishReserveYocto');
    expect(visitor.body).not.toHaveProperty('wishActive');
    expect((await api('/api/pets/701/wish', { token: await token('did:privy:will-other', OTHER) })).status).toBe(403);
  });

  // spec: add-pet-will › Wish pursuit flow › no target
  it('does not ask for or start a wish when every purchasable outfit is owned', async () => {
    vi.setSystemTime(at(2));
    await setup([3, 4, 5, 6]);
    await tick(env, Date.now());
    expect(h.net().ai.calls).toHaveLength(1);
    expect(JSON.stringify(h.net().ai.calls[0]!.body.messages)).not.toContain('WISH <slug>');
    expect((await env.DB.prepare('SELECT * FROM pet_wishes').all()).results).toHaveLength(0);
    expect(h.net().contract.sends.filter((send) => send.method === 'will_start')).toHaveLength(0);
  });

  // spec: add-pet-will › Wish pursuit flow › diary unavailable
  it('starts nothing after a failed paid thought and permits a later eligible attempt', async () => {
    vi.setSystemTime(at(2));
    await setup();
    h.net().ai.push({ status: 500 });
    await tick(env, Date.now());
    expect((await env.DB.prepare('SELECT * FROM pet_wishes').all()).results).toHaveLength(0);
    h.net().ai.push({ content: 'WISH headphones | Calm music suits me | I dream of headphones.\nHow are you?' });
    vi.setSystemTime(at(2) + 60_000);
    await tick(env, Date.now());
    expect(h.net().contract.pets.get('701')?.wish_active).toBe(true);
  });

  // spec: add-pet-will › Wish pursuit flow › wish chosen × 00:00 UTC diary
  it('keeps one will line per day and allows another after UTC reset without a second wish', async () => {
    vi.setSystemTime(at(2));
    await setup();
    h.net().ai.push({ content: 'WISH headphones | It fits me | I dream of headphones.\nHow are you?' });
    await tick(env, Date.now());
    h.net().ai.push({ content: 'WISH LINE: I still dream of headphones.\nWhat did you see?' });
    vi.setSystemTime(at(3));
    await tick(env, Date.now());
    expect((await env.DB.prepare('SELECT * FROM will_diary_lines WHERE token_id = ?').bind('701').all()).results).toHaveLength(2);
    expect(h.net().contract.sends.filter((send) => send.method === 'will_start')).toHaveLength(1);
    const freshToken = await token('did:privy:will-diary', OWNER);
    expect((await api('/api/pets/701/diary', { token: freshToken })).body.entry.willLine).toBe('I still dream of headphones.');
  });

  // spec: add-pet-will › Wish pursuit flow › wish chosen
  it('reconciles an executed start whose RPC reply was lost without sending again', async () => {
    vi.setSystemTime(at(2));
    await setup();
    h.net().contract.mode = 'executed-but-silent';
    h.net().ai.push({ content: 'WISH bow-tie | I like the look | I imagine a bow tie.\nHow are you?' });
    await tick(env, Date.now());
    expect(h.net().contract.sends.filter((send) => send.method === 'will_start')).toHaveLength(1);
    expect((await env.DB.prepare("SELECT status FROM pet_wishes WHERE token_id = '701'").first<{ status: string }>())?.status).toBe('active');
    const operation = await env.DB.prepare("SELECT status, tx_hash FROM will_operations WHERE token_id = '701'")
      .first<{ status: string; tx_hash: string | null }>();
    expect(operation?.status).toBe('confirmed');
    expect(operation?.tx_hash).toBeTruthy();
  });

  // spec: add-pet-will › Wish pursuit flow › wish chosen
  it('keeps the same signed transaction while an unexecuted start is unknown', async () => {
    vi.setSystemTime(at(2));
    const tk = await setup();
    h.net().contract.mode = 'lost';
    h.net().ai.push({ content: 'WISH bow-tie | It suits me | I picture a bow tie.\nHow are you?' });
    await tick(env, Date.now());
    const first = await env.DB.prepare("SELECT status, tx_hash, signed_bytes FROM will_operations WHERE token_id = '701'")
      .first<{ status: string; tx_hash: string | null; signed_bytes: ArrayBuffer | null }>();
    expect(first?.status).toBe('unknown');
    expect(first?.tx_hash).toBeTruthy();
    expect(first?.signed_bytes).not.toBeNull();
    expect(h.net().contract.sends.filter((send) => send.method === 'will_start')).toHaveLength(0);
    expect((await api('/api/pets/701/wish', { token: tk })).body.wish).toBeNull();
    vi.setSystemTime(at(2) + 60_000);
    h.net().contract.mode = 'normal';
    await tick(env, Date.now());
    await tick(env, Date.now() + 60_000);
    expect(h.net().contract.sends.filter((send) => send.method === 'will_start')).toHaveLength(1);
    expect((await env.DB.prepare("SELECT status FROM will_operations WHERE token_id = '701'").first<{ status: string }>())?.status).toBe('confirmed');
  });

  // spec: add-pet-will › Wish pursuit flow › diary unavailable
  it('does not expose a wish or will line when the chain refuses start', async () => {
    vi.setSystemTime(at(2));
    const tk = await setup();
    h.net().contract.willStartFails = 'pool_empty';
    h.net().ai.push({ content: 'WISH bow-tie | I like the look | I imagine a bow tie.\nHow are you?' });
    await tick(env, Date.now());
    expect((await api('/api/pets/701/wish', { token: tk })).body.wish).toBeNull();
    expect((await api('/api/pets/701/diary', { token: tk })).body.entry.willLine).toBeUndefined();
    expect((await env.DB.prepare("SELECT status FROM will_operations WHERE token_id = '701'").first<{ status: string }>())?.status).toBe('failed');
  });

  // spec: add-pet-will › Wish pursuit flow › wish chosen
  it('rejects wrong slugs, private job words, another pet name and oversized reasons', () => {
    const offer = { slugs: ['bow-tie'], existing: null };
    expect(parseWish('WISH party-hat | Fun | I want it.\nQuestion?', offer).item).toBeNull();
    expect(parseWish('WISH bow-tie | I got a job | I want it.\nQuestion?', offer).item).toBeNull();
    expect(parseWish('WISH bow-tie | Fun | Biscuit owes me.\nQuestion?', offer, ['Biscuit']).item).toBeNull();
    expect(parseWish(`WISH bow-tie | ${'x'.repeat(161)} | I want it.\nQuestion?`, offer).item).toBeNull();
  });

  // spec: add-pet-will › Will ownership rule › former owner opens
  // spec: add-pet-will › Wish state data › diary input
  it('moves private reads to the fresh owner and hides a line after the memory epoch changes', async () => {
    vi.setSystemTime(at(2));
    const oldToken = await setup();
    h.net().ai.push({ content: 'WISH bow-tie | It suits me | I picture a bow tie.\nHow are you?' });
    await tick(env, Date.now());
    const pet = h.net().contract.pets.get('701')!;
    pet.owner_id = OTHER;
    pet.transfer_generation += 1;
    pet.wish_active = false;
    const newToken = await token('did:privy:will-new', OTHER);
    expect((await api('/api/pets/701/wish', { token: oldToken })).status).toBe(403);
    expect((await api('/api/pets/701/wish', { token: newToken })).body.wish.status).toBe('paused');
    expect((await api('/api/pets/701/diary', { token: newToken })).body.entry.willLine).toBe('I picture a bow tie.');
    await env.DB.prepare('UPDATE pets SET memory_epoch = memory_epoch + 1 WHERE token_id = ?').bind('701').run();
    expect((await api('/api/pets/701/diary', { token: newToken })).body.entry.willLine).toBeUndefined();
    expect((await api('/api/pets/701/wish', { token: newToken })).body.wish).toBeNull();
  });
});
