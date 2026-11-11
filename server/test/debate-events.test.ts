import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clean } from '../src/cron';
import { opaqueDebateId, recordDebateEvent } from '../src/debates/events';
import { recoverDueDebates } from '../src/debates/turns';
import { JUDGE_DELETE_AT } from '../src/judge';
import { api, harness } from './helpers/api';
import { NEAR_ACCOUNT, token } from './helpers/network';

const h = harness();
const FIRST = NEAR_ACCOUNT(381);
const SECOND = NEAR_ACCOUNT(382);
const TAB = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

async function invitation(): Promise<{ id: string; first: string; second: string }> {
  h.net().contract.addPet('381', FIRST, { name: 'Pixel', project_food: '20000000000000000000000' });
  h.net().contract.addPet('382', SECOND, { name: 'Nori', project_food: '20000000000000000000000' });
  h.net().contract.known.add(`381:${SECOND}`);
  const first = await token('did:privy:debate-events-first', FIRST);
  const second = await token('did:privy:debate-events-second', SECOND);
  const sent = await api('/api/debates', { token: first,
    body: { firstPet: '381', secondPet: '382', openerPet: '382', topic: 'Where is home?' } });
  expect(sent.status).toBe(201);
  return { id: sent.body.id, first, second };
}

async function waitForFirst(id: string): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    const row = await env.DB.prepare('SELECT status, lease_until FROM debates WHERE id = ?').bind(id)
      .first<{ status: string; lease_until: number | null }>();
    if (row?.lease_until === null && row.status !== 'accepted') return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('first debate turn did not finish');
}

