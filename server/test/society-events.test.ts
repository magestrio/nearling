import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clean } from '../src/cron';
import { recordExperienceEvent } from '../src/experience/events';
import { JUDGE_DELETE_AT } from '../src/judge';
import { recordSocietyEvent } from '../src/society/events';
import { api, harness } from './helpers/api';
import { NEAR_ACCOUNT, token } from './helpers/network';
import { addPets, advise, PAYER, payerToken, WORKER } from './helpers/work';

const h = harness();
const ids = { tabId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  playerId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', petId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' };

describe('coded society playtest events', () => {
  beforeEach(async () => {
    vi.setSystemTime(new Date('2026-11-15T10:00:00Z'));
    await env.EVENTS.prepare('DELETE FROM society_events').run();
    await env.EVENTS.prepare('DELETE FROM experience_events').run();
    await env.EVENTS.prepare('DELETE FROM showcase_event_counts').run();
  });

  // spec: add-pet-society › Society playtest data › relationship changed
  // spec: add-pet-society › Society playtest data › hire refused
  it('stores only coded state and refusal outcomes, with an idempotent event id', async () => {
    await recordSocietyEvent(env, 'pet_relationship_changed', { cause: 'paid_help', state: 'liked', ids });
    await recordSocietyEvent(env, 'pet_hire_refused', { by: 'pet', reason: 'relationship', ids, id: ids.tabId });
    await recordSocietyEvent(env, 'pet_hire_refused', { by: 'pet', reason: 'relationship', ids, id: ids.tabId });
    const rows = await env.EVENTS.prepare('SELECT name, cause, state, by_kind, reason, player_id, pet_id FROM society_events ORDER BY rowid').all<any>();
    expect(rows.results).toEqual([
      { name: 'pet_relationship_changed', cause: 'paid_help', state: 'liked', by_kind: null, reason: null, player_id: ids.playerId, pet_id: ids.petId },
      { name: 'pet_hire_refused', cause: null, state: null, by_kind: 'pet', reason: 'relationship', player_id: ids.playerId, pet_id: ids.petId },
    ]);
    expect(JSON.stringify(rows.results)).not.toMatch(/Pixel|Biscuit|token_id|question/i);
  });

  // spec: add-pet-society › Society playtest data › hire refused
  it('counts one actual relationship refusal without a paid model call', async () => {
    addPets(h);
    await env.DB.prepare(`INSERT INTO society_relations (token_id, other_id, created_at, stance, break_until)
      VALUES (?, ?, ?, 'strained', ?)`).bind(WORKER, PAYER, Date.now(), Date.now() + 86_400_000).run();
    const result = await advise(await payerToken());
    expect(result.code).toBe('society_refused');
    expect(h.net().ai.calls).toHaveLength(0);
    const events = await env.EVENTS.prepare("SELECT name, by_kind, reason FROM society_events WHERE name = 'pet_hire_refused'").all<any>();
    expect(events.results).toEqual([{ name: 'pet_hire_refused', by_kind: 'player', reason: 'relationship' }]);
  });

  // spec: add-pet-society › Society playtest data › hire paid
  it('marks a paid hire with discounted and keeps its once-only event row', async () => {
    await recordExperienceEvent(env, 'pet_hired', { experience: false, discounted: true, id: ids.tabId });
    await recordExperienceEvent(env, 'pet_hired', { experience: false, discounted: true, id: ids.tabId });
    await recordExperienceEvent(env, 'pet_hired', { experience: false, discounted: true, id: '991' });
    await recordExperienceEvent(env, 'experience_note_saved', { discounted: true });
    const rows = await env.EVENTS.prepare("SELECT name, experience, discounted FROM experience_events WHERE name = 'pet_hired'").all<any>();
    expect(rows.results).toEqual([{ name: 'pet_hired', experience: 0, discounted: 1 }]);
  });

  // spec: add-pet-society › Society playtest data › social diary seen
  it('accepts only a current owner with a social line and opaque event ids', async () => {
    const owner = NEAR_ACCOUNT(991);
    h.net().contract.addPet('991', owner);
    const tk = await token('did:privy:society-event', owner);
    const day = Math.floor(Date.now() / 86_400_000);
    await env.DB.prepare("INSERT INTO society_diary_lines (token_id, day, slot, line) VALUES ('991', ?, 1, 'Biscuit waved.')").bind(day).run();
    const body = { ...ids, eventId: ids.tabId };
    expect((await api('/api/pets/991/society/diary-seen', { token: tk, body })).status).toBe(204);
    expect((await api('/api/pets/991/society/diary-seen', { token: tk, body })).status).toBe(204);
    expect((await env.EVENTS.prepare("SELECT COUNT(*) AS n FROM society_events WHERE name = 'society_diary_seen'").first<{ n: number }>())?.n).toBe(1);
    expect((await env.EVENTS.prepare("SELECT n FROM showcase_event_counts WHERE scope = 'tab_minute' AND subject = ?")
      .bind(ids.tabId).first<{ n: number }>())?.n).toBe(1);
    expect((await api('/api/pets/991/society/diary-seen', { token: tk, body: { ...body, playerId: owner } })).status).toBe(400);
  });

  // spec: add-pet-society › Society playtest data › social diary seen
  it('silently drops diary views at each browser-event tab and IP limit', async () => {
    const owner = NEAR_ACCOUNT(992);
    h.net().contract.addPet('992', owner);
    const tk = await token('did:privy:society-event-limits', owner);
    const day = Math.floor(Date.now() / 86_400_000);
    const minute = Math.floor(Date.now() / 60_000);
    const ip = '198.51.100.99';
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ip));
    const ipKey = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
    await env.DB.prepare("INSERT INTO society_diary_lines (token_id, day, slot, line) VALUES ('992', ?, 1, 'Biscuit waved.')").bind(day).run();
    for (const [scope, subject, bucket, limit] of [
      ['tab_minute', ids.tabId, minute, 60], ['tab_day', ids.tabId, day, 1000],
      ['ip_minute', ipKey, minute, 600], ['ip_day', ipKey, day, 10000],
    ] as const) {
      await env.EVENTS.prepare('DELETE FROM showcase_event_counts').run();
      const admittedId = crypto.randomUUID();
      const excessId = crypto.randomUUID();
      const body = { ...ids, eventId: admittedId };
      expect((await api('/api/pets/992/society/diary-seen', { token: tk, ip, body })).status).toBe(204);
      await env.EVENTS.prepare('UPDATE showcase_event_counts SET n = ? WHERE scope = ? AND subject = ? AND bucket = ?')
        .bind(limit, scope, subject, bucket).run();
      expect((await api('/api/pets/992/society/diary-seen', { token: tk, ip, body: { ...body, eventId: excessId } })).status).toBe(204);
      expect(await env.EVENTS.prepare('SELECT 1 FROM society_events WHERE id = ?').bind(excessId).first()).toBeNull();
      expect((await env.EVENTS.prepare('SELECT n FROM showcase_event_counts WHERE scope = ? AND subject = ? AND bucket = ?')
        .bind(scope, subject, bucket).first<{ n: number }>())?.n).toBe(limit);
    }
  });

  // spec: add-pet-society › Society playtest data › relationship changed
  it('purges society and hire event rows at the playtest deadline', async () => {
    await recordSocietyEvent(env, 'pet_relationship_changed', { cause: 'rude', state: 'strained' });
    await recordExperienceEvent(env, 'pet_hired', { experience: false, discounted: false });
    await clean(env, JUDGE_DELETE_AT);
    expect((await env.EVENTS.prepare('SELECT 1 FROM society_events').first())).toBeNull();
    expect((await env.EVENTS.prepare('SELECT 1 FROM experience_events').first())).toBeNull();
  });
});
