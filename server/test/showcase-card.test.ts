import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clean } from '../src/cron';
import { api, harness } from './helpers/api';
import { NEAR_ACCOUNT, token } from './helpers/network';

const h = harness();
const owner = NEAR_ACCOUNT(51);
const next = NEAR_ACCOUNT(52);
const petId = '751';
const lineId = 'a'.repeat(24);

async function storedLine() {
  await env.DB.prepare(
    "INSERT INTO thoughts (id, token_id, created_at, kind, player_text, reply_text, model, price_yocto, price_usd_micros, payer, status) VALUES (?, ?, ?, 'reply', ?, ?, 'm', '0', 0, 'pet', 'billed')",
  ).bind(lineId, petId, Date.now(), 'private prompt', 'A pet-authored line',).run();
}

beforeEach(async () => {
  await env.EVENTS.prepare('DELETE FROM showcase_card_shared').run();
  await env.EVENTS.prepare('DELETE FROM showcase_event_counts').run();
  await env.EVENTS.prepare('DELETE FROM showcase_event_attempt').run();
  h.net().contract.addPet(petId, owner, { name: 'Juniper', stage: 'Teen', project_food: '0', given_food: '0' });
});

describe('Pet card source data', () => {
  // spec: add-showcase › Pet card source data › owner selects a retained line
  it('checks the chain owner and returns only one selected retained line', async () => {
    await storedLine();
    await env.DB.prepare("INSERT INTO wardrobe (token_id, worn, seen) VALUES (?, 'cozy-scarf', 0)").bind(petId).run();
    const tk = await token('did:privy:card-owner', owner);
    expect((await api(`/api/pets/${petId}/card-lines`, { token: tk })).body).toEqual({ lines: [{ id: lineId, text: 'A pet-authored line' }] });
    const selected = await api(`/api/pets/${petId}/card-source`, { token: tk, body: { kind: 'thought', thoughtId: lineId } });
    expect(selected).toEqual({ status: 200, body: { tokenId: petId, name: 'Juniper', kind: 'thought', thoughtId: lineId, line: 'A pet-authored line' } });
    expect(JSON.stringify(selected.body)).not.toContain('private prompt');
    expect(JSON.stringify((await api(`/api/pets/${petId}/card-lines`, { token: tk })).body)).not.toContain('private prompt');
    expect((await api(`/api/pets/${petId}/card-source`, { token: tk, body: { kind: 'growth' } })).body.stage).toBe('teen');
    expect((await api(`/api/pets/${petId}/card-source`, { token: tk, body: { kind: 'outfit' } })).body.worn).toBe('cozy-scarf');
    expect(h.net().ai.calls).toHaveLength(0);
    expect(h.net().contract.sends).toHaveLength(0);
  });

  // spec: add-showcase › Pet card source data › owner selects a retained line
  it('orders eligible choice text newest first without player or ineligible words', async () => {
    await storedLine();
    await env.DB.prepare("INSERT INTO thoughts (id, token_id, created_at, kind, player_text, reply_text, model, price_yocto, price_usd_micros, payer, status) VALUES (?, ?, ?, 'diary', ?, ?, 'm', '0', 0, 'pet', 'billed')")
      .bind('b'.repeat(24), petId, Date.now() + 1, 'private diary prompt', 'A newer diary line').run();
    await env.DB.prepare("INSERT INTO thoughts (id, token_id, created_at, kind, player_text, reply_text, model, price_yocto, price_usd_micros, payer, status) VALUES (?, ?, ?, 'player', ?, ?, 'm', '0', 0, 'pet', 'billed')")
      .bind('c'.repeat(24), petId, Date.now() + 2, 'private user line', 'not pet authored').run();
    const tk = await token('did:privy:card-choice-order', owner);
    expect((await api(`/api/pets/${petId}/card-lines`, { token: tk })).body).toEqual({ lines: [
      { id: 'b'.repeat(24), text: 'A newer diary line' },
      { id: lineId, text: 'A pet-authored line' },
    ] });
  });

  // spec: add-showcase › Pet card source data › former owner requests a line
  it('denies the prior owner after a gift before reading words', async () => {
    await storedLine();
    const tk = await token('did:privy:former-owner', owner);
    h.net().contract.pets.get(petId)!.owner_id = next;
    expect(await api(`/api/pets/${petId}/card-source`, { token: tk, body: { kind: 'thought', thoughtId: lineId } }))
      .toEqual({ status: 403, body: { code: 'not_owner' } });
    expect(await api(`/api/pets/${petId}/card-lines`, { token: tk })).toEqual({ status: 403, body: { code: 'not_owner' } });
  });

  // spec: add-showcase › Pet card source data › selected words erased
  it('cannot resolve an erased line even when a stale tab still holds its id', async () => {
    await storedLine();
    const tk = await token('did:privy:card-cleared', owner);
    expect((await api(`/api/pets/${petId}/memory/clear`, { token: tk, body: {} })).status).toBe(200);
    expect((await api(`/api/pets/${petId}/card-source`, { token: tk, body: { kind: 'thought', thoughtId: lineId } })).body)
      .toEqual({ code: 'thought_erased' });
    expect((await api(`/api/pets/${petId}/card-lines`, { token: tk })).body).toEqual({ lines: [] });
  });

  // spec: add-showcase › Pet card source data › owner selects a retained line × new thought/memory clear/gift/outfit change/growth/asleep/wake/00:00 UTC
  it('reads stage and worn outfit now, without requiring food or caching across changes', async () => {
    const tk = await token('did:privy:card-current', owner);
    expect((await api(`/api/pets/${petId}/card-source`, { token: tk, body: { kind: 'outfit' } })).body.code).toBe('no_outfit');
    await env.DB.prepare("INSERT INTO wardrobe (token_id, worn, seen) VALUES (?, 'cozy-scarf', 0)").bind(petId).run();
    expect((await api(`/api/pets/${petId}/card-source`, { token: tk, body: { kind: 'outfit' } })).body.worn).toBe('cozy-scarf');
    h.net().contract.pets.get(petId)!.stage = 'Adult';
    expect((await api(`/api/pets/${petId}/card-source`, { token: tk, body: { kind: 'growth' } })).body.stage).toBe('adult');
  });
});

