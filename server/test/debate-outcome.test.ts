import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { recoverDueDebates } from '../src/debates/turns';
import { applyDebateOutcome } from '../src/debates/outcome';
import { composeSocial, pendingSocial } from '../src/society/diary';
import { relation } from '../src/society/relations';
import { api, harness } from './helpers/api';
import { NEAR_ACCOUNT, token } from './helpers/network';

const h = harness();
const FIRST = NEAR_ACCOUNT(211);
const SECOND = NEAR_ACCOUNT(212);
const DAY_MS = 86_400_000;

async function invitation() {
  h.net().contract.addPet('211', FIRST, { name: 'Pixel', project_food: '20000000000000000000000' });
  h.net().contract.addPet('212', SECOND, { name: 'Nori', project_food: '20000000000000000000000' });
  h.net().contract.known.add(`211:${SECOND}`);
  const first = await token('did:privy:debate-outcome-first', FIRST);
  const second = await token('did:privy:debate-outcome-second', SECOND);
  const sent = await api('/api/debates', { token: first, body: {
    firstPet: '211', secondPet: '212', openerPet: '211', topic: 'Can a small place be home?',
  } });
  expect(sent.status).toBe(201);
  return { id: sent.body.id as string, first, second };
}

async function idle(id: string): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    const row = await env.DB.prepare('SELECT lease_until, status FROM debates WHERE id = ?').bind(id)
      .first<{ lease_until: number | null; status: string }>();
    if (h.net().ai.active === 0 && row?.lease_until === null && row.status !== 'accepted') return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('debate background turn did not finish');
}

async function accept(id: string, second: string): Promise<void> {
  expect((await api(`/api/debates/${id}/decision`, { token: second, body: { decision: 'accept' } })).status).toBe(200);
  await idle(id);
}

async function finish(id: string): Promise<void> {
  for (let n = 0; n < 4; n += 1) await recoverDueDebates(env);
  expect((await env.DB.prepare('SELECT status FROM debates WHERE id = ?').bind(id).first<{ status: string }>())?.status).toBe('completed');
}

