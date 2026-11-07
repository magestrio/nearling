import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { clean } from '../src/cron';
import { recordWillEvent } from '../src/will/events';
import { harness } from './helpers/api';
import { addPets, advise, payerToken } from './helpers/work';

const h = harness();
const rows = () => env.EVENTS.prepare('SELECT * FROM will_events ORDER BY at, id').all<Record<string, unknown>>();

describe('coded will events', () => {
  // spec: add-pet-will › Will playtest data › coded event delivery
  it('writes only bounded enum and numeric outcomes, once per transition id', async () => {
    vi.setSystemTime(new Date('2026-11-07T12:00:00Z'));
    await env.EVENTS.exec('DELETE FROM will_events');
    const id = 'a'.repeat(24);
    expect(await recordWillEvent(env, 'pet_wish_chosen', { id })).toBe(1);
    expect(await recordWillEvent(env, 'pet_wish_chosen', { id })).toBe(0);
    expect(await recordWillEvent(env, 'pet_wish_saved', { amount_usd: 0.01 })).toBe(1);
    expect(await recordWillEvent(env, 'outfit_bought', { via: 'pet_wish' })).toBe(1);
    expect(await recordWillEvent(env, 'pet_work_invited')).toBe(1);
    expect(await recordWillEvent(env, 'pet_work_invitation_accepted')).toBe(1);
    expect(await recordWillEvent(env, 'pet_hire_refused', { reason: 'character', by: 'player', project_usd: 0.02 })).toBe(1);
    const all = (await rows()).results;
    expect(all).toHaveLength(6);
    expect(all.every((row) => row.tab_id === null && row.player_id === null && row.pet_id === null)).toBe(true);
  });

  // spec: add-pet-will › Will playtest data › coded event delivery
  it('rejects words, token ids, identities, unexpected props and out-of-range amounts', async () => {
    vi.setSystemTime(new Date('2026-11-07T12:00:00Z'));
    await env.EVENTS.exec('DELETE FROM will_events');
    expect(await recordWillEvent(env, 'pet_wish_chosen', { id: '701' })).toBeNull();
    expect(await recordWillEvent(env, 'pet_hire_refused', { reason: 'character', by: 'player', project_usd: 0.01,
      question: 'Who are you?' } as never)).toBeNull();
    expect(await recordWillEvent(env, 'pet_wish_saved', { amount_usd: -1 })).toBeNull();
    expect(await recordWillEvent(env, 'pet_work_invited', { ids: { tabId: 'owner.near', playerId: 'email@example.com', petId: '701' } })).toBeNull();
    expect((await rows()).results).toHaveLength(0);
  });

  // spec: add-pet-will › Will playtest data › coded event delivery
  it('stops writes and erases the events at the December 1 cut-off', async () => {
    vi.setSystemTime(new Date('2026-11-30T23:59:59Z'));
    await env.EVENTS.exec('DELETE FROM will_events');
    expect(await recordWillEvent(env, 'pet_work_invited')).toBe(1);
    vi.setSystemTime(new Date('2026-12-01T00:00:00Z'));
    expect(await recordWillEvent(env, 'pet_work_invited')).toBe(0);
    await clean(env, Date.now());
    expect((await rows()).results).toHaveLength(0);
  });

  // spec: add-pet-will › Will playtest data › coded event delivery
  it('records a character refusal only after a signed decline reaches the payer', async () => {
    vi.setSystemTime(new Date('2026-11-07T12:00:00Z'));
    await env.EVENTS.exec('DELETE FROM will_events');
    addPets(h);
    h.net().ai.push({ content: '[[will:decline:I cannot take this request.]]' });
    expect((await advise(await payerToken())).code).toBe('character_refused');
    const events = (await rows()).results;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ name: 'pet_hire_refused', reason: 'character', by_kind: 'player' });
    expect(JSON.stringify(events)).not.toMatch(/question|answer|owner|account|token_id|cannot take/i);
  });
});
