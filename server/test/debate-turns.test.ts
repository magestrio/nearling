import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { recoverDueDebates } from '../src/debates/turns';
import { api, harness } from './helpers/api';
import { NEAR_ACCOUNT, token } from './helpers/network';

const h = harness();
const FIRST = NEAR_ACCOUNT(181);
const SECOND = NEAR_ACCOUNT(182);

async function invite(): Promise<{ id: string; first: string; second: string }> {
  h.net().contract.addPet('181', FIRST, { name: 'Pixel', project_food: '20000000000000000000000' });
  h.net().contract.addPet('182', SECOND, { name: 'Nori', project_food: '20000000000000000000000' });
  h.net().contract.known.add(`181:${SECOND}`);
  const first = await token('did:privy:debate-turn-first', FIRST);
  const second = await token('did:privy:debate-turn-second', SECOND);
  const sent = await api('/api/debates', { token: first, body: { firstPet: '181', secondPet: '182', openerPet: '182', topic: 'Where is home?' } });
  expect(sent.status).toBe(201);
  return { id: sent.body.id, first, second };
}

async function lines(id: string) {
  return (await env.DB.prepare('SELECT line_order, speaker_pet, status, receipt_tx_hash FROM debate_lines WHERE debate_id = ? ORDER BY line_order')
    .bind(id).all<{ line_order: number; speaker_pet: string; status: string; receipt_tx_hash: string | null }>()).results;
}

async function firstTurn(id: string): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    const row = await env.DB.prepare('SELECT status, lease_until FROM debates WHERE id = ?').bind(id)
      .first<{ status: string; lease_until: number | null }>();
    if (row?.lease_until === null && row.status !== 'accepted') return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('first debate turn did not finish');
}

