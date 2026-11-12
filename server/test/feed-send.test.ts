// `POST …/feed/send`, `POST …/feed/outcome`, `GET …/feed` and the cron around the meal on its way: the
// server's check of what the browser signed, the in-flight row, and the consequences of a confirmed
// meal, run once whichever flow learns the outcome first (`Feeding outcome rule`, design.md › Решения).
import { env } from 'cloudflare:workers';
import { actions, createTransaction, Transaction } from 'near-api-js';
import { describe, expect, it } from 'vitest';
import { recentBlockHash } from '../src/chain';
import { settleFeedIntroductions, settleStaleFeedings } from '../src/cron';
import { implicitKey } from '../src/feeding/portion';
import { forgetStatements } from '../src/pet/forget';
import { FEEDINGS_COLUMNS, settleFeeding, type FeedingRow } from '../src/pet/settle';
import { pendingFriendWake } from '../src/pet/wake';
import { setPause } from '../src/servicePause';
import { api, harness } from './helpers/api';
import { keyedPlayer, NEAR_ACCOUNT, token } from './helpers/network';

const h = harness();
const NEAR = 10n ** 24n;
const MILLI = 10n ** 21n;
const OWNER = NEAR_ACCOUNT(71);

/** A pet that fell asleep: no food, the server's note of the sleep in place. */
async function asleepPet(id = '7') {
  const pet = h.net().contract.addPet(id, OWNER, { project_food: '0' });
  await env.DB.prepare('INSERT INTO pets (token_id, hatched_by, born_at, birth_tx, slept_at) VALUES (?, ?, 1, ?, 1)').bind(id, OWNER, '').run();
  return pet;
}
async function awakePet(id = '7') {
  const pet = h.net().contract.addPet(id, OWNER);
  await env.DB.prepare('INSERT INTO pets (token_id, hatched_by, born_at, birth_tx) VALUES (?, ?, 1, ?)').bind(id, OWNER, '').run();
  return pet;
}

type Keyed = ReturnType<typeof keyedPlayer> & { token: string };
async function player(balance = NEAR, name: string | null = 'Maya'): Promise<Keyed> {
  const p = keyedPlayer();
  h.net().contract.balances.set(p.account, balance);
  const tk = await token(`did:privy:${p.account}`, p.account);
  if (name !== null) await env.DB.prepare('UPDATE players SET first_name = ? WHERE account_id = ?').bind(name, p.account).run();
  return { ...p, token: tk };
}
/** The owner, with a key of their own so they can feed. */
async function keyedOwner(id = '7') {
  const p = await player(NEAR, null);
  h.net().contract.pets.get(id)!.owner_id = p.account;
  return p;
}

const build = async (p: Keyed, portion = '0.01', id = '7') => (await api(`/api/pets/${id}/feed`, { token: p.token, body: { portion } })).body.tx as string;
const send = async (p: Keyed, tx: string, id = '7') => api(`/api/pets/${id}/feed/send`, { token: p.token, body: await p.sign(tx) });
/** Build, sign, send. */
const feed = async (p: Keyed, portion = '0.01', id = '7') => send(p, await build(p, portion, id), id);
const rows = async (sql: string) => (await env.DB.prepare(sql).all<any>()).results;
const one = async (sql: string) => (await env.DB.prepare(sql).first<any>())!;

describe('what the server sends for the player', () => {
  /** A transaction of the player's own key, shaped as the test says. */
  async function crafted(p: Keyed, shape: { receiver?: string; method?: string; args?: object; deposit?: bigint; gas?: bigint; extra?: boolean }) {
    const publicKey = implicitKey(p.account)!;
    const call = actions.functionCall(shape.method ?? 'pet_feed', shape.args ?? { token_id: '7' }, shape.gas ?? 5_000_000_000_000n, shape.deposit ?? 10n * MILLI);
    const list = shape.extra ? [call, actions.transfer(1n)] : [call];
    const tx = createTransaction(p.account, publicKey, shape.receiver ?? env.CONTRACT_ID, 101n, list, await recentBlockHash(env));
    return btoa(String.fromCharCode(...tx.encode()));
  }

  // spec: add-feeding › Feeding transaction data › прислана не та порция
  it('is nothing but one pet_feed of this pet, from the session\'s account, with one of the three portions - anything else is 400 and not sent', async () => {
    await awakePet();
    const p = await player();
    const shapes = [
      { receiver: 'evil.testnet' },
      { method: 'pet_snack' },
      { method: 'nft_transfer' },
      { deposit: 20n * MILLI },
      { deposit: 0n },
      { args: { token_id: '8' } },
      { args: { token_id: '7', extra: 1 } },
      { extra: true },
      { gas: 31_000_000_000_000n },
    ];
    for (const shape of shapes) {
      const res = await send(p, await crafted(p, shape));
      expect(res, Object.keys(shape).join()).toEqual({ status: 400, body: { code: 'bad_tx' } });
    }
    // trailing bytes, a transaction of another account, a signature that is not this key's
    const good = await build(p);
    const padded = btoa(String.fromCharCode(...Uint8Array.from(atob(good), (c) => c.charCodeAt(0)), 0));
    expect((await send(p, padded)).body).toEqual({ code: 'bad_tx' });
    const other = await player();
    expect((await send(other, good)).body).toEqual({ code: 'bad_tx' });
    const wrong = { tx: good, signature: btoa(String.fromCharCode(...new Uint8Array(64).fill(3))) };
    expect((await api('/api/pets/7/feed/send', { token: p.token, body: wrong })).body).toEqual({ code: 'bad_tx' });
    expect((await api('/api/pets/7/feed/send', { token: p.token, body: { tx: good, signature: 'AAAA' } })).body).toEqual({ code: 'bad_tx' });
    expect((await api('/api/pets/7/feed/send', { token: p.token, body: { tx: 5 } })).status).toBe(400);
    expect(h.net().contract.attempts).toBe(0);
    expect(await rows('SELECT * FROM feedings')).toEqual([]);
  });

  // spec: add-feeding › Feeding transaction data › прислана не та порция
  it('is for a pet that exists and a visitor is turned away', async () => {
    await awakePet();
    const p = await player();
    const tx = await build(p);
    expect((await send(p, tx, '99')).status).toBe(400);
    expect((await api('/api/pets/7/feed/send', { body: { tx, signature: 'x' } })).status).toBe(401);
  });
});

