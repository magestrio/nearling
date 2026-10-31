import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { growth } from '../src/cron';
import { writeDueGrowth } from '../src/pet/growth';
import { noteDeed } from '../src/pet/life';
import { run } from '../src/spend';
import { clearPause, setPause } from '../src/servicePause';
import { harness, say } from './helpers/api';
import { NEAR_ACCOUNT, token } from './helpers/network';

const h = harness();
const OWNER = NEAR_ACCOUNT(1);
const DAY_MS = 86_400_000;
const ONE_NEAR = (10n ** 24n).toString();

const today = () => Math.floor(Date.now() / DAY_MS);
const nextDay = () => vi.setSystemTime(Date.now() + DAY_MS);
const addPet = (id = '5') => h.net().contract.addPet(id, OWNER, { given_food: ONE_NEAR });
const reply = (id = '5') => run(env, id, { kind: 'reply', mode: 'chat', text: 'Tell me something' });
const write = (id = '5') => writeDueGrowth(env, id);
const deed = (kind: 'riddle' | 'work' | 'deep', id = '5') => env.DB.batch(noteDeed(env.DB, id, kind));
const rows = async (id = '5') => (await env.DB.prepare('SELECT stage, trait, sending_at, retry_day FROM pending_growth WHERE token_id = ? ORDER BY created_at, stage DESC').bind(id).all<any>()).results;
const lines = async (id = '5') =>
  (await env.DB.prepare("SELECT reply_text, model, price_yocto, payer, status, session_id FROM thoughts WHERE token_id = ? AND kind = 'growth' ORDER BY created_at, rowid").bind(id).all<any>()).results;
const gasRows = async () => (await env.DB.prepare("SELECT usd_micros FROM project_spend WHERE kind = 'gas'").all<any>()).results;
const grewEvents = () => h.events().filter((e) => e.name === 'pet_grew' || e.name === 'trait_gained');

/** A pet whose second counted day has been answered: a row for the teen waits, the chain says baby. */
async function teenWaiting(id = '5') {
  addPet(id);
  await reply(id);
  nextDay();
  await reply(id);
  expect((await rows(id)).map((r) => r.stage)).toEqual(['teen']);
}

