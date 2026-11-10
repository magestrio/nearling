import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { finishBirth } from '../src/pet/birth';
import { clean } from '../src/cron';
import { JUDGE_DELETE_AT } from '../src/judge';
import { api, harness } from './helpers/api';
import { NEAR_ACCOUNT, token } from './helpers/network';

const h = harness();
const PLAYER = NEAR_ACCOUNT(80);
const TAB = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const boardEvent = (intent: 'opened' | 'pet_opened', tk?: string, petId?: string) =>
  api('/api/hire/event', { token: tk, body: { intent, device: 'phone', tabId: TAB, ...(petId === undefined ? {} : { petId }) } });

describe('repeat birth and board event seams', () => {
  beforeEach(async () => {
    vi.setSystemTime(new Date('2026-11-15T10:00:00Z'));
    await env.EVENTS.prepare('DELETE FROM hatch_again_events').run();
  });

  // spec: add-hatch-again › Repeat playtest data › birth counted
  it('emits one opaque first-birth event and one repeat event, only on first finalization', async () => {
    await token('did:privy:birth-events', PLAYER);
    await finishBirth(env, PLAYER, '0', 'first-hash', '0', null);
    await finishBirth(env, PLAYER, '0', 'first-hash', '0', null);
    await finishBirth(env, PLAYER, '1', 'repeat-hash', '0', '0');
    await finishBirth(env, PLAYER, '1', 'repeat-hash', '0', '0');
    const events = h.events().filter((event) => event.name === 'pet_born');
    expect(events).toHaveLength(2);
    expect(events.map((event) => event.props.repeat)).toEqual([false, true]);
    for (const event of events) expect(event.props.pet).toMatch(/^[0-9a-f]{32}$/);
    expect(events[0]!.props.pet).not.toBe(events[1]!.props.pet);
    expect(JSON.stringify([events, h.logs()])).not.toMatch(/first-hash|repeat-hash|\bPixel\b|\bNova\b|near|did:privy/);
    const saved = (await env.EVENTS.prepare('SELECT name, repeat, player_id, pet_id FROM hatch_again_events ORDER BY rowid').all<{
      name: string; repeat: number; player_id: string | null; pet_id: string;
    }>()).results;
    expect(saved).toHaveLength(2);
    expect(saved.map((row) => row.repeat)).toEqual([0, 1]);
    expect(saved.every((row) => /^[0-9a-f]{64}$/.test(row.player_id ?? '') && /^[0-9a-f]{32}$/.test(row.pet_id))).toBe(true);
    expect(JSON.stringify(saved)).not.toMatch(/did:privy|first-hash|repeat-hash|near|Pixel|Nova/);
    await env.EVENTS.prepare('DELETE FROM hatch_again_events WHERE pet_id = ?').bind(events[1]!.props.pet).run();
    await finishBirth(env, PLAYER, '1', 'repeat-hash', '0', '0');
    expect((await env.EVENTS.prepare('SELECT COUNT(*) AS n FROM hatch_again_events').first<{ n: number }>())?.n).toBe(2);
    expect(h.events().filter((event) => event.name === 'pet_born')).toHaveLength(2);
  });

  // spec: add-hatch-again › Repeat playtest data › birth counted
  // spec: add-hatch-again › Repeat birth flow › unknown outcome
  it('does not count a pending or rejected birth', async () => {
    h.net().contract.mode = 'lost';
    const tk = await token('did:privy:repeat-events', PLAYER);
    expect((await api('/api/hatch', { token: tk, body: { name: 'Nova' } })).status).toBe(202);
    expect(h.events().filter((event) => event.name === 'pet_born')).toHaveLength(0);
    h.net().contract.bornToday = 50;
    expect((await api('/api/hatch', { token: await token('did:privy:other-events', NEAR_ACCOUNT(81)), body: { name: 'Pixel' } })).status).toBe(409);
    expect(h.events().filter((event) => event.name === 'pet_born')).toHaveLength(0);
  });

  // spec: add-hatch-again › Repeat playtest data › guest board visit
  it('counts guest board visits without an ownership flag', async () => {
    expect(await boardEvent('opened')).toEqual({ status: 204, body: null });
    const petId = 'a'.repeat(32);
    await env.DB.prepare('INSERT INTO pet_public_ids (token_id, opaque_id) VALUES (?, ?)').bind('5', petId).run();
    expect(await boardEvent('pet_opened', undefined, petId)).toEqual({ status: 204, body: null });
    expect(h.events()).toEqual([
      { name: 'hire_board_opened', props: { device: 'phone' } },
      { name: 'hire_board_pet_opened', props: { device: 'phone', pet: petId } },
    ]);
    expect((await env.EVENTS.prepare('SELECT name, has_owned_pet, tab_id, player_id FROM hatch_again_events ORDER BY rowid').all()).results).toEqual([
      { name: 'hire_board_opened', has_owned_pet: null, tab_id: TAB, player_id: null },
      { name: 'hire_board_pet_opened', has_owned_pet: null, tab_id: TAB, player_id: null },
    ]);
  });

  // spec: add-hatch-again › Repeat playtest data › guest board visit
  it('derives signed-in ownership afresh and refuses an expired session before an event', async () => {
    const tk = await token('did:privy:board-events', PLAYER);
    expect((await boardEvent('opened', tk)).status).toBe(204);
    h.net().contract.addPet('5', PLAYER);
    const petId = 'b'.repeat(32);
    await env.DB.prepare('INSERT INTO pet_public_ids (token_id, opaque_id) VALUES (?, ?)').bind('5', petId).run();
    expect((await boardEvent('pet_opened', tk, petId)).status).toBe(204);
    expect(h.events()).toEqual([
      { name: 'hire_board_opened', props: { device: 'phone', has_owned_pet: false } },
      { name: 'hire_board_pet_opened', props: { device: 'phone', pet: petId, has_owned_pet: true } },
    ]);
    const saved = (await env.EVENTS.prepare('SELECT name, has_owned_pet, player_id FROM hatch_again_events ORDER BY rowid').all<{
      name: string; has_owned_pet: number; player_id: string;
    }>()).results;
    expect(saved.map((row) => row.has_owned_pet)).toEqual([0, 1]);
    expect(saved[0]!.player_id).toMatch(/^[0-9a-f]{64}$/);
    expect(saved[1]!.player_id).toBe(saved[0]!.player_id);
    const expired = await token('did:privy:expired-board', NEAR_ACCOUNT(82), { expiresIn: '-1s' });
    expect((await boardEvent('opened', expired)).status).toBe(401);
    expect(h.events()).toHaveLength(2);
  });

  // spec: add-hatch-again › Repeat playtest data › guest board visit
  it('erases coded events at the playtest deletion date and accepts none afterward', async () => {
    expect((await boardEvent('opened')).status).toBe(204);
    expect((await env.EVENTS.prepare('SELECT COUNT(*) AS n FROM hatch_again_events').first<{ n: number }>())?.n).toBe(1);
    vi.setSystemTime(new Date(JUDGE_DELETE_AT));
    await clean(env, JUDGE_DELETE_AT);
    expect((await env.EVENTS.prepare('SELECT COUNT(*) AS n FROM hatch_again_events').first<{ n: number }>())?.n).toBe(0);
    expect((await boardEvent('opened')).status).toBe(204);
    expect((await env.EVENTS.prepare('SELECT COUNT(*) AS n FROM hatch_again_events').first<{ n: number }>())?.n).toBe(0);
  });
});