describe('a friend\'s portion, confirmed', () => {
  // spec: add-feeding › Feed by link flow › друг покормил
  it('feeds the pet, wakes it with the friend\'s name, remembers the friend, and runs its consequences once', async () => {
    await asleepPet();
    const p = await player(NEAR, 'Maya');
    const res = await feed(p, '0.05');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok', friend: 'Maya', hatched: false });
    expect(typeof res.body.hash).toBe('string');
    // the chain has the meal
    expect(h.net().contract.feeds).toEqual([{ token_id: '7', feeder: p.account, amount: (50n * MILLI).toString() }]);
    // nothing stays on its way
    expect(await rows('SELECT * FROM feedings')).toEqual([]);
    // the pet is awake, the wake is counted with the friend's name, and one wake thought is queued
    expect(await one("SELECT slept_at, wake_seq, wake_by FROM pets WHERE token_id = '7'")).toEqual({ slept_at: null, wake_seq: 1, wake_by: 'Maya' });
    expect(await rows("SELECT payload FROM jobs WHERE kind = 'wake'")).toHaveLength(1);
    expect(await rows("SELECT name FROM memory_notes WHERE token_id = '7' AND kind = 'fed_by'")).toEqual([{ name: 'Maya' }]);
    expect(await rows('SELECT account FROM known_index')).toEqual([{ account: p.account }]);
    expect(h.events().filter((e) => e.name === 'pet_fed')).toEqual([{ name: 'pet_fed', props: { via: 'link', source: 'near' } }]);
    expect(h.events().filter((e) => e.name === 'pet_woke')).toEqual([{ name: 'pet_woke', props: { via: 'link' } }]);
    // the wallet's last-read balance fell by the deposit, so the spent NEAR never reads as a change
    expect(BigInt((await one('SELECT wallet_seen_yocto AS s FROM players WHERE account_id = ?'.replace('?', `'${p.account}'`))).s)).toBe(NEAR - 50n * MILLI);
    // a friend's portion costs the project nothing but the storage of the new acquaintance, if the pool paid it
    expect(await rows('SELECT kind FROM project_spend')).toEqual([{ kind: 'storage' }]);
  });

  // spec: add-feeding › Feed by link flow › друг покормил
  it('reads the pet once more after a second when the node that answered was behind: the friend still wakes it by name', async () => {
    await asleepPet();
    const p = await player();
    const contract = h.net().contract;
    const real = contract.view.bind(contract);
    let behind = 1;
    contract.view = (method, args) => {
      const pet = real(method, args) as { given_food: string } | null;
      if (method === 'pet_view' && contract.feeds.length > 0 && behind > 0 && pet !== null) {
        behind -= 1;
        return { ...pet, given_food: '0' };
      }
      return pet;
    };
    expect((await feed(p)).body.status).toBe('ok');
    expect(behind).toBe(0);
    expect(await one("SELECT slept_at, wake_by FROM pets WHERE token_id = '7'")).toEqual({ slept_at: null, wake_by: 'Maya' });
    expect(await rows("SELECT name FROM memory_notes WHERE token_id = '7'")).toEqual([{ name: 'Maya' }]);
  });

  // spec: add-feeding › Feed by link flow › друг покормил
  it('remembers the friend of an awake pet too: the note, the index, no wake', async () => {
    await awakePet();
    const p = await player(NEAR, 'Maya');
    expect((await feed(p)).body.status).toBe('ok');
    expect(await one("SELECT slept_at, wake_seq, wake_by FROM pets WHERE token_id = '7'")).toEqual({ slept_at: null, wake_seq: 0, wake_by: null });
    expect(await rows("SELECT * FROM jobs WHERE kind = 'wake'")).toEqual([]);
    expect(await rows("SELECT name FROM memory_notes WHERE token_id = '7'")).toEqual([{ name: 'Maya' }]);
    expect(await rows('SELECT account FROM known_index')).toEqual([{ account: p.account }]);
  });

  // spec: add-feeding › Feeder name rule › имя не подошло
  it('keeps a feeder with no name nameless: the note and the wake carry an empty name', async () => {
    await asleepPet();
    const p = await player(NEAR, null);
    const res = await feed(p);
    expect(res.body.status).toBe('ok');
    expect(res.body.friend).toBeUndefined();
    expect(await one("SELECT wake_by FROM pets WHERE token_id = '7'")).toEqual({ wake_by: '' });
    expect(await rows("SELECT name FROM memory_notes WHERE token_id = '7'")).toEqual([{ name: '' }]);
  });

  // spec: add-feeding › Feed by link flow › друг покормил
  it('says whether the friend hatched a pet of their own, for the thanks', async () => {
    await awakePet();
    const p = await player();
    h.net().contract.hatchedBy.set(p.account, '3');
    expect((await feed(p)).body.hatched).toBe(true);
  });

  // spec: add-feeding › Pet knows contract › known account × a confirmed meal or snack of a friend
  it('writes one index row for a friend however many meals, and none for the owner', async () => {
    await awakePet();
    const p = await player();
    await feed(p);
    await feed(p);
    expect(await rows('SELECT account FROM known_index')).toEqual([{ account: p.account }]);
    expect(h.net().contract.feeds).toHaveLength(2);
    const owner = await keyedOwner();
    await feed(owner);
    expect(await rows('SELECT account FROM known_index')).toEqual([{ account: p.account }]);
  });

  // spec: add-feeding › Pet knows contract › known account × a pool that did not cover
  it('keeps the index row when the pool did not cover the chain\'s record: the meal stands, pet_knows stays false', async () => {
    await awakePet();
    const p = await player();
    h.net().contract.pool = 0n;
    expect((await feed(p)).body.status).toBe('ok');
    expect(await rows('SELECT account FROM known_index')).toEqual([{ account: p.account }]);
    expect(h.net().contract.known.size).toBe(0);
    expect(await rows('SELECT * FROM project_spend')).toEqual([]);
  });

  // spec: add-feeding › Pet knows contract › known account × Clear memory
  it('survives Clear memory: the index goes with the pet, the note does not', async () => {
    await asleepPet();
    const p = await player();
    await feed(p);
    await env.DB.batch(forgetStatements(env.DB, '7', Date.now()));
    expect(await rows('SELECT account FROM known_index')).toEqual([{ account: p.account }]);
    expect(await rows('SELECT * FROM memory_notes')).toEqual([]);
  });

  // spec: add-feeding › Pet knows contract › known account × a confirmed meal or snack of a friend
  it('writes the storage of a new acquaintance into the project\'s spend when the chain recorded it', async () => {
    await awakePet();
    const p = await player();
    expect((await feed(p)).body.status).toBe('ok');
    expect(h.net().contract.known.size).toBe(1);
    expect(await rows("SELECT kind FROM project_spend")).toEqual([{ kind: 'storage' }]);
  });
});

