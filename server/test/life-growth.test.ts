import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { forgetStatements } from '../src/pet/forget';
import { noteDeed, noteFriend } from '../src/pet/life';
import { run } from '../src/spend';
import { harness } from './helpers/api';
import { NEAR_ACCOUNT } from './helpers/network';

const h = harness();
const OWNER = NEAR_ACCOUNT(1);
const DAY_MS = 86_400_000;
/** A pet that stays Full through a few deep thoughts. */
const ONE_NEAR = (10n ** 24n).toString();

const today = () => Math.floor(Date.now() / DAY_MS);
const nextDay = () => vi.setSystemTime(Date.now() + DAY_MS);
const addPet = (id = '5', patch: Record<string, unknown> = {}) => h.net().contract.addPet(id, OWNER, { given_food: ONE_NEAR, ...patch });
const reply = (id = '5', mode: 'chat' | 'deep' = 'chat') => run(env, id, { kind: 'reply', mode, text: 'Tell me something' });
const life = (id = '5') => env.DB.prepare('SELECT * FROM pet_life WHERE token_id = ?').bind(id).first<any>();
const pending = async (id = '5') => (await env.DB.prepare('SELECT stage, trait FROM pending_growth WHERE token_id = ? ORDER BY stage DESC').bind(id).all<{ stage: string; trait: string }>()).results;
const friends = async (id = '5') => (await env.DB.prepare('SELECT account FROM life_friends WHERE token_id = ?').bind(id).all<{ account: string }>()).results.map((r) => r.account);
const chainDayReads = () => h.net().contract.reads.filter((r) => r.method === 'hatch_view').length;
const deed = (kind: 'riddle' | 'work' | 'deep', id = '5') => env.DB.batch(noteDeed(env.DB, id, kind));
const friend = (account: string, id = '5') => env.DB.batch(noteFriend(env.DB, id, account));
/** The write of a transition, as `pet/growth.ts` will do it: the chain moves and the row goes. */
async function written(stage: 'Teen' | 'Adult', id = '5') {
  const pet = h.net().contract.pets.get(id)!;
  pet.stage = stage;
  pet.stage_day = today();
  await env.DB.prepare('DELETE FROM pending_growth WHERE token_id = ? AND stage = ?').bind(id, stage.toLowerCase()).run();
}

