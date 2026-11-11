import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { giftDebateStatements } from '../src/debates/cancel';
import { recoverDueDebates } from '../src/debates/turns';
import { forgetStatements } from '../src/pet/forget';
import { api, harness } from './helpers/api';
import { NEAR_ACCOUNT, token } from './helpers/network';

const h = harness();
const FIRST = NEAR_ACCOUNT(191);
const SECOND = NEAR_ACCOUNT(192);
const NEW = NEAR_ACCOUNT(193);

async function accepted() {
  h.net().contract.addPet('191', FIRST, { name: 'Pixel', project_food: '20000000000000000000000' });
  h.net().contract.addPet('192', SECOND, { name: 'Nori', project_food: '20000000000000000000000' });
  h.net().contract.known.add(`191:${SECOND}`);
  const first = await token('did:privy:debate-race-first', FIRST);
  const second = await token('did:privy:debate-race-second', SECOND);
  const sent = await api('/api/debates', { token: first, body: { firstPet: '191', secondPet: '192', openerPet: '191', topic: 'What makes a home?' } });
  expect(sent.status).toBe(201);
  return { id: sent.body.id as string, first, second };
}

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('debate did not reach expected state');
}

async function idle(id: string): Promise<void> {
  await waitFor(async () => {
    const row = await env.DB.prepare('SELECT lease_until FROM debates WHERE id = ?').bind(id).first<{ lease_until: number | null }>();
    return h.net().ai.active === 0 && (row === null || row.lease_until === null);
  });
}