describe('the owner\'s own portion', () => {
  // spec: add-feeding › Own pet feeding flow › разбудил
  it('wakes the sleeping pet at the outcome, with no friend and no note, and indexes nobody', async () => {
    await asleepPet();
    const owner = await keyedOwner();
    const res = await feed(owner, '0.2');
    expect(res.body).toMatchObject({ status: 'ok', hatched: false });
    expect(res.body.friend).toBeUndefined();
    expect(await one("SELECT slept_at, wake_seq, wake_by FROM pets WHERE token_id = '7'")).toEqual({ slept_at: null, wake_seq: 1, wake_by: null });
    expect(await rows('SELECT * FROM memory_notes')).toEqual([]);
    expect(await rows('SELECT * FROM known_index')).toEqual([]);
    expect(h.events().filter((e) => e.name === 'pet_fed')).toEqual([{ name: 'pet_fed', props: { via: 'owner', source: 'near' } }]);
    expect(h.events().filter((e) => e.name === 'pet_woke')).toEqual([{ name: 'pet_woke', props: { via: 'owner' } }]);
  });

  // spec: add-feeding › Own pet feeding flow › накормил бодрствующего
  it('feeds an awake pet and wakes nothing', async () => {
    await awakePet();
    const owner = await keyedOwner();
    expect((await feed(owner)).body.status).toBe('ok');
    expect(h.net().contract.feeds).toHaveLength(1);
    expect(await rows("SELECT * FROM jobs WHERE kind = 'wake'")).toEqual([]);
  });
});

describe('the outcome of a portion', () => {
  // spec: add-feeding › Feeding outcome rule › не прошло
  it('is failed when the chain refuses the signed portion: the row goes, nothing else runs, the NEAR stays', async () => {
    await asleepPet();
    const p = await player();
    h.net().contract.mode = 'not-enough-balance';
    const res = await feed(p);
    expect(res.body).toMatchObject({ status: 'failed' });
    expect(res.body.friend).toBeUndefined();
    expect(await rows('SELECT * FROM feedings')).toEqual([]);
    expect(await rows('SELECT * FROM known_index')).toEqual([]);
    expect(await rows('SELECT * FROM memory_notes')).toEqual([]);
    expect(h.net().contract.feeds).toEqual([]);
    expect(h.events().filter((e) => e.name === 'pet_fed')).toEqual([]);
    expect(h.logs()).toContain('feed_failed:not_enough_balance');
    // the player may try again at once
    h.net().contract.mode = 'normal';
    expect((await feed(p)).body.status).toBe('ok');
  });

  // spec: add-feeding › Feeding outcome rule › не прошло
  it('is failed when the contract refuses the meal after it ran: nothing is remembered', async () => {
    await asleepPet();
    const p = await player();
    const tx = await build(p);
    // the pet vanishes from the chain while the transaction is on its way: the receipt fails
    h.net().contract.meanwhile.send_tx = async () => {
      h.net().contract.pets.delete('7');
    };
    const res = await send(p, tx);
    expect(res.body).toMatchObject({ status: 'failed' });
    expect(h.logs()).toContain('feed_failed:no_pet');
    expect(await rows('SELECT * FROM feedings')).toEqual([]);
    expect(await rows('SELECT * FROM known_index')).toEqual([]);
    expect(await rows('SELECT * FROM memory_notes')).toEqual([]);
    expect(await one("SELECT wake_seq FROM pets WHERE token_id = '7'")).toEqual({ wake_seq: 0 });
  });

  // spec: add-feeding › Feeding outcome rule › отправлено × a second tab
  it('takes one portion at a time: a second signed portion with another hash is 409 pending while the first has no outcome', async () => {
    await awakePet();
    const p = await player();
    const first = await build(p, '0.01');
    const second = await build(p, '0.05');
    h.net().contract.mode = 'lost';
    expect((await send(p, first)).body).toMatchObject({ status: 'unknown' });
    expect(await send(p, second)).toEqual({ status: 409, body: { code: 'pending' } });
    expect(await rows('SELECT * FROM feedings')).toHaveLength(1);
  });

  // spec: add-feeding › Feeding outcome rule › исход неизвестен × the repeat of the same bytes
  it('is asked again with the same signed bytes: the network never saw them, so they go out again and the row settles', async () => {
    await asleepPet();
    const p = await player();
    const tx = await build(p);
    h.net().contract.mode = 'lost';
    const first = await send(p, tx);
    expect(first.body).toMatchObject({ status: 'unknown' });
    expect(await rows('SELECT id FROM feedings')).toHaveLength(1);
    expect(h.net().contract.feeds).toEqual([]);
    h.net().contract.mode = 'normal';
    const again = await send(p, tx);
    expect(again.body).toMatchObject({ status: 'ok', hash: first.body.hash });
    expect(h.net().contract.feeds).toHaveLength(1);
    expect(await rows('SELECT * FROM feedings')).toEqual([]);
    expect(await rows("SELECT * FROM jobs WHERE kind = 'wake'")).toHaveLength(1);
  });

  // spec: add-feeding › Feeding outcome rule › исход неизвестен × the repeat of the same bytes
  it('finds the meal already on the chain when the answer was lost: the repeat settles it by its hash, never a second meal', async () => {
    await asleepPet();
    const p = await player();
    const tx = await build(p);
    h.net().contract.mode = 'executed-but-silent';
    expect((await send(p, tx)).body.status).toBe('unknown');
    expect(h.net().contract.feeds).toHaveLength(1);
    h.net().contract.mode = 'normal';
    expect((await send(p, tx)).body.status).toBe('ok');
    expect(h.net().contract.feeds).toHaveLength(1);
    expect(await rows("SELECT * FROM memory_notes")).toHaveLength(1);
  });

  // spec: add-feeding › Feeding outcome rule › отправлено × a second tab
  it('answers the same for the same bytes sent twice at once, and runs the consequences once', async () => {
    await asleepPet();
    const p = await player();
    const tx = await build(p);
    const [a, b] = await Promise.all([send(p, tx), send(p, tx)]);
    expect(a.body.status).toBe('ok');
    expect(b.body.status).toBe('ok');
    expect(h.net().contract.feeds).toHaveLength(1);
    expect(await rows('SELECT * FROM memory_notes')).toHaveLength(1);
    expect(await rows("SELECT * FROM jobs WHERE kind = 'wake'")).toHaveLength(1);
    expect(h.events().filter((e) => e.name === 'pet_fed')).toHaveLength(1);
  });

  // spec: add-feeding › Feeding outcome rule › отправлено × a second tab
  it('answers a repeat of a settled portion from the chain: the player\'s key has used the nonce, so nothing runs again', async () => {
    await asleepPet();
    const p = await player();
    const tx = await build(p);
    const first = await send(p, tx);
    const again = await send(p, tx);
    expect(again.body).toMatchObject({ status: 'ok', hash: first.body.hash });
    expect(h.net().contract.feeds).toHaveLength(1);
    expect(await rows('SELECT * FROM memory_notes')).toHaveLength(1);
    expect(await rows("SELECT * FROM jobs WHERE kind = 'wake'")).toHaveLength(1);
  });

  // spec: add-feeding › Feeding transaction data › прислана не та порция
  it('goes on a pause of the services: the signed portion is sent, its gas is the wallet\'s', async () => {
    await awakePet();
    const p = await player();
    await setPause(env.DB, 'gas', Date.now());
    expect((await feed(p)).body.status).toBe('ok');
  });
});

