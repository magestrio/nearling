// What the clear of a pet's memory does to the wardrobe (`Wardrobe data` › «удаление памяти»): the items
// on the chain, the worn item and the notices not yet shown all stay, and the next thought keeps the manner.
import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { clean, outfits } from '../src/cron';
import { OUTFITS } from '../src/pet/outfits';
import { finishReveal } from '../src/riddle/cron';
import { run } from '../src/spend';
import { api, harness } from './helpers/api';
import { NEAR_ACCOUNT, token } from './helpers/network';

const h = harness();
const OWNER = NEAR_ACCOUNT(1);
const owner = () => token('did:privy:owner', OWNER);
const clear = async () => api('/api/pets/5/memory/clear', { token: await owner(), body: {} });
const DAY_MS = 86_400_000;
const DAY = Math.floor(Date.UTC(2036, 10, 4) / DAY_MS);
const riddle = (day: number) => env.DB.prepare('INSERT INTO riddles (day, text, answers, salt, hash, sealed_at) VALUES (?, ?, ?, ?, ?, 1)').bind(day, 'r', '["a clock"]', 's', 'h').run();
const answered = (day: number) => env.DB.prepare("INSERT INTO riddle_answers (token_id, day, text, correct, answered_at) VALUES ('5', ?, 'a clock', 1, 1)").bind(day).run();
const count = (table: string) => env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>().then((r) => r!.n);
const wardrobeRow = () => env.DB.prepare('SELECT worn, seen FROM wardrobe WHERE token_id = ?').bind('5').first<{ worn: string | null; seen: number }>();

describe('Wardrobe data', () => {
  // spec: add-wardrobe › Wardrobe data › удаление памяти
  it('leaves the items, the worn item and the notices not yet shown', async () => {
    h.net().contract.addPet('5', OWNER, { outfits: [0, 2] });
    await env.DB.prepare('INSERT INTO wardrobe (token_id, worn, seen) VALUES (?, ?, ?)').bind('5', 'thinking-cap', 1).run();
    const before = (await api('/api/pets/5', { token: await owner() })).body;
    expect(before).toMatchObject({ worn: 'thinking-cap', outfits: ['daisy-crown', 'thinking-cap'], notices: ['thinking-cap'] });

    expect((await clear()).status).toBe(200);

    expect(await wardrobeRow()).toEqual({ worn: 'thinking-cap', seen: 1 });
    const after = (await api('/api/pets/5', { token: await owner() })).body;
    expect(after).toMatchObject({ worn: 'thinking-cap', outfits: ['daisy-crown', 'thinking-cap'], notices: ['thinking-cap'] });
    // a visitor sees the same worn item
    expect((await api('/api/pets/5')).body.worn).toBe('thinking-cap');
  });

  // spec: add-wardrobe › Wardrobe data › удаление памяти × the next thought's manner
  it('keeps the manner of the next thought: the same line, the same place', async () => {
    h.net().contract.addPet('5', OWNER, { given_food: (10n ** 24n).toString(), outfits: [3] });
    await env.DB.prepare('INSERT INTO wardrobe (token_id, worn, seen) VALUES (?, ?, ?)').bind('5', 'smart-glasses', 0).run();
    const lines = async () => {
      const out = await run(env, '5', { kind: 'reply', mode: 'chat', text: 'Tell me something' });
      expect('thoughtId' in out, JSON.stringify(out)).toBe(true);
      return h.net().ai.calls.at(-1)!.body.messages[0]!.content.split('\n');
    };
    const manner = OUTFITS.find((o) => o.slug === 'smart-glasses')!.manner;
    const before = await lines();
    expect(before).toContain(manner);

    expect((await clear()).status).toBe(200);

    const after = await lines();
    expect(after.indexOf(manner)).toBe(before.indexOf(manner));
    expect(after.filter((l) => !l.startsWith('Your mood today:'))).toEqual(before.filter((l) => !l.startsWith('Your mood today:')));
  });

  // spec: add-wardrobe › Wardrobe data › удаление памяти × an answer not revealed
  it('erases an answer not revealed yet, and a riddle revealed after it gives no grant', async () => {
    h.net().contract.addPet('5', OWNER);
    await riddle(DAY);
    await answered(DAY);
    vi.setSystemTime((DAY + 1) * DAY_MS + 60_000);
    expect((await clear()).status).toBe(200);
    expect(await count('riddle_answers')).toBe(0);

    await finishReveal(env, DAY, Date.now(), null);
    expect(await count('outfit_grants')).toBe(0);
    await outfits(env, Date.now());
    expect(h.net().contract.sends.filter((s) => s.method === 'outfit_grant')).toEqual([]);
    expect(h.net().contract.pets.get('5')!.outfits).toEqual([]);
  });

  // spec: add-wardrobe › Wardrobe data › удаление памяти × an answer past the next day
  it('erases the verdict an unrevealed answer kept past the next day, and the late reveal gives no grant', async () => {
    h.net().contract.addPet('5', OWNER);
    await riddle(DAY);
    await answered(DAY);
    const late = (DAY + 2) * DAY_MS + 36_000_000;
    vi.setSystemTime(late);
    await clean(env, late);
    expect(await env.DB.prepare('SELECT text, correct FROM riddle_answers').first()).toEqual({ text: '', correct: 1 });
    expect((await clear()).status).toBe(200);
    expect(await count('riddle_answers')).toBe(0);

    await finishReveal(env, DAY, late, null);
    expect(await count('outfit_grants')).toBe(0);
    await outfits(env, late);
    expect(h.net().contract.pets.get('5')!.outfits).toEqual([]);
  });

  // spec: add-wardrobe › Wardrobe data › удаление памяти × a grant waiting
  it('leaves a grant waiting: the riddle was solved, and the item is written after the clear', async () => {
    h.net().contract.addPet('5', OWNER);
    await riddle(DAY);
    await answered(DAY);
    vi.setSystemTime((DAY + 1) * DAY_MS + 60_000);
    await finishReveal(env, DAY, Date.now(), null);
    expect(await count('outfit_grants')).toBe(1);
    expect((await clear()).status).toBe(200);
    expect(await count('outfit_grants')).toBe(1);

    await outfits(env, Date.now());
    expect(await count('outfit_grants')).toBe(0);
    expect(h.net().contract.pets.get('5')!.outfits).toEqual([2]);
  });
});