describe('debate owner and memory races', () => {
  // spec: add-debates › Debate turn flow › gift during a line
  it('discards an in-flight answer after gift and charges the project', async () => {
    const { id, second } = await accepted();
    h.net().ai.push({ during: async () => {
      h.net().contract.pets.get('191')!.owner_id = NEW;
      h.net().contract.pets.get('191')!.transfer_generation += 1;
      await env.DB.batch(giftDebateStatements(env.DB, '191', Date.now()));
    } });
    await api(`/api/debates/${id}/decision`, { token: second, body: { decision: 'accept' } });
    await waitFor(async () => (await env.DB.prepare('SELECT status FROM debates WHERE id = ?').bind(id).first<{ status: string }>())?.status === 'gift');
    await waitFor(async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM project_spend WHERE kind = 'debate_cancelled'").first<{ n: number }>())?.n === 1);
    await idle(id);
    expect(h.net().contract.debits).toHaveLength(0);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM debate_lines WHERE debate_id = ?').bind(id).first<{ n: number }>())?.n).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM project_spend WHERE kind = 'debate_cancelled'").first<{ n: number }>())?.n).toBe(1);
  });

  // spec: add-debates › Debate transcript and deletion data › clear during a line
  it('does not restore words or debit after the clear batch wins', async () => {
    const { id, first, second } = await accepted();
    const code = (await env.DB.prepare('SELECT share_code FROM debates WHERE id = ?').bind(id).first<{ share_code: string }>())!.share_code;
    h.net().ai.push({ during: async () => { await env.DB.batch(forgetStatements(env.DB, '192', Date.now())); } });
    await api(`/api/debates/${id}/decision`, { token: second, body: { decision: 'accept' } });
    await waitFor(async () => (await env.DB.prepare('SELECT id FROM debates WHERE id = ?').bind(id).first()) === null);
    await waitFor(async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM project_spend WHERE kind = 'debate_cancelled'").first<{ n: number }>())?.n === 1);
    await idle(id);
    expect((await api('/api/debates/read', { body: { code } })).status).toBe(404);
    // spec: add-debates › Debate transcript and deletion data › clear during a line
    expect((await api('/api/debates/read', { token: first, body: { code } })).body)
      .toMatchObject({ id, status: 'cleared', endReason: 'memory_clear' });
    expect((await api('/api/debates/read', { token: first, body: { id } })).body)
      .toEqual({ id, status: 'cleared', endReason: 'memory_clear' });
    const outsider = await token('did:privy:debate-race-outsider', NEW);
    expect((await api('/api/debates/read', { token: outsider, body: { code } })).status).toBe(404);
    expect(h.net().contract.debits).toHaveLength(0);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM debate_lines WHERE debate_id = ?').bind(id).first<{ n: number }>())?.n).toBe(0);
  });

  // spec: add-debates › Debate turn flow › gift mid debate
  it('keeps a settled paid line after a gift and starts no next turn', async () => {
    const { id, second } = await accepted();
    await api(`/api/debates/${id}/decision`, { token: second, body: { decision: 'accept' } });
    await waitFor(async () => (await env.DB.prepare('SELECT status FROM debate_lines WHERE debate_id = ? AND line_order = 1')
      .bind(id).first<{ status: string }>())?.status === 'settled');
    await idle(id);
    h.net().contract.pets.get('191')!.owner_id = NEW;
    h.net().contract.pets.get('191')!.transfer_generation += 1;
    await env.DB.batch(giftDebateStatements(env.DB, '191', Date.now()));
    await recoverDueDebates(env);
    expect((await env.DB.prepare('SELECT status FROM debate_lines WHERE debate_id = ? AND line_order = 1').bind(id).first<{ status: string }>())?.status).toBe('settled');
    expect(h.net().contract.debits).toHaveLength(1);
    expect((await env.DB.prepare('SELECT status FROM debates WHERE id = ?').bind(id).first<{ status: string }>())?.status).toBe('gift');
  });

  // spec: add-debates › Debate turn flow › gift during a line
  it('reconciles the original submitted hash after a gift without another charge', async () => {
    const { id, second } = await accepted();
    h.net().contract.mode = 'executed-but-silent';
    await api(`/api/debates/${id}/decision`, { token: second, body: { decision: 'accept' } });
    await waitFor(async () => {
      const op = await env.DB.prepare('SELECT tx_hash FROM debate_debit_operations WHERE debate_id = ? AND line_order = 1')
        .bind(id).first<{ tx_hash: string | null }>();
      const row = await env.DB.prepare('SELECT lease_until FROM debates WHERE id = ?').bind(id).first<{ lease_until: number | null }>();
      return op?.tx_hash != null && h.net().contract.debits.length === 1 && row?.lease_until === null;
    });
    h.net().contract.pets.get('191')!.owner_id = NEW;
    h.net().contract.pets.get('191')!.transfer_generation += 1;
    await env.DB.batch(giftDebateStatements(env.DB, '191', Date.now()));
    h.net().contract.mode = 'normal';
    await recoverDueDebates(env);
    expect((await env.DB.prepare('SELECT status FROM debate_lines WHERE debate_id = ? AND line_order = 1')
      .bind(id).first<{ status: string }>())?.status).toBe('settled');
    expect((await env.DB.prepare('SELECT status FROM debates WHERE id = ?').bind(id).first<{ status: string }>())?.status).toBe('gift');
    expect(h.net().contract.debits).toHaveLength(1);
  });

  // spec: add-debates › Debate turn flow › gift during a line
  it('drops signed words when a gift wins just before the debit reaches the contract', async () => {
    const { id, second } = await accepted();
    const atSend: { tx_hash: string | null } = { tx_hash: null };
    let keptOnGift: boolean | null = null;
    h.net().contract.meanwhile.send_tx = async () => {
      atSend.tx_hash = (await env.DB.prepare('SELECT tx_hash FROM debate_debit_operations WHERE debate_id = ?').bind(id)
        .first<{ tx_hash: string | null }>())?.tx_hash ?? null;
      h.net().contract.pets.get('191')!.owner_id = NEW;
      h.net().contract.pets.get('191')!.transfer_generation += 1;
      await env.DB.batch(giftDebateStatements(env.DB, '191', Date.now()));
      keptOnGift = (await env.DB.prepare('SELECT 1 FROM debate_lines WHERE debate_id = ?').bind(id).first()) !== null;
    };
    await api(`/api/debates/${id}/decision`, { token: second, body: { decision: 'accept' } });
    await waitFor(async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM project_spend WHERE kind = 'debate_cancelled'")
      .first<{ n: number }>())?.n === 1);
    expect(atSend.tx_hash).toBeTruthy();
    expect(keptOnGift).toBe(true);
    expect(h.net().contract.debits).toHaveLength(0);
    expect(await env.DB.prepare('SELECT status, tx_hash FROM debate_debit_operations WHERE debate_id = ?').bind(id).first()).toBeNull();
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM debate_lines WHERE debate_id = ?').bind(id).first<{ n: number }>())?.n).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM project_spend WHERE kind = 'debate_cancelled'").first<{ n: number }>())?.n).toBe(1);
  });
});