describe('a meal whose tab went away', () => {
  // spec: add-feeding › Feeding outcome rule › исход неизвестен × the tab closed
  it('is settled by the cron from the chain after a minute, and the consequences run once', async () => {
    await asleepPet();
    const p = await player();
    h.net().contract.mode = 'executed-but-silent';
    await send(p, await build(p));
    h.net().contract.mode = 'normal';
    // too young for the cron
    await settleStaleFeedings(env, Date.now() + 30_000);
    expect(await rows('SELECT * FROM feedings')).toHaveLength(1);
    await settleStaleFeedings(env, Date.now() + 90_000);
    expect(await rows('SELECT * FROM feedings')).toEqual([]);
    expect(await one("SELECT wake_seq FROM pets WHERE token_id = '7'")).toEqual({ wake_seq: 1 });
    await settleStaleFeedings(env, Date.now() + 120_000);
    expect(await rows("SELECT * FROM jobs WHERE kind = 'wake'")).toHaveLength(1);
  });

  // spec: add-pet › Sleep and wake flow › разбудил друг при открытой странице × cron settles before a readable pet view
  it('keeps the cron-settled friend pending until the owner poll can claim the wake', async () => {
    await asleepPet();
    const owner = await token('did:privy:owner', OWNER);
    const maya = await player(NEAR, 'Maya');
    h.net().contract.mode = 'executed-but-silent';
    await send(maya, await build(maya));
    h.net().contract.mode = 'normal';
    h.net().contract.failingViews.add('pet_view');
    await settleStaleFeedings(env, Date.now() + 90_000);
    expect(await rows('SELECT * FROM feedings')).toEqual([]);
    expect(await rows('SELECT name FROM pending_feed_wakes')).toEqual([{ name: 'Maya' }]);
    expect(await rows("SELECT * FROM jobs WHERE kind = 'wake'")).toEqual([]);
    h.net().contract.failingViews.clear();
    expect((await api('/api/pets/7/state?wakes=0', { token: owner })).body.friend).toBe('Maya');
    expect(await rows('SELECT * FROM pending_feed_wakes')).toEqual([]);
    expect(await rows("SELECT payload FROM jobs WHERE kind = 'wake'")).toHaveLength(1);
  });

  // spec: add-feeding › Feeding outcome rule › исход неизвестен × the reference block expired
  it('is failed after 24 hours when the network never answered: the portion can no longer land', async () => {
    await awakePet();
    const p = await player();
    h.net().contract.mode = 'lost';
    await send(p, await build(p));
    await settleStaleFeedings(env, Date.now() + 23 * 3_600_000);
    expect(await rows('SELECT * FROM feedings')).toHaveLength(1);
    await settleStaleFeedings(env, Date.now() + 25 * 3_600_000);
    expect(await rows('SELECT * FROM feedings')).toEqual([]);
    expect(h.logs()).toContain('feed_failed:expired');
    expect(await rows('SELECT * FROM known_index')).toEqual([]);
  });

  // spec: add-feeding › Feeding outcome rule › closed on its way × a reload
  it('is told to a reloaded tab by the pet\'s answer, for this player and this pet only', async () => {
    await awakePet();
    h.net().contract.addPet('8', OWNER);
    const p = await player();
    const other = await player();
    h.net().contract.mode = 'lost';
    const sent = await send(p, await build(p));
    const mine = await api('/api/pets/7', { token: p.token });
    expect(mine.body.myFeed).toEqual({ id: sent.body.hash, source: 'near' });
    expect((await api('/api/pets/8', { token: p.token })).body.myFeed).toBeNull();
    expect((await api('/api/pets/7', { token: other.token })).body.myFeed).toBeNull();
    expect((await api('/api/pets/7')).body.myFeed).toBeUndefined();
    // the owner sees none of a friend's row
    expect((await api('/api/pets/7', { token: await token('did:privy:owner', OWNER) })).body.myFeed).toBeNull();
  });
});