describe('four alternating paid turns', () => {
  // spec: add-debates › Debate turn flow › started
  it('uses no provider call or paid slot before both owners consent', async () => {
    const { id } = await invite();
    await recoverDueDebates(env);
    expect(h.net().ai.calls).toHaveLength(0);
    expect(h.net().contract.debits).toHaveLength(0);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM debate_started_days').first<{ n: number }>())?.n).toBe(0);
    expect((await env.DB.prepare('SELECT status FROM debates WHERE id = ?').bind(id).first<{ status: string }>())?.status).toBe('invited');
  });

  // spec: add-debates › Debate turn flow › settled line
  // spec: add-debates › Debate turn flow › started
  it('finishes four signed lines without an open browser and debits each speaker once', async () => {
    const { id, second } = await invite();
    expect((await api(`/api/debates/${id}/decision`, { token: second, body: { decision: 'accept' } })).status).toBe(200);
    await firstTurn(id);
    for (let n = 0; n < 4; n += 1) await recoverDueDebates(env);
    expect(await env.DB.prepare('SELECT status, end_reason FROM debates WHERE id = ?').bind(id).first()).toMatchObject({ status: 'completed' });
    expect(await lines(id)).toMatchObject([
      { line_order: 1, speaker_pet: '182', status: 'settled' },
      { line_order: 2, speaker_pet: '181', status: 'settled' },
      { line_order: 3, speaker_pet: '182', status: 'settled' },
      { line_order: 4, speaker_pet: '181', status: 'settled' },
    ]);
    expect(h.net().contract.debits.map((debit) => debit.tokenId)).toEqual(['182', '181', '182', '181']);
    const providerInput = JSON.stringify(h.net().ai.calls.map((call) => call.body.messages));
    for (const privateId of [FIRST, SECOND, '"speaker":"181"', '"speaker":"182"']) expect(providerInput).not.toContain(privateId);
    expect((await env.DB.prepare('SELECT status FROM debates WHERE id = ?').bind(id).first<{ status: string }>())?.status).toBe('completed');
    await recoverDueDebates(env);
    expect(h.net().contract.debits).toHaveLength(4);
  });

  // spec: add-debates › Debate turn flow › debit outcome unknown
  // spec: add-debates › Debate turn flow › receipt pending
  it('keeps the original hash pending and reconciles it without a second debit', async () => {
    const { id, second } = await invite();
    h.net().contract.mode = 'executed-but-silent';
    await api(`/api/debates/${id}/decision`, { token: second, body: { decision: 'accept' } });
    await firstTurn(id);
    const before = await lines(id);
    expect(before[0]?.status).toBe('receipt_pending');
    expect(h.net().contract.debits).toHaveLength(1);
    const op = await env.DB.prepare('SELECT tx_hash, status FROM debate_debit_operations WHERE debate_id = ? AND line_order = 1')
      .bind(id).first<{ tx_hash: string; status: string }>();
    expect(op?.tx_hash).toBeTruthy();
    h.net().contract.mode = 'normal';
    await recoverDueDebates(env);
    expect((await lines(id))[0]?.status).toBe('settled');
    expect(h.net().contract.debits).toHaveLength(1);
  });

  // spec: add-debates › Debate turn flow › debit rejected
  it('marks a rejected line unavailable and charges no pet', async () => {
    const { id, second } = await invite();
    h.net().contract.debitFails = 'over_food';
    await api(`/api/debates/${id}/decision`, { token: second, body: { decision: 'accept' } });
    await firstTurn(id);
    expect((await lines(id))[0]?.status).toBe('unavailable');
    expect(h.net().contract.debits).toHaveLength(0);
    expect((await env.DB.prepare('SELECT status FROM debates WHERE id = ?').bind(id).first<{ status: string }>())?.status).toBe('unavailable');
  });

  // spec: add-debates › Debate turn flow › character refusal
  it('pays the first signed refusal and stops before another call', async () => {
    const { id, second } = await invite();
    h.net().ai.push({ content: 'REFUSE: I want some quiet.' });
    await api(`/api/debates/${id}/decision`, { token: second, body: { decision: 'accept' } });
    await firstTurn(id);
    await recoverDueDebates(env);
    expect((await lines(id))[0]?.status).toBe('settled');
    expect(h.net().contract.debits).toHaveLength(1);
    expect(h.net().ai.calls).toHaveLength(1);
    expect((await env.DB.prepare('SELECT status FROM debates WHERE id = ?').bind(id).first<{ status: string }>())?.status).toBe('refused');
  });

  // spec: add-debates › Debate turn flow › owner stops
  it('lets either current owner stop between paid lines', async () => {
    const { id, first, second } = await invite();
    await api(`/api/debates/${id}/decision`, { token: second, body: { decision: 'accept' } });
    await firstTurn(id);
    const stopped = await api(`/api/debates/${id}/stop`, { token: first, body: {} });
    expect(stopped.body).toMatchObject({ status: 'stopped' });
    await recoverDueDebates(env);
    expect((await lines(id)).map((line) => line.status)).toEqual(['settled']);
    expect(h.net().contract.debits).toHaveLength(1);
  });

  // spec: add-debates › Debate turn flow › services paused
  it('makes no call when spending is paused before the first line', async () => {
    const { id, second } = await invite();
    await env.DB.prepare("INSERT INTO service_pause (id, reason, since) VALUES (1, 'ai', ?)").bind(Date.now()).run();
    await api(`/api/debates/${id}/decision`, { token: second, body: { decision: 'accept' } });
    await firstTurn(id);
    expect(h.net().ai.calls).toHaveLength(0);
    expect(h.net().contract.debits).toHaveLength(0);
    expect((await env.DB.prepare('SELECT end_reason FROM debates WHERE id = ?').bind(id).first<{ end_reason: string }>())?.end_reason).toBe('services_paused');
  });

  // spec: add-debates › Debate turn flow › food or cap exhausted
  it('stops before the next call if its speaker cannot pay', async () => {
    const { id, second } = await invite();
    await api(`/api/debates/${id}/decision`, { token: second, body: { decision: 'accept' } });
    await firstTurn(id);
    h.net().contract.pets.get('181')!.project_food = '1';
    await recoverDueDebates(env);
    expect(h.net().ai.calls).toHaveLength(1);
    expect(h.net().contract.debits).toHaveLength(1);
    expect((await env.DB.prepare('SELECT end_reason FROM debates WHERE id = ?').bind(id).first<{ end_reason: string }>())?.end_reason).toBe('cannot_pay');
  });

  // spec: add-debates › Debate turn flow › model unavailable
  it('keeps no line or cost when a signed answer cannot be obtained', async () => {
    const { id, second } = await invite();
    h.net().ai.push({ status: 500 });
    await api(`/api/debates/${id}/decision`, { token: second, body: { decision: 'accept' } });
    await firstTurn(id);
    expect(await lines(id)).toEqual([]);
    expect(h.net().contract.debits).toHaveLength(0);
    expect((await env.DB.prepare('SELECT end_reason FROM debates WHERE id = ?').bind(id).first<{ end_reason: string }>())?.end_reason).toBe('model_unavailable');
  });

  // spec: add-debates › Debate turn flow › active society refusal
  it('makes no call when the pair enters a society refusal before the first turn', async () => {
    const { id, second } = await invite();
    await env.DB.prepare(`INSERT INTO society_relations (token_id, other_id, break_until, created_at)
      VALUES ('181', '182', ?, ?)`).bind(Date.now() + 86_400_000, Date.now()).run();
    await api(`/api/debates/${id}/decision`, { token: second, body: { decision: 'accept' } });
    await firstTurn(id);
    expect(h.net().ai.calls).toHaveLength(0);
    expect((await env.DB.prepare('SELECT end_reason FROM debates WHERE id = ?').bind(id).first<{ end_reason: string }>())?.end_reason).toBe('society_refusal');
  });

  // spec: add-debates › Debate transcript screen › asleep
  it('keeps the earlier receipt when the next speaker falls asleep', async () => {
    const { id, second } = await invite();
    await api(`/api/debates/${id}/decision`, { token: second, body: { decision: 'accept' } });
    await firstTurn(id);
    h.net().contract.pets.get('181')!.project_food = '0';
    await recoverDueDebates(env);
    expect((await lines(id)).map((line) => line.status)).toEqual(['settled']);
    expect(h.net().ai.calls).toHaveLength(1);
    expect((await env.DB.prepare('SELECT end_reason FROM debates WHERE id = ?').bind(id).first<{ end_reason: string }>())?.end_reason).toBe('asleep');
  });
});
