import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { forgetStatements } from '../src/pet/forget';
import { writeDueGrowth } from '../src/pet/growth';
import { noteDeed, noteFriend } from '../src/pet/life';
import { run } from '../src/spend';
import { api, harness } from './helpers/api';
import { NEAR_ACCOUNT, token } from './helpers/network';

const h = harness();
const OWNER = NEAR_ACCOUNT(1);
const DAY_MS = 86_400_000;
const ONE_NEAR = (10n ** 24n).toString();

const nextDay = () => vi.setSystemTime(Date.now() + DAY_MS);
const addPet = () => h.net().contract.addPet('5', OWNER, { given_food: ONE_NEAR });
const reply = (mode: 'chat' | 'deep' = 'chat') => run(env, '5', { kind: 'reply', mode, text: 'Tell me something' });
const clear = () => env.DB.batch(forgetStatements(env.DB, '5', Date.now()));
const lifeRow = () => env.DB.prepare('SELECT * FROM pet_life WHERE token_id = ?').bind('5').first<any>();
const friends = async () => (await env.DB.prepare('SELECT account FROM life_friends WHERE token_id = ?').bind('5').all<{ account: string }>()).results.map((r) => r.account);
const pending = async () => (await env.DB.prepare('SELECT stage, trait FROM pending_growth WHERE token_id = ?').bind('5').all<any>()).results;
const words = async () => (await env.DB.prepare('SELECT COUNT(*) AS n FROM thoughts WHERE token_id = ? AND (reply_text IS NOT NULL OR player_text IS NOT NULL)').bind('5').first<{ n: number }>())!.n;

describe('Pet life data', () => {
  // spec: add-pet-life › Pet life data › удаление памяти
  it('erases the lines with the line of a transition and keeps the days, the deeds, the mood, the energy and the stage', async () => {
    addPet();
    await reply();
    nextDay();
    await reply('deep');
    await writeDueGrowth(env, '5');
    await env.DB.batch([...noteDeed(env.DB, '5', 'riddle'), ...noteFriend(env.DB, '5', NEAR_ACCOUNT(2))]);
    const tk = await token('did:privy:owner', OWNER);
    const before = await lifeRow();
    expect(before).toMatchObject({ counted_days: 2, energy_used: 1 });
    expect(await env.DB.prepare("SELECT reply_text FROM thoughts WHERE kind = 'growth'").first()).not.toBeNull();
    expect((await api('/api/pets/5/conversation', { token: tk })).body.lines.some((l: any) => l.who === 'event')).toBe(true);

    await clear();

    expect(await words()).toBe(0);
    expect((await api('/api/pets/5/conversation', { token: tk })).body.lines).toEqual([]);
    expect(await lifeRow()).toEqual(before);
    expect(await friends()).toEqual([NEAR_ACCOUNT(2)]);
    // the stage and the traits are the chain's, which a clear never touches
    expect(h.net().contract.pets.get('5')).toMatchObject({ stage: 'Teen', traits: ['thoughtful'] });

    // growth goes on from the same count: the next day's reply is the third, and the riddle and the
    // friend kept through the clear tie for the adult's trait, which the order settles
    nextDay();
    await reply();
    expect(await lifeRow()).toMatchObject({ counted_days: 3 });
    expect(await pending()).toEqual([{ stage: 'adult', trait: 'clever' }]);
  });

  // spec: add-pet-life › Pet life data › удаление памяти × a transition waiting
  it('keeps a transition that waits through a clear and writes its line after it', async () => {
    addPet();
    await reply();
    nextDay();
    await reply();
    expect(await pending()).toHaveLength(1);
    const tk = await token('did:privy:owner', OWNER);

    await clear();
    expect(await pending()).toEqual([{ stage: 'teen', trait: 'cozy' }]);
    expect(await words()).toBe(0);

    expect(await writeDueGrowth(env, '5')).toBe('written');
    expect(h.net().contract.pets.get('5')).toMatchObject({ stage: 'Teen', traits: ['cozy'] });
    const lines = (await api('/api/pets/5/conversation', { token: tk })).body.lines;
    expect(lines).toEqual([expect.objectContaining({ who: 'event', text: 'Pixel is a teen now — and turned out cozy!' })]);
    expect(await pending()).toEqual([]);
  });
});