describe('the reopened sheet and the outcome route', () => {
  // spec: add-feeding › Feeding outcome rule › reopened on its way
  it('carries the player\'s meal on its way as pending until the network answers, then settles it once', async () => {
    await asleepPet();
    const p = await player();
    h.net().contract.mode = 'executed-but-silent';
    const sent = await send(p, await build(p));
    // not seen yet by the network's answer to the sheet: the fake shows it, so it settles at the read
    h.net().contract.mode = 'normal';
    h.net().contract.txBlind = true;
    const pending = (await api('/api/pets/7/feed', { token: p.token })).body;
    expect(pending.pending).toEqual({ id: sent.body.hash, source: 'near', tokenId: '7' });
    h.net().contract.txBlind = false;
    const settled = (await api('/api/pets/7/feed', { token: p.token })).body;
    expect(settled.pending).toBeNull();
    expect(await one("SELECT wake_seq FROM pets WHERE token_id = '7'")).toEqual({ wake_seq: 1 });
    expect((await api('/api/pets/7/feed', { token: p.token })).body.pending).toBeNull();
    expect(await rows("SELECT * FROM jobs WHERE kind = 'wake'")).toHaveLength(1);
  });

  // spec: add-feeding › Feeding outcome rule › reopened on its way
  it('answers a tab without the signed bytes: unknown while the row stands, then the outcome - with and without a row', async () => {
    await awakePet();
    const p = await player();
    h.net().contract.mode = 'executed-but-silent';
    const sent = await send(p, await build(p));
    h.net().contract.txBlind = true;
    const ask = () => api('/api/pets/7/feed/outcome', { token: p.token, body: { id: sent.body.hash, source: 'near' } });
    const standing = (await ask()).body;
    expect(standing).toMatchObject({ status: 'unknown' });
    // the row stands: a flow is still to end it, so the tab has no exit yet
    expect(standing).not.toHaveProperty('settled');
    h.net().contract.txBlind = false;
    h.net().contract.mode = 'normal';
    expect((await ask()).body).toMatchObject({ status: 'ok', hash: sent.body.hash });
    // the row is gone now: the chain answers by the hash
    expect(await rows('SELECT * FROM feedings')).toEqual([]);
    expect((await ask()).body).toMatchObject({ status: 'ok' });
    expect(h.net().contract.feeds).toHaveLength(1);
    // a hash the network does not answer for and no row: its silence is never «failed», but it carries
    // the marker that no row stands, which ends the tab's watch
    expect((await api('/api/pets/7/feed/outcome', { token: p.token, body: { id: '9'.repeat(44), source: 'near' } })).body).toMatchObject({ status: 'unknown', settled: true });
  });

  // spec: add-feeding › Feeding outcome rule › исход неизвестен × a slow network after the outcome
  it('tells a tab what the chain recorded when the network is slow after the row was settled: never «failed» on silence', async () => {
    await awakePet();
    const p = await player();
    const tx = await build(p);
    const first = await send(p, tx);
    expect(first.body.status).toBe('ok');
    // the row is gone, and the node keeps the hash waiting past our own read
    h.net().contract.txBlind = true;
    const ask = await api('/api/pets/7/feed/outcome', { token: p.token, body: { id: first.body.hash, source: 'near' } });
    expect(ask.body).toMatchObject({ status: 'unknown' });
    // a repeat holds the signed bytes: they go out again, and the node answers for what it has
    const again = await send(p, tx);
    expect(again.body).toMatchObject({ status: 'ok', hash: first.body.hash });
    expect(h.net().contract.feeds).toHaveLength(1);
    expect(await rows('SELECT * FROM memory_notes')).toHaveLength(1);
    expect(h.events().filter((e) => e.name === 'pet_fed')).toHaveLength(1);
  });

  // spec: add-feeding › Feeding outcome rule › исход неизвестен × a slow network after the outcome
  it('is failed for a repeat only when the node refuses the bytes and the hash is nowhere: another transaction took the nonce', async () => {
    await awakePet();
    const p = await player();
    const tx = await build(p);
    expect((await send(p, await build(p))).body.status).toBe('ok'); // the nonce goes to another transaction
    h.net().contract.txBlind = true;
    h.net().contract.mode = 'invalid-nonce';
    expect((await send(p, tx)).body).toMatchObject({ status: 'failed' });
  });
});

