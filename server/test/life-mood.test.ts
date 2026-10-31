import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { fullness } from '../src/pricing';
import { settleFeeding, type FeedingRow } from '../src/pet/settle';
import { moodFor } from '../src/pet/view';
import { run } from '../src/spend';
import { harness } from './helpers/api';
import { NEAR_ACCOUNT } from './helpers/network';

const h = harness();
const OWNER = NEAR_ACCOUNT(1);
const FRIEND = NEAR_ACCOUNT(2);
const DAY_MS = 86_400_000;
const STARTER = BigInt(env.STARTER_FOOD);
const today = () => Math.floor(Date.now() / DAY_MS);

const addPet = (patch: Record<string, unknown> = {}) => h.net().contract.addPet('5', OWNER, patch);
const life = () => env.DB.prepare('SELECT * FROM pet_life WHERE token_id = ?').bind('5').first<any>();
const friends = async () => (await env.DB.prepare('SELECT account FROM life_friends WHERE token_id = ?').bind('5').all<{ account: string }>()).results.map((r) => r.account);
/** The face a viewer would see now. */
async function face() {
  const pet = h.net().contract.pets.get('5')!;
  const food = BigInt(pet.project_food) + BigInt(pet.given_food);
  return moodFor(env.DB, '5', fullness(food).state, Date.now());
}

let n = 0;
/** A meal or a snack on its way for the pet, then the outcome the network gave. */
async function settle(a: { via: 'owner' | 'link'; source?: 'near' | 'snack'; account?: string }, outcome: { status: 'ok' } | { status: 'failed'; code: string } = { status: 'ok' }) {
  n += 1;
  const row: FeedingRow = {
    id: `meal${n}`,
    sub: `did:privy:p${n}`,
    account: a.account ?? (a.via === 'owner' ? OWNER : FRIEND),
    token_id: '5',
    source: a.source ?? 'near',
    via: a.via,
    deposit_yocto: null,
    tx_hash: null,
    created_at: Date.now(),
  };
  await env.DB.prepare('INSERT INTO feedings (id, sub, account, token_id, source, via, deposit_yocto, tx_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(row.id, row.sub, row.account, row.token_id, row.source, row.via, row.deposit_yocto, row.tx_hash, row.created_at)
    .run();
  expect(await settleFeeding(env, row, outcome)).toBe(true);
}

describe('Mood rule', () => {
  // spec: add-pet-life › Mood rule › радостный
  it('makes a fed pet happy after an event of today and calm before it', async () => {
    addPet();
    expect(await face()).toBe('calm');
    const out = await run(env, '5', { kind: 'reply', mode: 'chat', text: 'Hi' });
    expect('thoughtId' in out).toBe(true);
    expect(await life()).toMatchObject({ mood_day: today() });
    expect(await face()).toBe('happy');
  });

  // spec: add-pet-life › Mood rule › радостный × a confirmed meal or snack
  it('lifts the mood by a confirmed meal or snack, the owner\'s or a friend\'s', async () => {
    for (const a of [{ via: 'owner', source: 'near' }, { via: 'owner', source: 'snack' }, { via: 'link', source: 'near' }, { via: 'link', source: 'snack' }] as const) {
      await env.DB.exec('DELETE FROM pet_life');
      addPet();
      expect(await face()).toBe('calm');
      await settle(a);
      expect(await life(), `${a.via} ${a.source}`).toMatchObject({ mood_day: today() });
      expect(await face()).toBe('happy');
    }
  });

  // spec: add-pet-life › Mood rule › радостный × a confirmed meal or snack
  it('lifts nothing for a meal that failed', async () => {
    addPet();
    await settle({ via: 'owner' }, { status: 'failed', code: 'unreachable' });
    await settle({ via: 'link' }, { status: 'failed', code: 'feed_too_small' });
    expect(await life()).toBeNull();
    expect(await face()).toBe('calm');
  });

  // spec: add-pet-life › Mood rule › сонный
  it('makes a hungry pet sleepy over the events of the day', async () => {
    addPet({ project_food: (STARTER / 2n).toString() });
    await env.DB.prepare('INSERT INTO pet_life (token_id, mood_day) VALUES (?, ?)').bind('5', today()).run();
    expect(await face()).toBe('sleepy');
  });

  // spec: add-pet-life › Mood rule › сонный × a meal above the threshold
  it('turns a sleepy pet happy when a meal takes it above the hunger line', async () => {
    addPet({ project_food: (STARTER / 2n).toString() });
    expect(await face()).toBe('sleepy');
    // the meal reaches the contract before its consequences run
    h.net().contract.pets.get('5')!.given_food = STARTER.toString();
    await settle({ via: 'owner' });
    expect(await face()).toBe('happy');
  });

  // spec: add-pet-life › Mood rule › сонный × asleep
  it('shows no mood on a pet that sleeps, whatever happened today', async () => {
    addPet({ project_food: '0' });
    await env.DB.prepare('INSERT INTO pet_life (token_id, mood_day) VALUES (?, ?)').bind('5', today()).run();
    expect(await face()).toBeNull();
  });

  // spec: add-pet-life › Mood rule › новые сутки
  it('is calm again at 00:00 UTC with no write, until an event of the new day', async () => {
    addPet();
    await settle({ via: 'owner' });
    expect(await face()).toBe('happy');
    vi.setSystemTime(Date.now() + DAY_MS);
    expect(await face()).toBe('calm');
    await settle({ via: 'owner' });
    expect(await face()).toBe('happy');
  });

  // spec: add-pet-life › Mood rule › после отсутствия
  it('keeps a fed pet calm and a hungry one sleepy after days without a word', async () => {
    addPet();
    await settle({ via: 'owner' });
    vi.setSystemTime(Date.now() + 5 * DAY_MS);
    expect(await face()).toBe('calm');
    h.net().contract.pets.get('5')!.project_food = (STARTER / 2n).toString();
    expect(await face()).toBe('sleepy');
  });
});

describe('Trait rule', () => {
  // spec: add-pet-life › Trait rule › черта по делам × a friend feeding twice
  it('counts a friend once, whatever they fed and however often, and two friends as two', async () => {
    addPet();
    await settle({ via: 'link', source: 'near' });
    await settle({ via: 'link', source: 'snack' });
    await settle({ via: 'link', source: 'near' });
    expect(await friends()).toEqual([FRIEND]);
    await settle({ via: 'link', account: NEAR_ACCOUNT(3) });
    expect((await friends()).sort()).toEqual([FRIEND, NEAR_ACCOUNT(3)].sort());
  });

  // spec: add-pet-life › Trait rule › черта по делам × the owner's own meal
  it('counts the owner\'s own meal as no friend, and lifts the mood only', async () => {
    addPet();
    await settle({ via: 'owner', source: 'near' });
    await settle({ via: 'owner', source: 'snack' });
    expect(await friends()).toEqual([]);
    expect(await life()).toMatchObject({ mood_day: today(), riddles: 0, works: 0, deeps: 0 });
  });

  // spec: add-pet-life › Trait rule › черта по делам × a failed meal
  it('counts a friend\'s failed meal as no friend', async () => {
    addPet();
    await settle({ via: 'link' }, { status: 'failed', code: 'expired' });
    expect(await friends()).toEqual([]);
    expect(await life()).toBeNull();
  });
});