describe('Growth flow', () => {
  // spec: add-pet-life › Growth flow › переход записан позже ответа
  it('sends the transition after the reply, makes the line of one transition and ends the row', async () => {
    await teenWaiting();
    h.net().contract.burnt = '2000000000000000000000';
    const reply = await env.DB.prepare("SELECT created_at FROM thoughts WHERE kind = 'reply' ORDER BY created_at DESC LIMIT 1").first<{ created_at: number }>();

    expect(await write()).toBe('written');
    const { sends, pets, grows } = h.net().contract;
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({ method: 'pet_grow', args: { token_id: '5', stage: 'Teen', trait: 'cozy' }, gas: '5000000000000', deposit: '0', signer: env.SERVER_ACCOUNT_ID });
    expect(grows).toEqual([{ token_id: '5', stage: 'Teen', trait: 'cozy' }]);
    expect(pets.get('5')).toMatchObject({ stage: 'Teen', traits: ['cozy'] });
    expect(await rows()).toEqual([]);
    // the line is a thought of the project: no model, no price, no session, nothing to bill
    expect(await lines()).toEqual([{ reply_text: 'Pixel is a teen now — and turned out cozy!', model: '', price_yocto: '0', payer: 'project', status: 'project', session_id: null }]);
    const line = await env.DB.prepare("SELECT created_at FROM thoughts WHERE kind = 'growth'").first<{ created_at: number }>();
    expect(line!.created_at).toBeGreaterThanOrEqual(reply!.created_at);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM thought_calls WHERE thought_id = (SELECT id FROM thoughts WHERE kind = ?)').bind('growth').first()).toEqual({ n: 0 });
    expect(grewEvents()).toEqual([
      { name: 'pet_grew', props: { stage: 'teen' } },
      { name: 'trait_gained', props: { trait: 'cozy' } },
    ]);
    expect(h.logs()).toContain('grow_sent');
    // the gas the send burned is the project's
    expect(await gasRows()).toHaveLength(1);
    // nothing is left to send
    expect(await write()).toBe('idle');
    expect(h.net().contract.sends).toHaveLength(1);
  });

  // spec: add-pet-life › Growth flow › переход записан позже ответа
  it('is written by the pet\'s desk right after the job\'s result when nothing holds it back', async () => {
    addPet();
    nextDay();
    const tk = await token('did:privy:owner', OWNER);
    const answer = await say(tk, '5', 'Hello');
    expect(answer.thought.text).toBe('Hello there, friend.');
    for (let i = 0; i < 400 && (await rows()).length > 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(h.net().contract.pets.get('5')!.stage).toBe('Teen');
    expect((await lines()).map((l) => l.reply_text)).toEqual(['Pixel is a teen now — and turned out cozy!']);
  });

  // spec: add-pet-life › Growth flow › переход записан позже ответа × the gas pause
  it('waits on the gas pause and is sent after it', async () => {
    await teenWaiting();
    await setPause(env.DB, 'gas', Date.now());
    expect(await write()).toBe('paused');
    expect(await growth(env, Date.now())).toBeUndefined();
    expect(h.net().contract.sends).toEqual([]);
    expect(await rows()).toHaveLength(1);
    expect(await lines()).toEqual([]);

    await clearPause(env.DB);
    await growth(env, Date.now());
    expect(h.net().contract.sends).toHaveLength(1);
    expect(await rows()).toEqual([]);
    expect(await lines()).toHaveLength(1);
  });

  // spec: add-pet-life › Growth flow › переход записан позже ответа × the AI pause
  it('is sent at once on the AI pause: only gas stops a stage change', async () => {
    await teenWaiting();
    await setPause(env.DB, 'ai', Date.now());
    expect(await write()).toBe('written');
    expect(h.net().contract.pets.get('5')!.stage).toBe('Teen');
  });

  // spec: add-pet-life › Growth flow › переход записан позже ответа × an unknown outcome that landed
  it('finds a transaction whose answer was lost by the read and sends nothing again', async () => {
    await teenWaiting();
    h.net().contract.mode = 'executed-but-silent';
    expect(await write()).toBe('failed');
    expect(h.logs()).toContain('grow_unknown');
    // the chain has it, the Worker does not know: the row stays, free to be claimed
    expect(h.net().contract.grows).toHaveLength(1);
    expect(await rows()).toMatchObject([{ stage: 'teen', sending_at: null }]);
    expect(await lines()).toEqual([]);

    h.net().contract.mode = 'normal';
    expect(await write()).toBe('found');
    expect(h.net().contract.sends).toHaveLength(1);
    expect(await lines()).toHaveLength(1);
    expect(await rows()).toEqual([]);
    expect(grewEvents().filter((e) => e.name === 'pet_grew')).toHaveLength(1);
    // the project's gas is booked only by the writer that sent
    expect(await gasRows()).toEqual([]);
  });

  // spec: add-pet-life › Growth flow › переход записан позже ответа × two writers
  it('lets two writers send once, make one line and one event', async () => {
    await teenWaiting();
    const [a, b] = await Promise.all([write(), write()]);
    expect([a, b].filter((r) => r === 'written')).toHaveLength(1);
    expect(h.net().contract.sends).toHaveLength(1);
    expect(await lines()).toHaveLength(1);
    expect(h.events().filter((e) => e.name === 'pet_grew')).toHaveLength(1);
  });

  // spec: add-pet-life › Growth flow › переход записан позже ответа × two writers
  it('leaves a transition another writer holds alone until its claim is stale', async () => {
    await teenWaiting();
    await env.DB.prepare('UPDATE pending_growth SET sending_at = ? WHERE token_id = ?').bind(Date.now() - 10_000, '5').run();
    expect(await write()).toBe('busy');
    expect(await growth(env, Date.now())).toBeUndefined();
    expect(h.net().contract.sends).toEqual([]);

    // the writer died: after a minute the claim is nobody's
    await env.DB.prepare('UPDATE pending_growth SET sending_at = ? WHERE token_id = ?').bind(Date.now() - 61_000, '5').run();
    await growth(env, Date.now());
    expect(h.net().contract.sends).toHaveLength(1);
    expect(await lines()).toHaveLength(1);
  });

  // spec: add-pet-life › Growth flow › переход записан позже ответа × a third counted day
  it('writes the teen first when the adult has been counted behind it, each with its own trait', async () => {
    addPet();
    await reply();
    nextDay();
    await reply();
    await deed('work');
    nextDay();
    await reply();
    expect(await rows()).toMatchObject([
      { stage: 'teen', trait: 'cozy' },
      { stage: 'adult', trait: 'hard_working' },
    ]);

    // the oldest first; the adult cannot follow in the same UTC day
    expect(await write()).toBe('written');
    expect(h.net().contract.pets.get('5')).toMatchObject({ stage: 'Teen', traits: ['cozy'] });
    expect(await write()).toBe('waiting');
    expect(await write()).toBe('idle');
    expect(h.net().contract.sends).toHaveLength(1);

    nextDay();
    expect(await write()).toBe('written');
    expect(h.net().contract.pets.get('5')).toMatchObject({ stage: 'Adult', traits: ['cozy', 'hard_working'] });
    expect((await lines()).map((l) => l.reply_text)).toEqual(['Pixel is a teen now — and turned out cozy!', 'Pixel is all grown up — and has become hard-working too!']);
    // `Growth flow` › «стал взрослым»: events `pet_grew` stage adult, `trait_gained`
    expect(grewEvents()).toEqual([
      { name: 'pet_grew', props: { stage: 'teen' } },
      { name: 'trait_gained', props: { trait: 'cozy' } },
      { name: 'pet_grew', props: { stage: 'adult' } },
      { name: 'trait_gained', props: { trait: 'hard_working' } },
    ]);
  });

  // spec: add-pet-life › Growth flow › переход записан позже ответа × a retry
  it('sends a transition that failed again with the same trait', async () => {
    await teenWaiting();
    h.net().contract.growFails = 'no_state';
    expect(await write()).toBe('failed');
    expect(h.logs()).toContain('grow_failed:no_state');
    expect(await rows()).toMatchObject([{ stage: 'teen', trait: 'cozy', sending_at: null }]);
    expect(await lines()).toEqual([]);

    h.net().contract.growFails = null;
    expect(await write()).toBe('written');
    const [first, second] = h.net().contract.sends;
    expect(second!.args).toEqual(first!.args);
    expect(h.net().contract.grows).toHaveLength(1);
  });

  // spec: add-pet-life › Growth flow › переход записан позже ответа × a retry
  it('leaves the row for the next try when the chain cannot be read, and sends nothing', async () => {
    await teenWaiting();
    h.net().contract.failingViews.add('pet_view');
    expect(await write()).toBe('unreadable');
    expect(await rows()).toMatchObject([{ stage: 'teen', sending_at: null }]);
    expect(h.net().contract.sends).toEqual([]);
    h.net().contract.failingViews.clear();
    expect(await write()).toBe('written');
  });

  // spec: add-pet-life › Growth flow › переход записан позже ответа × a retry
  it('tries at most ten pets in a cron tick', async () => {
    for (let i = 0; i < 12; i += 1) {
      const id = String(100 + i);
      h.net().contract.addPet(id, NEAR_ACCOUNT(10 + i), { stage_day: today() - 1 });
      await env.DB.prepare("INSERT INTO pending_growth (token_id, stage, trait, created_at) VALUES (?, 'teen', 'cozy', ?)").bind(id, i).run();
    }
    await growth(env, Date.now());
    expect(h.net().contract.sends).toHaveLength(10);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM pending_growth').first<{ n: number }>())!.n).toBe(2);
  });
});

describe('Pet growth contract', () => {
  // spec: add-pet-life › Pet growth contract › второе изменение стадии за сутки × a server that waits
  it('sends no transaction while the chain\'s last change is of today, and sends after 00:00 UTC', async () => {
    await teenWaiting();
    h.net().contract.pets.get('5')!.stage_day = today();
    expect(await write()).toBe('waiting');
    expect(h.net().contract.sends).toEqual([]);
    expect(await rows()).toMatchObject([{ stage: 'teen', sending_at: null, retry_day: today() + 1 }]);
    // no read of the chain in the minutes that follow: the row is not due
    const reads = h.net().contract.reads.length;
    expect(await write()).toBe('idle');
    await growth(env, Date.now());
    expect(h.net().contract.reads).toHaveLength(reads);

    nextDay();
    expect(await write()).toBe('written');
    expect(h.net().contract.sends).toHaveLength(1);
  });

  // spec: add-pet-life › Pet growth contract › второе изменение стадии за сутки × a server that waits
  it('waits for the next day when the contract refuses with stage_today after a read that said otherwise', async () => {
    await teenWaiting();
    h.net().contract.growFails = 'stage_today';
    expect(await write()).toBe('waiting');
    expect(h.net().contract.sends).toHaveLength(1);
    expect(await rows()).toMatchObject([{ retry_day: today() + 1 }]);
    expect(await lines()).toEqual([]);
    expect(h.logs().filter((l) => l.startsWith('grow_failed'))).toEqual([]);
  });
});

describe('Trait rule', () => {
  // spec: add-pet-life › Trait rule › черта уже есть
  it('names the strengthened trait in the adult\'s line and records it twice', async () => {
    addPet();
    await reply();
    await deed('riddle');
    nextDay();
    await reply();
    await write();
    await deed('riddle');
    nextDay();
    await reply();
    expect(await rows()).toMatchObject([{ stage: 'adult', trait: 'clever' }]);
    expect(await write()).toBe('written');

    expect(h.net().contract.pets.get('5')!.traits).toEqual(['clever', 'clever']);
    expect((await lines()).map((l) => l.reply_text)).toEqual(['Pixel is a teen now — and turned out clever!', 'Pixel is all grown up — and even more clever!']);
    expect(grewEvents()).toEqual([
      { name: 'pet_grew', props: { stage: 'teen' } },
      { name: 'trait_gained', props: { trait: 'clever' } },
      { name: 'pet_grew', props: { stage: 'adult' } },
      { name: 'trait_gained', props: { trait: 'clever' } },
    ]);
  });
});