describe('Growth flow', () => {
  // spec: add-pet-life › Growth flow › стал подростком
  it('counts the second day on the owner\'s reply, fixes the trait and leaves the stage to the writer', async () => {
    addPet();
    // the birth day is the first counted day: a reply on it counts nothing and reads no day
    expect('thoughtId' in (await reply())).toBe(true);
    expect(await life()).toMatchObject({ counted_days: 1, last_counted_day: null });
    expect(await pending()).toEqual([]);
    expect(chainDayReads()).toBe(0);

    nextDay();
    expect('thoughtId' in (await reply())).toBe(true);
    expect(await life()).toMatchObject({ counted_days: 2, last_counted_day: today() });
    expect(await pending()).toEqual([{ stage: 'teen', trait: 'cozy' }]);
    expect(chainDayReads()).toBe(1);
    // nothing is written by the counting itself: the pet is a baby on the chain and no line exists
    expect(h.net().contract.pets.get('5')!.stage).toBe('Baby');
    expect(h.net().contract.sends).toEqual([]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM thoughts WHERE kind = 'growth'").first()).toEqual({ n: 0 });
  });

  // spec: add-pet-life › Growth flow › стал взрослым
  it('counts the third day, fixes the adult\'s own trait and stops counting there', async () => {
    addPet();
    await reply();
    nextDay();
    await reply();
    await written('Teen');
    await deed('work');
    nextDay();
    await reply();
    expect(await life()).toMatchObject({ counted_days: 3, last_counted_day: today() });
    expect(await pending()).toEqual([{ stage: 'adult', trait: 'hard_working' }]);

    // a later day counts nothing and reads nothing
    await written('Adult');
    const reads = chainDayReads();
    nextDay();
    await reply();
    expect(await life()).toMatchObject({ counted_days: 3 });
    expect(await pending()).toEqual([]);
    expect(chainDayReads()).toBe(reads);
  });

  // spec: add-pet-life › Growth flow › стал подростком × a second reply the same day
  it('counts nothing more on a second reply of the same day and reads no day for it', async () => {
    addPet();
    await reply();
    nextDay();
    await reply();
    const reads = chainDayReads();
    await reply();
    await reply('5', 'deep');
    expect(await life()).toMatchObject({ counted_days: 2, last_counted_day: today() });
    expect(await pending()).toHaveLength(1);
    expect(chainDayReads()).toBe(reads);
  });

  // spec: add-pet-life › Growth flow › стал подростком × a diary, a greeting, a wake thought
  it('does not count a diary, a greeting or a wake thought, nor lift the mood', async () => {
    addPet();
    nextDay();
    for (const job of [{ kind: 'diary', day: today() - 1 }, { kind: 'greeting' }, { kind: 'wake', cause: 'owner' }] as const) {
      expect('thoughtId' in (await run(env, '5', job))).toBe(true);
    }
    expect(await life()).toBeNull();
    expect(chainDayReads()).toBe(0);
    expect(await pending()).toEqual([]);
  });

  // spec: add-pet-life › Growth flow › стал подростком × an answer that did not come
  it('counts nothing for an answer that did not come: a failed call, an unsigned one, a free or a paid empty one', async () => {
    addPet();
    nextDay();
    h.net().ai.push({ status: 500 });
    expect(await reply()).toEqual({ code: 'ai_unavailable' });
    h.net().ai.push({ signature: 'never' });
    expect(await reply()).toEqual({ code: 'ai_unavailable' });
    h.net().ai.push({ content: '' }, { content: '' }, { content: '' });
    for (let i = 0; i < 3; i += 1) expect(await reply()).toEqual({ code: 'ai_unavailable' });
    // the fourth empty answer is paid by the pet and is still no answer
    h.net().ai.push({ content: '' });
    expect(await reply()).toMatchObject({ code: 'empty_paid' });
    expect(await life()).toBeNull();
    expect(chainDayReads()).toBe(0);
    expect(await pending()).toEqual([]);
  });

  // spec: add-pet-life › Growth flow › стал подростком × a skipped day
  it('counts one day for the next reply after days of absence, never the days between', async () => {
    addPet();
    await reply();
    vi.setSystemTime(Date.now() + 5 * DAY_MS);
    await reply();
    expect(await life()).toMatchObject({ counted_days: 2, last_counted_day: today() });
    expect(await pending()).toHaveLength(1);
  });

  // spec: add-pet-life › Growth flow › стал подростком × 00:00 UTC between the line and the answer
  it('counts the day the chain says at the answer, not the day of the line', async () => {
    addPet();
    const midnight = (today() + 1) * DAY_MS;
    vi.setSystemTime(midnight - 10_000);
    const lineDay = today();
    h.net().ai.push({ during: () => void vi.setSystemTime(midnight + 30_000) });
    await reply();
    expect(today()).toBe(lineDay + 1);
    expect(await life()).toMatchObject({ counted_days: 2, last_counted_day: lineDay + 1 });
    expect(await pending()).toHaveLength(1);
  });

  // spec: add-pet-life › Growth flow › стал подростком × 00:00 UTC between the line and the answer
  it('waits for the chain\'s day when the chain is a moment behind the Worker\'s clock', async () => {
    addPet();
    const born = today();
    nextDay();
    h.net().contract.dayOverride = born;
    await reply();
    expect(await life()).toMatchObject({ counted_days: 1, last_counted_day: null });
    expect(await pending()).toEqual([]);
    h.net().contract.dayOverride = born + 1;
    await reply();
    expect(await life()).toMatchObject({ counted_days: 2, last_counted_day: born + 1 });
  });

  // spec: add-pet-life › Growth flow › стал подростком × the chain's day does not read
  it('takes the Worker\'s clock when the chain\'s day cannot be read, and loses no day', async () => {
    addPet();
    nextDay();
    h.net().contract.failingViews.add('hatch_view');
    await reply();
    expect(await life()).toMatchObject({ counted_days: 2, last_counted_day: today() });
    expect(await pending()).toHaveLength(1);
    expect(h.logs()).toContain('chain_day_unread');
  });

  // spec: add-pet-life › Growth flow › стал подростком × the pet given away
  it('goes on counting for the new owner after a gift', async () => {
    addPet();
    await reply();
    h.net().contract.pets.get('5')!.owner_id = NEAR_ACCOUNT(2);
    nextDay();
    await reply();
    expect(await life()).toMatchObject({ counted_days: 2 });
    expect(await pending()).toHaveLength(1);
  });

  // spec: add-pet-life › Pet life data › удаление памяти
  it('counts a reply that a clear erased in flight: the pet answered', async () => {
    addPet();
    nextDay();
    h.net().ai.push({ during: async () => void (await env.DB.batch(forgetStatements(env.DB, '5', Date.now()))) });
    const out = await reply();
    expect('thoughtId' in out).toBe(true);
    const row = await env.DB.prepare('SELECT reply_text, erased_at FROM thoughts WHERE kind = ?').bind('reply').first<any>();
    expect(row.reply_text).toBeNull();
    expect(row.erased_at).not.toBeNull();
    expect(await life()).toMatchObject({ counted_days: 2 });
    expect(await pending()).toHaveLength(1);
  });
});

describe('Trait rule', () => {
  // spec: add-pet-life › Trait rule › черта по делам
  it('fixes the trait of the most frequent deed, the closing reply\'s own deed included', async () => {
    // sociable: two distinct friends (one of them twice) against one riddle
    addPet('5');
    await reply('5');
    await deed('riddle', '5');
    await friend('aa', '5');
    await friend('aa', '5');
    await friend('bb', '5');
    nextDay();
    await reply('5');
    expect(await pending('5')).toEqual([{ stage: 'teen', trait: 'sociable' }]);

    // thoughtful: a deep reply at birth and the deep reply that closes the window (a deed of that
    // window) make two against one riddle and one work
    addPet('6');
    await reply('6', 'deep');
    await deed('riddle', '6');
    await deed('work', '6');
    nextDay();
    await reply('6', 'deep');
    expect(await pending('6')).toEqual([{ stage: 'teen', trait: 'thoughtful' }]);
    expect(await life('6')).toMatchObject({ deeps: 0 });

    // clever: riddles lead
    addPet('7');
    await reply('7');
    await deed('riddle', '7');
    await deed('riddle', '7');
    await deed('work', '7');
    nextDay();
    await reply('7');
    expect(await pending('7')).toEqual([{ stage: 'teen', trait: 'clever' }]);
  });

  // spec: add-pet-life › Trait rule › черта по делам × a deed after the trait was chosen
  it('sends a deed after the choice to the next window: the deeds and the friends are reset at the transition', async () => {
    addPet();
    await reply();
    await deed('riddle');
    await friend('aa');
    nextDay();
    await reply();
    expect(await pending()).toEqual([{ stage: 'teen', trait: 'clever' }]);
    expect(await life()).toMatchObject({ riddles: 0, works: 0, deeps: 0 });
    expect(await friends()).toEqual([]);

    await deed('work');
    await friend('bb');
    await written('Teen');
    nextDay();
    await reply();
    // one work and one friend tie: sociable comes first in the order
    expect(await pending()).toEqual([{ stage: 'adult', trait: 'sociable' }]);
  });

  // spec: add-pet-life › Trait rule › черта по делам × a deed after adult
  it('keeps no deed and no friend from the adult step on', async () => {
    addPet();
    await reply();
    nextDay();
    await reply();
    nextDay();
    await reply();
    expect(await life()).toMatchObject({ counted_days: 3 });
    await deed('riddle');
    await deed('work');
    await deed('deep');
    await friend('aa');
    expect(await life()).toMatchObject({ riddles: 0, works: 0, deeps: 0 });
    expect(await friends()).toEqual([]);
  });
});
