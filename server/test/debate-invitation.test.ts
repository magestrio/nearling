import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { api, harness } from './helpers/api';
import { NEAR_ACCOUNT, token } from './helpers/network';
import { expireDueInvitations } from '../src/routes/debates';

const h = harness();
const FIRST = NEAR_ACCOUNT(81);
const SECOND = NEAR_ACCOUNT(82);
const base = { firstPet: '81', secondPet: '82' };

async function owners(): Promise<{ first: string; second: string }> {
  h.net().contract.addPet('81', FIRST, { name: 'Pixel' });
  h.net().contract.addPet('82', SECOND, { name: 'Nori' });
  h.net().contract.known.add(`81:${SECOND}`);
  return { first: await token('did:privy:debate-first', FIRST), second: await token('did:privy:debate-second', SECOND) };
}

async function invite(first: string, body: Record<string, unknown> = {}) {
  return api('/api/debates', { token: first, body: { ...base, openerPet: '81', topic: 'Where should we go?', ...body } });
}

describe('debate invitation and consent', () => {
  // spec: add-debates › Debate invitation screen › success
  // spec: add-debates › Debate invitation card screen › success
  it('quotes two lines per pet from the current model price', async () => {
    const { first } = await owners();
    const before = await api('/api/debates/eligibility', { token: first, body: base });
    expect(before.body.estimatePerPetCents).toBe(0.15);
    const vars = env as { PRICE_OUT_USD_PER_MTOK: string };
    const original = vars.PRICE_OUT_USD_PER_MTOK;
    try {
      vars.PRICE_OUT_USD_PER_MTOK = '2.7';
      const after = await api('/api/debates/eligibility', { token: first, body: base });
      expect(after.body.estimatePerPetCents).toBeGreaterThan(before.body.estimatePerPetCents);
    } finally { vars.PRICE_OUT_USD_PER_MTOK = original; }
  });

  // spec: add-debates › Debate invitation flow › invited
  it('migrates separate consent and debit tables, then invites without any call or debit', async () => {
    const { first } = await owners();
    const tables = (await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'debate_%' ORDER BY name")
      .all<{ name: string }>()).results.map((row) => row.name);
    expect(tables).toEqual(['debate_consents', 'debate_debit_operations', 'debate_ended_invites', 'debate_lines', 'debate_started_days', 'debates']);
    const startedSchema = await env.DB.prepare("SELECT sql FROM sqlite_master WHERE name = 'debate_started_days'").first<{ sql: string }>();
    expect(startedSchema?.sql).not.toMatch(/REFERENCES debates/);
    const result = await invite(first);
    expect(result.status).toBe(201);
    expect(result.body).toMatchObject({ status: 'invited', firstPet: { name: 'Pixel' }, secondPet: { name: 'Nori' },
      maxPerPetNear: '0.01', notice: 'Each pet can spend up to 0.01 NEAR. Anyone with the link may read the topic and lines.' });
    expect(result.body.id).toMatch(/^[0-9a-f]{64}$/);
    const row = await env.DB.prepare('SELECT status, expires_at, share_code, share_hash FROM debates WHERE id = ?')
      .bind(result.body.id).first<{ status: string; expires_at: number; share_code: string; share_hash: string }>();
    expect(row?.status).toBe('invited');
    expect(row?.expires_at).toBe((Math.floor(Date.now() / 86_400_000) + 1) * 86_400_000);
    expect(row?.share_code).toMatch(/^[0-9a-f]{32}$/);
    expect(row?.share_hash).not.toBe(row?.share_code);
    expect((await env.DB.prepare('SELECT pet_id, decision FROM debate_consents WHERE debate_id = ?').bind(result.body.id)
      .all()).results).toEqual([{ pet_id: '81', decision: 'accepted' }]);
    expect(h.net().contract.sends).toEqual([]);
    expect(h.net().ai.calls).toEqual([]);
    await env.DB.prepare('INSERT INTO debate_started_days (pet_id, day, debate_id) VALUES (?, ?, ?)')
      .bind('81', Math.floor(Date.now() / 86_400_000), result.body.id).run();
    await env.DB.prepare('DELETE FROM debates WHERE id = ?').bind(result.body.id).run();
    expect((await env.DB.prepare('SELECT debate_id FROM debate_started_days WHERE pet_id = ?').bind('81')
      .first<{ debate_id: string }>())?.debate_id).toBe(result.body.id);
  });

  // spec: add-debates › Debate invitation flow › invited
  it('uses both fresh paid-slot sequences and the XOR pair tag in its public id', async () => {
    const { first } = await owners();
    h.net().contract.pets.get('81')!.paid_debate = { id: `${'0'.repeat(15)}1${'0'.repeat(16)}${'0'.repeat(15)}3${'0'.repeat(16)}`, occupied_day: 1, accepted_lines: 2, used_orders: 5 };
    h.net().contract.pets.get('82')!.paid_debate = { id: `${'0'.repeat(16)}${'0'.repeat(15)}2${'0'.repeat(15)}3${'0'.repeat(16)}`, occupied_day: 1, accepted_lines: 2, used_orders: 10 };
    const result = await invite(first);
    expect(result.status).toBe(201);
    expect(result.body.id.slice(0, 16)).toBe('0000000000000002');
    expect(result.body.id.slice(16, 32)).toBe('0000000000000003');
    expect(result.body.id.slice(32, 48)).toBe((81n ^ 82n).toString(16).padStart(16, '0'));
    expect(result.body.id.slice(48)).toMatch(/^[0-9a-f]{16}$/);
    expect(h.net().contract.reads.filter((read) => read.method === 'pet_view')).toHaveLength(2);
  });

  // spec: add-debates › Debate debit contract › different paid debate today
  it('uses the old pair ordering when a pet moves from the higher to the lower id', async () => {
    const { first } = await owners();
    const part = (n: bigint) => n.toString(16).padStart(16, '0');
    h.net().contract.pets.get('81')!.paid_debate = {
      id: `${part(2n)}${part(5n)}${part(81n ^ 70n)}${part(1n)}`,
      occupied_day: 1, accepted_lines: 2, used_orders: 10,
    };
    const result = await invite(first);
    expect(result.status).toBe(201);
    expect(result.body.id.slice(0, 16)).toBe(part(6n));
  });

  // spec: add-debates › Debate invitation flow › invited
  it('keeps only one open invitation per unordered pair until the first ends', async () => {
    const { first, second } = await owners();
    const initial = await invite(first);
    expect(initial.status).toBe(201);
    const duplicate = await invite(first);
    expect(duplicate).toEqual({ status: 409, body: { code: 'open_pair_invitation' } });
    const reversed = await api('/api/debates', { token: second,
      body: { firstPet: '82', secondPet: '81', openerPet: '82', topic: 'A new question?' } });
    expect(reversed).toEqual({ status: 409, body: { code: 'open_pair_invitation' } });
    const food = h.net().contract.pets.get('82')!.project_food;
    h.net().contract.pets.get('82')!.project_food = '0';
    expect((await invite(first)).body.code).toBe('open_pair_invitation');
    h.net().contract.pets.get('82')!.project_food = food;
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM debates WHERE status = 'invited'").first<{ n: number }>())?.n).toBe(1);
    expect((await api(`/api/debates/${initial.body.id}/decision`, { token: second, body: { decision: 'decline' } })).status).toBe(200);
    expect((await invite(first)).status).toBe(201);
    expect(h.net().ai.calls).toEqual([]);
    expect(h.net().contract.sends).toEqual([]);
  });

  // spec: add-debates › Debate invitation flow › gift before start
  it('closes a stale open pair after a gift so the current pair may be invited', async () => {
    const { first } = await owners();
    h.net().contract.pets.get('81')!.work_known = ['82'];
    const old = await invite(first);
    expect(old.status).toBe(201);
    h.net().contract.pets.get('82')!.owner_id = NEAR_ACCOUNT(83);
    h.net().contract.pets.get('82')!.transfer_generation += 1;
    const next = await invite(first);
    expect(next.status).toBe(201);
    expect(next.body.id).not.toBe(old.body.id);
    expect((await env.DB.prepare('SELECT reason FROM debate_ended_invites WHERE id = ?').bind(old.body.id)
      .first<{ reason: string }>())?.reason).toBe('gift');
  });

  // spec: add-debates › Debate invitation flow › invited
  it('identifies the pet whose society break prevents invitation', async () => {
    const { first } = await owners();
    await env.DB.prepare('INSERT INTO society_relations (token_id, other_id, break_until, created_at) VALUES (?, ?, ?, ?)')
      .bind('82', '81', Date.now() + 60_000, Date.now()).run();
    expect((await invite(first)).body).toEqual({ code: 'society_refusal', petId: '82' });
    await env.DB.prepare('DELETE FROM society_relations WHERE token_id = ?').bind('82').run();
    await env.DB.prepare('INSERT INTO society_relations (token_id, other_id, break_until, created_at) VALUES (?, ?, ?, ?)')
      .bind('81', '82', Date.now() + 60_000, Date.now()).run();
    expect((await invite(first)).body).toEqual({ code: 'society_refusal', petId: '81' });
  });

  // spec: add-debates › Debate transcript and deletion data › clear before first line
  it('removes an unaccepted invitation, consent and code through memory clear without a call or debit', async () => {
    const { first, second } = await owners();
    const sent = await invite(first);
    const id = sent.body.id as string;
    const code = (await env.DB.prepare('SELECT share_code FROM debates WHERE id = ?').bind(id)
      .first<{ share_code: string }>())!.share_code;
    expect((await api('/api/pets/82/memory/clear', { token: second, method: 'POST' })).status).toBe(200);
    expect(await env.DB.prepare('SELECT 1 FROM debates WHERE id = ?').bind(id).first()).toBeNull();
    expect((await env.DB.prepare('SELECT * FROM debate_consents WHERE debate_id = ?').bind(id).all()).results).toEqual([]);
    expect((await api('/api/debates/read', { body: { code } })).status).toBe(404);
    expect((await api('/api/debates/read', { token: first, body: { id } })).body).toEqual({ id, status: 'cleared' });
    expect(h.net().ai.calls).toEqual([]);
    expect(h.net().contract.sends).toEqual([]);
  });

  // spec: add-debates › Debate transcript and deletion data › clear before first line
  it('does not recreate invitation words when clear lands after its epoch read', async () => {
    const { first } = await owners();
    const batch = env.DB.batch.bind(env.DB);
    let cleared = false;
    let batches = 0;
    vi.spyOn(env.DB, 'batch').mockImplementation(async (statements) => {
      batches += 1;
      // foodState reads each pet with a two-statement batch before the invitation batch.
      if (batches === 3) {
        cleared = true;
        expect((await api('/api/pets/82/memory/clear', { token: await token('did:privy:debate-second', SECOND), method: 'POST' })).status).toBe(200);
      }
      return batch(statements);
    });
    const sent = await invite(first);
    expect(cleared).toBe(true);
    expect((await env.DB.prepare('SELECT memory_epoch FROM pets WHERE token_id = ?').bind('82').first<{ memory_epoch: number }>())?.memory_epoch).toBe(1);
    expect(sent).toEqual({ status: 409, body: { code: 'memory_cleared' } });
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM debates').first<{ n: number }>())?.n).toBe(0);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM debate_consents').first<{ n: number }>())?.n).toBe(0);
    expect(h.net().ai.calls).toEqual([]);
    expect(h.net().contract.sends).toEqual([]);
  });

  // spec: add-debates › Debate invitation flow › topic rejected
  it('rejects a blank or overlong topic without a row', async () => {
    const { first } = await owners();
    expect((await invite(first, { topic: '   ' })).body.code).toBe('topic_rejected');
    expect((await invite(first, { topic: 'x'.repeat(141) })).body.code).toBe('topic_rejected');
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM debates').first<{ n: number }>())?.n).toBe(0);
  });

  // spec: add-debates › Debate invitation flow › unknown pair
  it('refuses a pair absent from both chain acquaintance sources', async () => {
    const { first } = await owners();
    h.net().contract.known.clear();
    expect((await invite(first)).body.code).toBe('unknown_pair');
  });

  // spec: add-debates › Debate invitation flow › settled-hire acquaintance
  it('accepts a settled work acquaintance without a feeding record', async () => {
    const { first } = await owners();
    h.net().contract.known.clear();
    h.net().contract.pets.get('81')!.work_known = ['82'];
    expect((await api('/api/debates/eligibility', { token: first, body: base })).body.eligible).toBe(true);
    expect((await invite(first)).status).toBe(201);
  });

  // spec: add-debates › Debate invitation flow › same owner
  it('refuses a pair with one current owner', async () => {
    const { first } = await owners();
    h.net().contract.pets.get('82')!.owner_id = FIRST;
    expect((await invite(first)).body.code).toBe('same_owner');
  });

  // spec: add-debates › Debate invitation flow › accepted
  it('records acceptance once, publishes the link, and starts at most one first call', async () => {
    const { first, second } = await owners();
    const id = (await invite(first)).body.id;
    const path = `/api/debates/${id}/decision`;
    const accepted = await api(path, { token: second, body: { decision: 'accept' } });
    expect(accepted.body).toMatchObject({ status: 'accepted', code: expect.stringMatching(/^[0-9a-f]{32}$/) });
    expect((await api(path, { token: second, body: { decision: 'accept' } })).body).toEqual(accepted.body);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM debate_consents WHERE debate_id = ?').bind(id).first<{ n: number }>())?.n).toBe(2);
    expect(h.net().ai.calls).toHaveLength(1);
    expect(h.net().contract.sends.filter((send) => send.method === 'debit_session')).toHaveLength(1);
  });

  // spec: add-debates › Debate invitation flow › declined
  it('declines idempotently without a call or debit', async () => {
    const { first, second } = await owners();
    const id = (await invite(first)).body.id;
    expect((await api(`/api/debates/${id}/decision`, { token: second, body: { decision: 'decline' } })).body.status).toBe('declined');
    expect((await api(`/api/debates/${id}/decision`, { token: second, body: { decision: 'decline' } })).body.status).toBe('declined');
    expect(await env.DB.prepare('SELECT 1 FROM debates WHERE id = ?').bind(id).first()).toBeNull();
    expect((await env.DB.prepare('SELECT reason FROM debate_ended_invites WHERE id = ?').bind(id).first<{ reason: string }>())?.reason).toBe('declined');
    expect(h.net().contract.sends).toEqual([]);
  });

  // spec: add-debates › Debate invitation flow › expired
  it('expires the invitation at the next UTC midnight', async () => {
    const { first, second } = await owners();
    const id = (await invite(first)).body.id;
    vi.setSystemTime(new Date((Math.floor(Date.now() / 86_400_000) + 1) * 86_400_000));
    const renewed = await token('did:privy:debate-second', SECOND);
    expect((await api(`/api/debates/${id}/decision`, { token: renewed, body: { decision: 'accept' } })).body.code).toBe('expired');
    await expireDueInvitations(env.DB, Date.now());
    expect(await env.DB.prepare('SELECT 1 FROM debates WHERE id = ?').bind(id).first()).toBeNull();
    expect((await env.DB.prepare('SELECT reason FROM debate_ended_invites WHERE id = ?').bind(id).first<{ reason: string }>())?.reason).toBe('expired');
  });

  // spec: add-debates › Debate invitation flow › gift before start
  it('closes an invitation when a pet changes owner before consent', async () => {
    const { first, second } = await owners();
    const id = (await invite(first)).body.id;
    h.net().contract.pets.get('81')!.owner_id = NEAR_ACCOUNT(83);
    h.net().contract.pets.get('81')!.transfer_generation += 1;
    const decision = await api(`/api/debates/${id}/decision`, { token: second, body: { decision: 'accept' } });
    expect(decision.body.code).toBe('gift');
    expect(await env.DB.prepare('SELECT 1 FROM debates WHERE id = ?').bind(id).first()).toBeNull();
    expect((await env.DB.prepare('SELECT reason FROM debate_ended_invites WHERE id = ?').bind(id).first<{ reason: string }>())?.reason).toBe('gift');
    expect(h.net().ai.calls).toEqual([]);
    expect(h.net().contract.sends).toEqual([]);
  });

  // spec: add-debates › Debate invitation card screen › asleep
  it('refuses a sleeping invitee before saving an invitation', async () => {
    const { first } = await owners();
    h.net().contract.pets.get('82')!.project_food = '0';
    expect((await invite(first)).body.code).toBe('asleep');
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM debates').first<{ n: number }>())?.n).toBe(0);
  });
});