describe('a read that fails right after the chain recorded the meal', () => {
  /** The pet can no longer be read from the moment the transaction reaches the node. */
  const readsFailAtTheSend = () => {
    h.net().contract.meanwhile.send_tx = async () => {
      h.net().contract.failingViews.add('pet_view');
    };
  };

  // spec: add-pet › Sleep and wake flow › разбудил друг при открытой странице × overlapping state polls
  it('keeps the named first thought when a second poll sees the first poll already awake', async () => {
    await asleepPet();
    const p = await player(NEAR, 'Maya');
    readsFailAtTheSend();
    expect((await feed(p)).body.status).toBe('ok');
    h.net().contract.failingViews.clear();

    let updated!: () => void;
    let resume!: () => void;
    const updateDone = new Promise<void>((resolve) => { updated = resolve; });
    const release = new Promise<void>((resolve) => { resume = resolve; });
    // On the old path, pause after the wake UPDATE commits but before the job INSERT.
    // The second poll then observes an awake pet and cleans up the pending row.
    const db = new Proxy(env.DB, {
      get(target, key) {
        if (key === 'prepare') return (sql: string) => {
          const statement = target.prepare(sql);
          if (!sql.startsWith('UPDATE pets SET slept_at = NULL') || sql.includes('AND EXISTS (SELECT 1 FROM jobs')) return statement;
          return new Proxy(statement, {
            get(prepared, method) {
              if (method !== 'bind') return Reflect.get(prepared, method);
              return (...values: unknown[]) => {
                const bound = prepared.bind(...values);
                return new Proxy(bound, {
                  get(query, operation) {
                    if (operation !== 'run') return Reflect.get(query, operation);
                    return async () => {
                      const result = await query.run();
                      updated();
                      await release;
                      return result;
                    };
                  },
                });
              };
            },
          });
        };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const wakeEnv = { ...env, DB: db } as Env;
    const first = pendingFriendWake(wakeEnv, '7');
    const order = await Promise.race([updateDone.then(() => 'paused'), first.then(() => 'complete')]);
    if (order === 'paused') {
      await pendingFriendWake(wakeEnv, '7');
      resume();
    } else {
      await pendingFriendWake(wakeEnv, '7');
    }
    await first;
    expect(await rows('SELECT * FROM pending_feed_wakes')).toEqual([]);
    expect(await one("SELECT slept_at, wake_seq, wake_by FROM pets WHERE token_id = '7'"))
      .toEqual({ slept_at: null, wake_seq: 1, wake_by: 'Maya' });
    const jobs = await rows("SELECT payload FROM jobs WHERE kind = 'wake'");
    expect(jobs).toHaveLength(1);
    expect(JSON.parse(jobs[0].payload)).toMatchObject({ cause: 'link', friend: 'Maya' });
  });

  // spec: add-feeding › Feeding outcome rule › отправлено × settlement retry during a pending named wake
  it('does not replace the pending attribution when settlement retries after the first claim', async () => {
    await asleepPet();
    const owner = await token('did:privy:owner', OWNER);
    const maya = await player(NEAR, 'Maya');
    const tx = await build(maya);
    let stale: FeedingRow | null = null;
    h.net().contract.meanwhile.send_tx = async () => {
      stale = await env.DB.prepare(`SELECT ${FEEDINGS_COLUMNS} FROM feedings`).first<FeedingRow>();
      h.net().contract.failingViews.add('pet_view');
    };
    expect((await send(maya, tx)).body.status).toBe('ok');
    expect(stale).not.toBeNull();
    expect(await settleFeeding(env, stale!, { status: 'ok' })).toBe(false);
    expect(await rows('SELECT name FROM pending_feed_wakes')).toEqual([{ name: 'Maya' }]);
    h.net().contract.failingViews.clear();
    expect((await api('/api/pets/7/state?wakes=0', { token: owner })).body.friend).toBe('Maya');
    expect(await rows("SELECT payload FROM jobs WHERE kind = 'wake'")).toHaveLength(1);
  });

  // spec: add-feeding › Feed by link flow › друг покормил × a second confirmed feed while the first wake is pending
  it('keeps the first confirmed feeder as the wake claimant when another friend feeds before the poll', async () => {
    await asleepPet();
    const owner = await token('did:privy:owner', OWNER);
    const maya = await player(NEAR, 'Maya');
    const leo = await player(NEAR, 'Leo');
    readsFailAtTheSend();
    expect((await feed(maya)).body.status).toBe('ok');
    h.net().contract.failingViews.clear();
    const next = await build(leo);
    readsFailAtTheSend();
    expect((await send(leo, next)).body.status).toBe('ok');
    expect(await rows('SELECT name FROM pending_feed_wakes')).toEqual([{ name: 'Maya' }]);
    h.net().contract.failingViews.clear();

    const told = (await api('/api/pets/7/state?wakes=0', { token: owner })).body;
    expect(told.friend).toBe('Maya');
    expect(await rows('SELECT * FROM pending_feed_wakes')).toEqual([]);
    const jobs = await rows("SELECT payload FROM jobs WHERE kind = 'wake'");
    expect(jobs).toHaveLength(1);
    expect(JSON.parse(jobs[0].payload)).toMatchObject({ cause: 'link', friend: 'Maya' });
    expect(await rows("SELECT name FROM memory_notes WHERE kind = 'fed_by' ORDER BY at, rowid"))
      .toEqual([{ name: 'Maya' }, { name: 'Leo' }]);
  });

  // spec: add-account › Memory deletion data › стёрто × Clear memory after a named wake claim
  it('clears a claimed named wake without leaving its pending row or job payload', async () => {
    await asleepPet();
    const owner = await token('did:privy:owner', OWNER);
    const maya = await player(NEAR, 'Maya');
    readsFailAtTheSend();
    expect((await feed(maya)).body.status).toBe('ok');
    h.net().contract.failingViews.clear();
    expect((await api('/api/pets/7/state?wakes=0', { token: owner })).body.friend).toBe('Maya');
    expect((await api('/api/pets/7/memory/clear', { token: owner, method: 'POST' })).status).toBe(200);
    expect(await rows('SELECT * FROM pending_feed_wakes')).toEqual([]);
    expect(await one("SELECT wake_by FROM pets WHERE token_id = '7'")).toEqual({ wake_by: null });
    expect(await rows("SELECT payload FROM jobs WHERE kind = 'wake'")).toEqual([{ payload: null }]);
  });

  // spec: add-feeding › Feed by link flow › друг покормил × two stale pet views after confirmation
  it('keeps a named wake pending while two readable views lag the confirmed meal', async () => {
    await asleepPet();
    const owner = await token('did:privy:owner', OWNER);
    const p = await player(NEAR, 'Maya');
    h.net().contract.meanwhile.send_tx = async () => {
      const asleep = { ...h.net().contract.pets.get('7')! };
      h.net().contract.stalePetViews = [asleep, asleep];
    };
    const res = await feed(p);
    expect(res.body).toMatchObject({ status: 'ok', friend: 'Maya' });
    expect(await rows('SELECT * FROM feedings')).toEqual([]);
    expect(await rows('SELECT * FROM pending_feed_wakes')).toHaveLength(1);
    expect(await rows("SELECT name FROM memory_notes WHERE kind = 'fed_by'")).toEqual([{ name: 'Maya' }]);
    expect(await rows("SELECT * FROM jobs WHERE kind = 'wake'")).toEqual([]);

    const told = (await api('/api/pets/7/state?wakes=0', { token: owner })).body;
    expect(told.events).toEqual(['woke']);
    expect(told.friend).toBe('Maya');
    expect(await rows('SELECT * FROM pending_feed_wakes')).toEqual([]);
    expect(await one("SELECT wake_seq, wake_by FROM pets WHERE token_id = '7'"))
      .toEqual({ wake_seq: 1, wake_by: 'Maya' });
    const wakes = await rows("SELECT payload FROM jobs WHERE kind = 'wake'");
    expect(wakes).toHaveLength(1);
    expect(JSON.parse(wakes[0].payload)).toMatchObject({ cause: 'link', friend: 'Maya' });
    expect(await rows("SELECT name FROM memory_notes WHERE kind = 'fed_by'")).toEqual([{ name: 'Maya' }]);
  });

  // spec: add-account › Memory deletion data › стёрто
  it('does not restore a feeder name or queue its wake thought when memory is cleared during the poll pet view', async () => {
    await asleepPet();
    const owner = await token('did:privy:owner', OWNER);
    const p = await player(NEAR, 'Maya');
    readsFailAtTheSend();
    expect((await feed(p)).body.status).toBe('ok');
    expect(await rows('SELECT * FROM pending_feed_wakes')).toHaveLength(1);
    h.net().contract.failingViews.clear();

    // ownedPet reads first. The next pet view is wakeDue's awaited read, after the
    // pending row and its name have been cached by pendingFriendWake.
    h.net().contract.meanwhile.pet_view = async () => {
      h.net().contract.meanwhile.pet_view = async () => {
        const clear = await api('/api/pets/7/memory/clear', { token: owner, method: 'POST' });
        expect(clear.status).toBe(200);
      };
    };
    await api('/api/pets/7/state?wakes=0', { token: owner });
    expect(await rows('SELECT * FROM pending_feed_wakes')).toEqual([]);
    expect(await one("SELECT wake_by FROM pets WHERE token_id = '7'")).toEqual({ wake_by: null });
    expect(await rows("SELECT * FROM jobs WHERE kind = 'wake'")).toEqual([]);
    expect(await rows("SELECT * FROM memory_notes WHERE token_id = '7'")).toEqual([]);
  });

  // spec: add-feeding › Feed by link flow › друг покормил × the network unread after the meal
  it('keeps the friend\'s attribution pending until a readable pet view queues one named wake', async () => {
    await asleepPet();
    const owner = await token('did:privy:owner', OWNER);
    const p = await player(NEAR, 'Maya');
    readsFailAtTheSend();
    const res = await feed(p);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok', friend: 'Maya' });
    expect(await rows('SELECT * FROM feedings')).toEqual([]);
    expect(await rows('SELECT * FROM pending_feed_wakes')).toHaveLength(1);
    expect(await rows("SELECT name FROM memory_notes WHERE kind = 'fed_by'")).toEqual([{ name: 'Maya' }]);
    expect(await rows("SELECT * FROM jobs WHERE kind = 'wake'")).toEqual([]);
    expect((await one("SELECT slept_at FROM pets WHERE token_id = '7'")).slept_at).not.toBeNull();

    h.net().contract.failingViews.clear();
    await awakePet('8');
    expect((await feed(p, '0.01', '8')).body.status).toBe('ok');
    expect(await rows('SELECT * FROM feedings')).toEqual([]);
    const told = (await api('/api/pets/7/state?wakes=0', { token: owner })).body;
    expect(told.events).toEqual(['woke']);
    expect(told.friend).toBe('Maya');
    expect(await rows('SELECT * FROM feedings')).toEqual([]);
    expect(await rows('SELECT * FROM pending_feed_wakes')).toEqual([]);
    expect((await rows("SELECT kind, name FROM memory_notes WHERE token_id = '7'"))).toEqual([{ kind: 'fed_by', name: 'Maya' }]);
    expect(await rows("SELECT * FROM jobs WHERE kind = 'wake'")).toHaveLength(1);
    expect((await one("SELECT slept_at FROM pets WHERE token_id = '7'")).slept_at).toBeNull();
  });

  // spec: D-164 › confirmed friend feed › social introduction RPC is unavailable
  it('returns a confirmed feed before the social read and retries introductions later', async () => {
    await awakePet();
    const p = await player(NEAR, 'Maya');
    h.net().contract.addPet('8', p.account);
    h.net().contract.failingViews.add('nft_tokens_for_owner');
    const res = await feed(p);
    expect(res.body).toMatchObject({ status: 'ok', friend: 'Maya' });
    expect(h.net().contract.reads.some((r) => r.method === 'nft_tokens_for_owner')).toBe(false);
    expect(await rows('SELECT * FROM feed_introductions')).toHaveLength(1);
    await settleFeedIntroductions(env);
    expect(await rows('SELECT * FROM feed_introductions')).toHaveLength(1);
    h.net().contract.failingViews.clear();
    await settleFeedIntroductions(env);
    expect(await rows('SELECT * FROM feed_introductions')).toEqual([]);
    expect(await rows("SELECT token_id, other_id FROM society_relations ORDER BY token_id")).toEqual([
      { token_id: '7', other_id: '8' }, { token_id: '8', other_id: '7' },
    ]);
  });

  // spec: add-feeding › Own pet feeding flow › разбудил × the network unread after the meal
  it('answers the owner\'s own meal ok and leaves the wake to the poll', async () => {
    await asleepPet();
    const p = await keyedOwner();
    readsFailAtTheSend();
    const res = await feed(p);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok' });
    expect(h.events().filter((e) => e.name === 'pet_fed')).toHaveLength(1);
    expect((await one("SELECT slept_at FROM pets WHERE token_id = '7'")).slept_at).not.toBeNull();
  });

  // spec: add-feeding › Feeding outcome rule › reopened on its way
  it('refuses an id that is not a hash or a snack id, a visitor and a pet that does not exist', async () => {
    await awakePet();
    const p = await player();
    for (const body of [{ id: 'not a hash', source: 'near' }, { id: 5, source: 'near' }, { id: 'abc', source: 'snack' }, { id: 'a'.repeat(44), source: 'other' }]) {
      expect((await api('/api/pets/7/feed/outcome', { token: p.token, body })).status, JSON.stringify(body)).toBe(400);
    }
    expect((await api('/api/pets/7/feed/outcome', { body: { id: 'a'.repeat(44), source: 'near' } })).status).toBe(401);
    expect((await api('/api/pets/99/feed/outcome', { token: p.token, body: { id: 'a'.repeat(44), source: 'near' } })).status).toBe(404);
  });
});

describe('the owner\'s poll while a friend\'s meal is on its way', () => {
  const poll = (tk: string, wakes?: number) => api(`/api/pets/7/state${wakes === undefined ? '' : `?wakes=${wakes}`}`, { token: tk });

  // spec: add-feeding › Feed by link flow › друг покормил × owner's poll before the outcome is settled
  it('does not wake the pet as the owner\'s: the friend\'s name is kept for the outcome, and the page is told of the wake once', async () => {
    await asleepPet();
    const owner = await token('did:privy:owner', OWNER);
    const p = await player(NEAR, 'Maya');
    const wakesAtLoad = (await api('/api/pets/7', { token: owner })).body.wakes;
    expect(wakesAtLoad).toBe(0);
    // the meal is on the chain and the answer is lost: the row stands
    h.net().contract.mode = 'executed-but-silent';
    await send(p, await build(p));
    expect((await poll(owner, wakesAtLoad)).body.events).toEqual([]);
    expect((await one("SELECT slept_at FROM pets WHERE token_id = '7'")).slept_at).not.toBeNull();
    // the outcome is settled: the friend woke it
    h.net().contract.mode = 'normal';
    await settleStaleFeedings(env, Date.now() + 90_000);
    const told = (await poll(owner, wakesAtLoad)).body;
    expect(told.events).toEqual(['woke']);
    expect(told.friend).toBe('Maya');
    expect(told.wakes).toBe(1);
    // a page that learned the number does not hear it again; one that loads after the wake never does
    expect((await poll(owner, 1)).body.events).toEqual([]);
    expect((await poll(owner)).body.events).toEqual([]);
    expect((await api('/api/pets/7', { token: owner })).body.wakes).toBe(1);
  });

  // spec: add-feeding › Feed by link flow › друг покормил × owner's poll before the outcome is settled
  it('lets an owner poll inside confirmed settlement make the named wake once', async () => {
    await asleepPet();
    const owner = await token('did:privy:owner', OWNER);
    const p = await player(NEAR, 'Maya');
    const chain = h.net().contract;
    let polled: any = null;
    // The poll lands on the first read after the confirmed row was released.
    chain.meanwhile.send_tx = async () => {
      chain.meanwhile.pet_view = async () => {
        polled = (await poll(owner, 0)).body;
      };
    };
    expect((await feed(p)).body.status).toBe('ok');
    expect(polled.events).toEqual(['woke']);
    expect(polled.friend).toBe('Maya');
    expect(await one("SELECT slept_at, wake_by, wake_seq FROM pets WHERE token_id = '7'")).toEqual({ slept_at: null, wake_by: 'Maya', wake_seq: 1 });
    expect(await rows("SELECT name FROM memory_notes WHERE kind = 'fed_by'")).toEqual([{ name: 'Maya' }]);
    expect(await rows("SELECT * FROM jobs WHERE kind = 'wake'")).toHaveLength(1);
    const told = (await poll(owner, 1)).body;
    expect(told.events).toEqual([]);
    expect(told.wakes).toBe(1);
  });

  // spec: add-feeding › Feed by link flow › друг покормил × owner's poll before the outcome is settled
  it('wakes once when two flows settle one meal at the same moment', async () => {
    await asleepPet();
    const p = await player(NEAR, 'Maya');
    h.net().contract.mode = 'executed-but-silent';
    const sent = await send(p, await build(p));
    h.net().contract.mode = 'normal';
    const ask = () => api('/api/pets/7/feed/outcome', { token: p.token, body: { id: sent.body.hash, source: 'near' } });
    const [a, b] = await Promise.all([ask(), ask()]);
    expect([a.body.status, b.body.status]).toEqual(['ok', 'ok']);
    expect(await one("SELECT wake_by, wake_seq FROM pets WHERE token_id = '7'")).toEqual({ wake_by: 'Maya', wake_seq: 1 });
    expect(await rows("SELECT * FROM memory_notes WHERE kind = 'fed_by'")).toHaveLength(1);
    expect(await rows("SELECT * FROM jobs WHERE kind = 'wake'")).toHaveLength(1);
    expect(h.events().filter((e) => e.name === 'pet_fed')).toHaveLength(1);
  });

  // spec: add-feeding › Sleep and wake flow › разбудил друг при открытой странице
  it('says «A friend» for a feeder with no name, and nothing for the owner\'s own wake', async () => {
    await asleepPet();
    const owner = await token('did:privy:owner', OWNER);
    const p = await player(NEAR, null);
    await feed(p);
    const told = (await poll(owner, 0)).body;
    expect(told).toMatchObject({ events: ['woke'], friend: 'A friend' });
  });

  // spec: add-feeding › Feed by link flow › друг покормил × owner's poll before the outcome is settled
  it('still wakes the pet for the owner\'s own food that no flow of the game sent', async () => {
    const pet = await asleepPet();
    const owner = await token('did:privy:owner', OWNER);
    pet.given_food = env.STARTER_FOOD;
    const told = (await poll(owner, 0)).body;
    expect(told.events).toEqual(['woke']);
    expect(told.friend).toBeUndefined();
  });

  // spec: add-feeding › Feed by link flow › друг покормил × a page that loads after the wake
  it('gives a page that loads after the wake no line: the counter it learned is the current one', async () => {
    await asleepPet();
    const owner = await token('did:privy:owner', OWNER);
    await feed(await player());
    const loaded = (await api('/api/pets/7', { token: owner })).body;
    expect(loaded.wakes).toBe(1);
    expect((await poll(owner, loaded.wakes)).body.events).toEqual([]);
  });
});

describe('the build and the send together', () => {
  // spec: add-feeding › Feeding transaction data › прислана не та порция
  it('builds what the server itself accepts at the send, for a pet that is not the player\'s own', async () => {
    await awakePet();
    const p = await player();
    const tx = await build(p, '0.2');
    const decoded = Transaction.decode(Uint8Array.from(atob(tx), (c) => c.charCodeAt(0)));
    expect(decoded.actions[0]!.functionCall!.deposit).toBe(200n * MILLI);
    expect((await send(p, tx)).body.status).toBe('ok');
  });
});