describe('Pet card sharing event data', () => {
  const ids = { tabId: crypto.randomUUID(), playerId: crypto.randomUUID(), petId: crypto.randomUUID() };

  // spec: add-showcase › Pet card sharing event data › image saved
  // spec: add-showcase › Pet card sharing event data › image shared
  it('stores only allowlisted completed save and share events in EVENTS', async () => {
    vi.setSystemTime(new Date('2026-11-05T12:00:00Z'));
    const tk = await token('did:privy:card-event', owner);
    for (const [kind, delivery] of [['thought', 'save'], ['growth', 'share'], ['outfit', 'save']] as const) {
      expect((await api('/api/showcase/card-shared', { token: tk, body: { ...ids, kind, delivery, at: Date.now() } })).status).toBe(204);
    }
    const rows = await env.EVENTS.prepare('SELECT at, kind, delivery, tab_id, player_id, pet_id FROM showcase_card_shared ORDER BY rowid').all();
    expect(rows.results).toEqual([['thought', 'save'], ['growth', 'share'], ['outfit', 'save']].map(([kind, delivery]) => ({
      at: Date.now(), kind, delivery, tab_id: ids.tabId, player_id: ids.playerId, pet_id: ids.petId,
    })));
    expect(JSON.stringify(rows.results)).not.toMatch(/Juniper|751|private prompt|A pet-authored line|did:privy/);
    expect(h.net().contract.sends).toHaveLength(0);
  });

  // spec: add-showcase › Pet card sharing event data › share not completed
  it('rejects content and identity fields and writes no event without a session', async () => {
    vi.setSystemTime(new Date('2026-11-05T12:00:00Z'));
    const tk = await token('did:privy:card-event-bad', owner);
    const valid = { ...ids, kind: 'thought', delivery: 'save', at: Date.now() };
    expect((await api('/api/showcase/card-shared', { body: valid })).status).toBe(401);
    for (const extra of [{ line: 'words' }, { image: 'data:image/png;base64,x' }, { tokenId: petId }, { accountId: owner }, { url: `/pet/${petId}` }, { email: 'a@example.test' }]) {
      expect((await api('/api/showcase/card-shared', { token: tk, body: { ...valid, ...extra } })).status).toBe(400);
    }
    expect((await api('/api/showcase/card-shared', { token: tk, body: { ...valid, kind: 'unknown' } })).status).toBe(400);
    expect((await api('/api/showcase/card-shared', { token: tk, body: { ...valid, delivery: 'cancel' } })).status).toBe(400);
    expect((await env.EVENTS.prepare('SELECT COUNT(*) AS n FROM showcase_card_shared').first<{ n: number }>())?.n).toBe(0);
  });

  it('erases on December 1 and accepts nothing later', async () => {
    vi.setSystemTime(new Date('2026-11-30T23:59:00Z'));
    const tk = await token('did:privy:card-event-expiry', owner);
    const body = { ...ids, kind: 'thought', delivery: 'save', at: Date.now() };
    expect((await api('/api/showcase/card-shared', { token: tk, body })).status).toBe(204);
    vi.setSystemTime(new Date('2026-12-01T00:00:00Z'));
    await clean(env, Date.now());
    expect((await env.EVENTS.prepare('SELECT COUNT(*) AS n FROM showcase_card_shared').first<{ n: number }>())?.n).toBe(0);
    expect((await api('/api/showcase/card-shared', { token: tk, body })).status).toBe(204);
    expect((await env.EVENTS.prepare('SELECT COUNT(*) AS n FROM showcase_card_shared').first<{ n: number }>())?.n).toBe(0);
  });

  // spec: add-showcase › Pet card sharing event data › image saved
  it('silently drops the 61st card event in a minute for one tab', async () => {
    vi.setSystemTime(new Date('2026-11-05T12:00:00Z'));
    const tk = await token('did:privy:card-event-limit', owner);
    const body = { ...ids, kind: 'thought', delivery: 'save', at: Date.now() };
    for (let i = 0; i < 61; i += 1) {
      expect((await api('/api/showcase/card-shared', { token: tk, body })).status).toBe(204);
    }
    expect((await env.EVENTS.prepare('SELECT COUNT(*) AS n FROM showcase_card_shared WHERE tab_id = ?').bind(ids.tabId).first<{ n: number }>())?.n).toBe(60);
    expect((await env.EVENTS.prepare('SELECT COUNT(*) AS n FROM showcase_event_attempt').first<{ n: number }>())?.n).toBe(0);
  });

  // spec: add-showcase › Pet card sharing event data › image shared
  it('uses the server IP and UTC windows for the minute and day caps', async () => {
    const ip = '198.51.100.173';
    const ipBytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ip)));
    const ipKey = Array.from(ipBytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    const start = Date.parse('2026-11-05T12:00:00Z');
    vi.setSystemTime(start);
    let tk = await token('did:privy:card-event-ip', owner);
    const minute = Math.floor(start / 60_000);
    const day = Math.floor(start / 86_400_000);
    await env.EVENTS.batch([
      env.EVENTS.prepare('INSERT INTO showcase_event_counts VALUES (?, ?, ?, ?, ?)').bind('ip_minute', ipKey, minute, (minute + 1) * 60_000, 599),
      env.EVENTS.prepare('INSERT INTO showcase_event_counts VALUES (?, ?, ?, ?, ?)').bind('ip_day', ipKey, day, (day + 1) * 86_400_000, 9998),
    ]);
    const send = (tabId: string) => api('/api/showcase/card-shared', {
      token: tk, ip, body: { ...ids, tabId, kind: 'outfit', delivery: 'share', at: Date.now() },
    });
    expect((await send(crypto.randomUUID())).status).toBe(204);
    expect((await send(crypto.randomUUID())).status).toBe(204);
    expect((await env.EVENTS.prepare('SELECT COUNT(*) AS n FROM showcase_card_shared').first<{ n: number }>())?.n).toBe(1);
    expect((await env.EVENTS.prepare("SELECT n FROM showcase_event_counts WHERE scope = 'ip_day' AND subject = ? AND bucket = ?")
      .bind(ipKey, day).first<{ n: number }>())?.n).toBe(9999);
    await env.EVENTS.prepare("DELETE FROM showcase_event_counts WHERE scope = 'ip_minute' AND subject = ?").bind(ipKey).run();
    expect((await send(crypto.randomUUID())).status).toBe(204);
    expect((await send(crypto.randomUUID())).status).toBe(204);
    expect((await env.EVENTS.prepare('SELECT COUNT(*) AS n FROM showcase_card_shared').first<{ n: number }>())?.n).toBe(2);
    expect((await env.EVENTS.prepare("SELECT n FROM showcase_event_counts WHERE scope = 'ip_day' AND subject = ? AND bucket = ?")
      .bind(ipKey, day).first<{ n: number }>())?.n).toBe(10000);
    expect(JSON.stringify((await env.EVENTS.prepare('SELECT * FROM showcase_card_shared').all()).results)).not.toContain(ipKey);
    vi.setSystemTime(Date.parse('2026-11-06T00:00:00Z'));
    await clean(env, Date.now());
    expect((await env.EVENTS.prepare("SELECT COUNT(*) AS n FROM showcase_event_counts WHERE subject = ?").bind(ipKey).first<{ n: number }>())?.n).toBe(0);
    tk = await token('did:privy:card-event-ip', owner);
    expect((await send(crypto.randomUUID())).status).toBe(204);
    expect((await env.EVENTS.prepare('SELECT COUNT(*) AS n FROM showcase_card_shared').first<{ n: number }>())?.n).toBe(3);
  });

  // spec: add-showcase › Pet card sharing event data › image saved
  it('caps a tab at 1,000 accepted events in one UTC day across minutes', async () => {
    const start = Date.parse('2026-11-05T12:00:00Z');
    vi.setSystemTime(start);
    const tk = await token('did:privy:card-event-day', owner);
    const day = Math.floor(start / 86_400_000);
    await env.EVENTS.prepare('INSERT INTO showcase_event_counts VALUES (?, ?, ?, ?, ?)')
      .bind('tab_day', ids.tabId, day, (day + 1) * 86_400_000, 999).run();
    const body = { ...ids, kind: 'thought', delivery: 'save', at: start };
    expect((await api('/api/showcase/card-shared', { token: tk, body })).status).toBe(204);
    vi.setSystemTime(start + 60_000);
    expect((await api('/api/showcase/card-shared', { token: tk, body })).status).toBe(204);
    expect((await env.EVENTS.prepare('SELECT COUNT(*) AS n FROM showcase_card_shared').first<{ n: number }>())?.n).toBe(1);
  });
});