describe('debate playtest events', () => {
  beforeEach(async () => {
    vi.setSystemTime(new Date('2026-11-15T10:00:00Z'));
    await env.EVENTS.prepare('DELETE FROM debate_events').run();
    await env.EVENTS.prepare('DELETE FROM showcase_event_counts').run();
  });

  // spec: add-debates › Debate playtest data › invitation sent
  // spec: add-debates › Debate playtest data › invitation accepted
  // spec: add-debates › Debate playtest data › first call starts
  // spec: add-debates › Debate playtest data › line delivered
  // spec: add-debates › Debate playtest data › end
  it('records each accepted transition once, with only opaque ids, coded fields and one existing cost event per paid line', async () => {
    const { id, second } = await invitation();
    expect(h.net().ai.calls).toHaveLength(0);
    expect((await api(`/api/debates/${id}/decision`, { token: second, body: { decision: 'accept' } })).status).toBe(200);
    await waitForFirst(id);
    for (let n = 0; n < 4; n += 1) await recoverDueDebates(env);
    expect((await env.DB.prepare('SELECT status FROM debates WHERE id = ?').bind(id).first<{ status: string }>())?.status).toBe('completed');
    const rows = (await env.EVENTS.prepare('SELECT * FROM debate_events ORDER BY at, rowid').all<Record<string, unknown>>()).results;
    expect(rows.map((row) => row.name)).toEqual([
      'debate_invited', 'debate_accepted', 'debate_started',
      'debate_line_delivered', 'debate_line_delivered', 'debate_line_delivered', 'debate_line_delivered', 'debate_ended',
    ]);
    const opaque = await opaqueDebateId(id);
    expect(rows.every((row) => row.debate_id === opaque && row.first_pet_id !== row.second_pet_id)).toBe(true);
    expect(rows.every((row) => typeof row.first_pet_id === 'string' && /^[0-9a-f]{32}$/.test(row.first_pet_id)
      && typeof row.second_pet_id === 'string' && /^[0-9a-f]{32}$/.test(row.second_pet_id))).toBe(true);
    expect(rows[0]).toMatchObject({ day: Math.floor(Date.now() / 86_400_000), side: 'first', round: null });
    expect(rows[1]).toMatchObject({ side: 'second' });
    expect(rows[2]).toMatchObject({ side: 'second' });
    expect(rows.filter((row) => row.name === 'debate_line_delivered').map((row) => [row.round, row.side])).toEqual([
      [1, 'second'], [1, 'first'], [2, 'second'], [2, 'first'],
    ]);
    expect(rows.filter((row) => row.name === 'debate_line_delivered').every((row) =>
      Number(row.price_usd) > 0 && Number(row.cost_usd) > 0)).toBe(true);
    expect(rows.at(-1)).toMatchObject({ reason: 'complete' });
    expect(JSON.stringify(rows)).not.toMatch(/Where is home|Pixel|Nori|testnet|topic|prompt|answer|email|token_id|share_code/);
    expect(h.events().filter((event) => event.name === 'thought_delivered' && event.props.for === 'debate')).toHaveLength(4);
    await recoverDueDebates(env);
    expect(h.events().filter((event) => event.name === 'thought_delivered' && event.props.for === 'debate')).toHaveLength(4);
    await recordDebateEvent(env, { name: 'debate_invited', id, firstPet: '381', secondPet: '382' });
    expect((await env.EVENTS.prepare('SELECT COUNT(*) AS n FROM debate_events').first<{ n: number }>())?.n).toBe(8);
  });

  // spec: add-debates › Debate playtest data › end
  it('records an owner stop only once and rejects an unlisted end reason', async () => {
    const { id, first, second } = await invitation();
    await api(`/api/debates/${id}/decision`, { token: second, body: { decision: 'accept' } });
    await waitForFirst(id);
    expect((await api(`/api/debates/${id}/stop`, { token: first, body: {} })).status).toBe(200);
    await recordDebateEvent(env, { name: 'debate_ended', id, firstPet: '381', secondPet: '382', reason: 'topic words' });
    const ends = (await env.EVENTS.prepare("SELECT reason FROM debate_events WHERE name = 'debate_ended'").all<{ reason: string }>()).results;
    expect(ends).toEqual([{ reason: 'stopped' }]);
  });

  // spec: add-debates › Debate playtest data › end
  // spec: add-debates › Debate playtest data › line delivered
  it('counts a paid refusal as one delivered thought', async () => {
    const refused = await invitation();
    h.net().ai.push({ content: 'REFUSE: I want some quiet.' });
    await api(`/api/debates/${refused.id}/decision`, { token: refused.second, body: { decision: 'accept' } });
    await waitForFirst(refused.id);
    expect((await env.EVENTS.prepare("SELECT reason FROM debate_events WHERE name = 'debate_ended'")
      .first<{ reason: string }>())?.reason).toBe('refused');
    expect(h.events().filter((event) => event.name === 'thought_delivered' && event.props.for === 'debate')).toHaveLength(1);
    expect(h.events().filter((event) => event.name === 'thought_failed' && event.props.for === 'debate')).toHaveLength(0);
  });

  // spec: add-debates › Debate playtest data › end
  it('counts a rejected debit as one failed thought, without a delivered line', async () => {
    const rejected = await invitation();
    h.net().contract.debitFails = 'over_food';
    await api(`/api/debates/${rejected.id}/decision`, { token: rejected.second, body: { decision: 'accept' } });
    await waitForFirst(rejected.id);
    expect((await env.EVENTS.prepare("SELECT reason FROM debate_events WHERE name = 'debate_ended' AND debate_id = ?")
      .bind(await opaqueDebateId(rejected.id)).first<{ reason: string }>())?.reason).toBe('unavailable');
    expect((await env.EVENTS.prepare("SELECT COUNT(*) AS n FROM debate_events WHERE name = 'debate_line_delivered' AND debate_id = ?")
      .bind(await opaqueDebateId(rejected.id)).first<{ n: number }>())?.n).toBe(0);
    expect(h.events().filter((event) => event.name === 'thought_failed' && event.props.for === 'debate')).toHaveLength(1);
  });

  // spec: add-debates › Debate playtest data › end
  it('keeps the coded end after memory clear removes the active transcript', async () => {
    const { id, first, second } = await invitation();
    await api(`/api/debates/${id}/decision`, { token: second, body: { decision: 'accept' } });
    await waitForFirst(id);
    expect((await api('/api/pets/381/memory/clear', { token: first, method: 'POST' })).status).toBe(200);
    expect((await env.DB.prepare('SELECT 1 FROM debates WHERE id = ?').bind(id).first())).toBeNull();
    expect((await env.EVENTS.prepare("SELECT reason FROM debate_events WHERE name = 'debate_ended' AND debate_id = ?")
      .bind(await opaqueDebateId(id)).first<{ reason: string }>())?.reason).toBe('unavailable');
  });

  // spec: add-debates › Debate playtest data › link opened
  // spec: add-debates › Debate playtest data › receipt opened
  it('admits opaque browser opens once through the shared four-window rate gate', async () => {
    const { id, second } = await invitation();
    const debateId = await opaqueDebateId(id);
    const body = { eventId: crypto.randomUUID(), tabId: TAB, debateId, name: 'debate_link_opened' };
    expect((await api('/api/debates/events', { body, ip: '198.51.100.1' })).status).toBe(204);
    expect((await env.EVENTS.prepare("SELECT 1 FROM debate_events WHERE name = 'debate_link_opened'").first())).toBeNull();
    await api(`/api/debates/${id}/decision`, { token: second, body: { decision: 'accept' } });
    await waitForFirst(id);
    expect((await api('/api/debates/events', { body, ip: '198.51.100.1' })).status).toBe(204);
    expect((await api('/api/debates/events', { body, ip: '198.51.100.1' })).status).toBe(204);
    expect((await api('/api/debates/events', { body: { ...body, eventId: crypto.randomUUID(), name: 'debate_receipt_opened' }, ip: '198.51.100.1' })).status).toBe(204);
    expect((await api('/api/debates/events', { body: { ...body, eventId: crypto.randomUUID(), code: 'secret' } })).status).toBe(400);
    const rows = (await env.EVENTS.prepare("SELECT name, debate_id, tab_id FROM debate_events WHERE name LIKE 'debate_%_opened' ORDER BY rowid")
      .all<{ name: string; debate_id: string; tab_id: string }>()).results;
    expect(rows).toEqual([
      { name: 'debate_link_opened', debate_id: debateId, tab_id: TAB },
      { name: 'debate_receipt_opened', debate_id: debateId, tab_id: TAB },
    ]);
    const minute = Math.floor(Date.now() / 60_000);
    const day = Math.floor(Date.now() / 86_400_000);
    const ipBytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('198.51.100.1')));
    const ipKey = Array.from(ipBytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    for (const [scope, subject, bucket, limit] of [
      ['tab_minute', TAB, minute, 60], ['tab_day', TAB, day, 1000],
      ['ip_minute', ipKey, minute, 600], ['ip_day', ipKey, day, 10000],
    ] as const) {
      await env.EVENTS.prepare('DELETE FROM showcase_event_counts').run();
      await env.EVENTS.prepare('INSERT INTO showcase_event_counts (scope, subject, bucket, expires_at, n) VALUES (?, ?, ?, ?, ?)')
        .bind(scope, subject, bucket, Date.now() + 60_000, limit).run();
      expect((await api('/api/debates/events', { body: { ...body, eventId: crypto.randomUUID() }, ip: '198.51.100.1' })).status).toBe(204);
    }
    expect((await env.EVENTS.prepare("SELECT COUNT(*) AS n FROM debate_events WHERE name = 'debate_link_opened'")
      .first<{ n: number }>())?.n).toBe(1);
  });

  // spec: add-debates › Debate playtest data › link opened
  it('erases debate events at the UTC deadline and admits none afterward', async () => {
    const { id } = await invitation();
    expect((await env.EVENTS.prepare('SELECT COUNT(*) AS n FROM debate_events').first<{ n: number }>())?.n).toBe(1);
    vi.setSystemTime(new Date(JUDGE_DELETE_AT));
    await clean(env, JUDGE_DELETE_AT);
    expect((await env.EVENTS.prepare('SELECT 1 FROM debate_events').first())).toBeNull();
    const body = { eventId: crypto.randomUUID(), tabId: TAB, debateId: await opaqueDebateId(id), name: 'debate_link_opened' };
    expect((await api('/api/debates/events', { body })).status).toBe(204);
    expect((await env.EVENTS.prepare('SELECT 1 FROM debate_events').first())).toBeNull();
  });
});