describe('completed debate outcome', () => {
  // spec: add-debates › Debate outcome rule › completed encounter
  // spec: add-debates › Debate outcome rule › completed encounter × retry
  it('moves each clear directed reaction once after four paid lines', async () => {
    const { id, second } = await invitation();
    h.net().ai.push(
      { content: 'I like small homes.' }, { content: 'They can be warm.' },
      { content: 'You make a good point. [[society:respectful]]' },
      { content: 'I disagree with you. [[society:rude]]' },
    );
    await accept(id, second);
    await finish(id);
    expect(await relation(env.DB, '211', '212')).toMatchObject({ good_days: 1, stance: 'neutral' });
    expect(await relation(env.DB, '212', '211')).toMatchObject({ rude_days: 1, stance: 'strained' });
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM society_processed_hires WHERE hire_id = ?').bind(`debate:${id}`).first<{ n: number }>())?.n).toBe(1);
    await applyDebateOutcome(env, id);
    await recoverDueDebates(env);
    expect(await relation(env.DB, '211', '212')).toMatchObject({ good_days: 1 });
    expect(await relation(env.DB, '212', '211')).toMatchObject({ rude_days: 1 });
    expect(h.net().contract.debits).toHaveLength(4);
  });

  // spec: add-debates › Debate outcome rule › ambiguous reaction
  it('leaves an ambiguous direction alone while completing the other', async () => {
    const { id, second } = await invitation();
    h.net().ai.push({ content: 'First.' }, { content: 'Second.' },
      { content: 'I am still thinking.' }, { content: 'Thank you. [[society:respectful]]' });
    await accept(id, second);
    await finish(id);
    expect(await relation(env.DB, '211', '212')).toBeNull();
    expect(await relation(env.DB, '212', '211')).toMatchObject({ good_days: 1 });
  });

  // spec: add-debates › Debate outcome rule › completed encounter × same-day society move
  it('does not move a direction already moved by Society today', async () => {
    const { id, second } = await invitation();
    const today = Math.floor(Date.now() / DAY_MS);
    await env.DB.prepare(`INSERT INTO society_relations (token_id, other_id, good_days, last_move_day, created_at)
      VALUES ('211', '212', 1, ?, ?)`).bind(today, Date.now()).run();
    h.net().ai.push({ content: 'One.' }, { content: 'Two.' },
      { content: 'I respect that. [[society:respectful]]' }, { content: 'I respect you. [[society:respectful]]' });
    await accept(id, second);
    await finish(id);
    expect(await relation(env.DB, '211', '212')).toMatchObject({ good_days: 1, stance: 'neutral' });
    expect(await relation(env.DB, '212', '211')).toMatchObject({ good_days: 1 });
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM society_encounters WHERE token_id = '211' AND hire_id = ?")
      .bind(`debate:${id}`).first<{ n: number }>())?.n).toBe(0);
  });

  // spec: add-debates › Debate outcome rule › stopped encounter
  it('keeps one paid line without relationship or diary effects', async () => {
    const { id, first, second } = await invitation();
    await accept(id, second);
    expect((await api(`/api/debates/${id}/stop`, { token: first, body: {} })).status).toBe(200);
    await recoverDueDebates(env);
    expect(await relation(env.DB, '211', '212')).toBeNull();
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM society_encounters').first<{ n: number }>())?.n).toBe(0);
  });

  // spec: add-debates › Debate outcome rule › stopped encounter × rejected last debit
  it('does not apply a clear third-line reaction if the fourth receipt is rejected', async () => {
    const { id, second } = await invitation();
    h.net().ai.push({ content: 'One.' }, { content: 'Two.' },
      { content: 'Good point. [[society:respectful]]' }, { content: 'Last.' });
    await accept(id, second);
    await recoverDueDebates(env);
    await recoverDueDebates(env);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM debate_lines WHERE debate_id = ? AND status = 'settled'")
      .bind(id).first<{ n: number }>())?.n).toBe(3);
    h.net().contract.debitFails = 'over_food';
    await recoverDueDebates(env);
    expect((await env.DB.prepare('SELECT status FROM debates WHERE id = ?').bind(id).first<{ status: string }>())?.status).toBe('unavailable');
    expect(await relation(env.DB, '211', '212')).toBeNull();
    expect(await relation(env.DB, '212', '211')).toBeNull();
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM society_encounters').first<{ n: number }>())?.n).toBe(0);
  });

  // spec: add-debates › Debate outcome rule › completed encounter × next diary
  it('feeds fixed named social lines into the next diary within its existing bound', async () => {
    const { id, second } = await invitation();
    h.net().ai.push({ content: 'First.' }, { content: 'Second.' },
      { content: 'Yes. [[society:respectful]]' }, { content: 'Yes. [[society:respectful]]' });
    await accept(id, second);
    await finish(id);
    const tomorrow = Math.floor(Date.now() / DAY_MS) + 1;
    const facts = await pendingSocial(env, '211', tomorrow);
    expect(facts).toHaveLength(1);
    expect(composeSocial('I saw the stars.', facts).lines.map((line) => line.line))
      .toEqual(['I have a story about helping Nori yesterday.']);
    expect(h.net().ai.calls).toHaveLength(4);
    for (const table of ['ritual_days', 'experience_notes', 'work_records', 'hires', 'worker_answers']) {
      expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())?.n).toBe(0);
    }
  });

  // spec: add-debates › Debate outcome rule › daily slot used
  // spec: add-debates › Debate outcome rule › debate crosses midnight
  // spec: add-debates › Debate outcome rule › next-day invitation
  it('claims the carried day even when the first call itself crosses midnight', async () => {
    const before = Date.UTC(2036, 10, 1, 23, 59, 59);
    vi.setSystemTime(before);
    const { id, first, second } = await invitation();
    h.net().ai.push({ during: () => { vi.setSystemTime(before + 2_000); } });
    await accept(id, second);
    const yesterday = Math.floor(before / DAY_MS);
    const today = yesterday + 1;
    expect((await env.DB.prepare('SELECT day FROM debate_started_days WHERE debate_id = ? ORDER BY day').bind(id)
      .all<{ day: number }>()).results.map((row) => row.day)).toEqual([yesterday, yesterday, today, today]);
    expect((await api('/api/debates/eligibility', { token: first, body: { firstPet: '211', secondPet: '212' } })).body.code).toBe('daily_slot_used');
    await finish(id);
    expect((await api('/api/debates/eligibility', { token: first, body: { firstPet: '211', secondPet: '212' } })).body.code).toBe('daily_slot_used');
    vi.setSystemTime(before + DAY_MS + 2_000);
    const nextDayOwner = await token('did:privy:debate-outcome-first', FIRST);
    expect((await api('/api/debates/eligibility', { token: nextDayOwner, body: { firstPet: '211', secondPet: '212' } })).body.eligible).toBe(true);
  });
});
