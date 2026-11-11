import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { giftDebateStatements } from '../src/debates/cancel';
import { recoverDueDebates } from '../src/debates/turns';
import { relation } from '../src/society/relations';
import { api, harness } from './helpers/api';
import { NEAR_ACCOUNT, token } from './helpers/network';

const h = harness();
const FIRST = NEAR_ACCOUNT(221);
const SECOND = NEAR_ACCOUNT(222);
const NEW = NEAR_ACCOUNT(223);

async function pair() {
  h.net().contract.addPet('221', FIRST, { name: 'Pixel', project_food: '20000000000000000000000' });
  h.net().contract.addPet('222', SECOND, { name: 'Nori', project_food: '20000000000000000000000' });
  h.net().contract.known.add(`221:${SECOND}`);
  const first = await token('did:privy:debate-seam-first', FIRST);
  const second = await token('did:privy:debate-seam-second', SECOND);
  const sent = await api('/api/debates', { token: first, body: {
    firstPet: '221', secondPet: '222', openerPet: '221', topic: 'What is a good friend?',
  } });
  expect(sent.status).toBe(201);
  return { id: sent.body.id as string, first, second };
}

async function idle(id: string) {
  for (let n = 0; n < 200; n += 1) {
    const row = await env.DB.prepare('SELECT status, lease_until FROM debates WHERE id = ?').bind(id)
      .first<{ status: string; lease_until: number | null }>();
    if (h.net().ai.active === 0 && row?.status !== 'accepted' && row?.lease_until === null) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('background turn did not finish');
}

describe('debate seams with owner views and memory', () => {
  // spec: add-debates › Debate consent and access data › former owner reads
  // spec: add-debates › Debate turn flow › gift mid debate
  it('ends controls on gift, gives the new owner the private read and keeps the public code', async () => {
    const { id, first, second } = await pair();
    expect((await api(`/api/debates/${id}/decision`, { token: second, body: { decision: 'accept' } })).status).toBe(200);
    await idle(id);
    const code = (await env.DB.prepare('SELECT share_code FROM debates WHERE id = ?').bind(id).first<{ share_code: string }>())!.share_code;
    h.net().contract.pets.get('221')!.owner_id = NEW;
    h.net().contract.pets.get('221')!.transfer_generation += 1;
    await env.DB.batch(giftDebateStatements(env.DB, '221', Date.now()));
    const incoming = await token('did:privy:debate-seam-new', NEW);
    expect((await api('/api/debates/read', { token: first, body: { id } })).status).toBe(403);
    expect((await api('/api/pets/221/state', { token: first })).status).toBe(403);
    expect((await api('/api/pets/221/relationships', { token: first })).status).toBe(403);
    expect((await api('/api/debates/read', { token: incoming, body: { id } })).body.status).toBe('gift');
    expect((await api('/api/debates/read', { body: { code } })).body.lines).toHaveLength(1);
    expect((await api(`/api/debates/${id}/stop`, { token: first, body: {} })).status).toBe(403);
  });

  // spec: add-debates › Debate transcript and deletion data › clear after publication
  // spec: add-debates › Debate outcome rule › completed encounter × Clear memory
  it('revokes the code and one pet’s directed memory without deleting the other pet’s relationship', async () => {
    const { id, first, second } = await pair();
    h.net().ai.push({ content: 'One.' }, { content: 'Two.' },
      { content: 'I agree. [[society:respectful]]' }, { content: 'I agree. [[society:respectful]]' });
    expect((await api(`/api/debates/${id}/decision`, { token: second, body: { decision: 'accept' } })).status).toBe(200);
    await idle(id);
    for (let n = 0; n < 4; n += 1) await recoverDueDebates(env);
    const code = (await env.DB.prepare('SELECT share_code FROM debates WHERE id = ?').bind(id).first<{ share_code: string }>())!.share_code;
    expect(await relation(env.DB, '221', '222')).not.toBeNull();
    expect(await relation(env.DB, '222', '221')).not.toBeNull();
    expect((await api('/api/pets/221/memory/clear', { token: first, method: 'POST' })).status).toBe(200);
    expect((await api('/api/debates/read', { body: { code } })).status).toBe(404);
    expect(await relation(env.DB, '221', '222')).toBeNull();
    expect(await relation(env.DB, '222', '221')).not.toBeNull();
    expect((await api('/api/pets/222/relationships', { token: second })).body.relationships)
      .toMatchObject([{ tokenId: '221' }]);
    expect((await api('/api/pets/221/diary', { token: first })).status).toBe(200);
  });
});
