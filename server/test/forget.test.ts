import { env } from 'cloudflare:workers';
import { runDurableObjectAlarm } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { tick } from '../src/cron';
import { run } from '../src/spend';
import { unbilledYocto } from '../src/pet/view';
import { wakeIfFed } from '../src/pet/wake';
import { api, harness, say, seedHistory, settle } from './helpers/api';
import { NEAR_ACCOUNT, token } from './helpers/network';

const h = harness();
const OWNER = NEAR_ACCOUNT(1);
const S = BigInt(env.STARTER_FOOD);
const MIN = 60_000;
const owner = () => token('did:privy:owner', OWNER);
const alarm = async (id: string) => runDurableObjectAlarm(env.PET_DESK.get(env.PET_DESK.idFromName(id)));
const rows = async (sql: string, ...args: unknown[]) => (await env.DB.prepare(sql).bind(...args).all<any>()).results;
const clear = (tk: string | undefined, id = '5') => api(`/api/pets/${id}/memory/clear`, { token: tk, method: 'POST' });
const lastRequest = () => h.net().ai.calls.at(-1)!.body.messages;

async function until(done: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 500; i += 1) {
    if (await done()) return;
    await new Promise((r) => setTimeout(r, 4));
  }
  throw new Error('the condition did not come');
}

/** What a clear must leave of every thought: its receipt, field by field, never a byte of words. */
const receipts = async () =>
  rows(
    'SELECT t.id, t.token_id, t.kind, t.created_at, t.model, t.price_yocto, t.price_usd_micros, t.cut, t.reasked, t.payer, t.session_id, t.status, c.n, c.req_sha256, c.res_sha256, c.signature, c.sig_kind, c.signer, c.completion_id, c.tokens_in, c.tokens_out, c.tokens_reasoning, c.cut AS call_cut FROM thoughts t LEFT JOIN thought_calls c ON c.thought_id = t.id ORDER BY t.created_at, t.rowid, c.n',
  );
const noWords = async (tokenId = '5') => {
  const thoughts = await rows('SELECT player_text, reply_text FROM thoughts WHERE token_id = ?', tokenId);
  expect(thoughts.every((t) => t.player_text === null && t.reply_text === null)).toBe(true);
  const calls = await rows('SELECT c.req_bytes, c.res_bytes FROM thought_calls c JOIN thoughts t ON t.id = c.thought_id WHERE t.token_id = ?', tokenId);
  expect(calls.every((c) => c.req_bytes.length === 0 && c.res_bytes.length === 0)).toBe(true);
};

/** A pet asleep: nearly no food, the server's note of the sleep in place. */
async function asleepPet(id = '5') {
  const pet = h.net().contract.addPet(id, OWNER, { project_food: (S / 100n).toString() });
  await env.DB.prepare('INSERT INTO pets (token_id, hatched_by, born_at, birth_tx, slept_at) VALUES (?, ?, 1, ?, 1)').bind(id, OWNER, '').run();
  return pet;
}

describe('Memory deletion data', () => {
  // spec: add-account › Memory deletion data › стёрто
  it('erases the thoughts, their bytes, the notes and the payloads of the pet at once, and the next request to the model carries no memory', async () => {
    h.net().contract.addPet('5', OWNER, { project_food: (100n * S).toString() });
    h.net().contract.addPet('6', OWNER);
    const tk = await owner();
    await say(tk, '5', 'My secret is the blue key');
    await say(tk, '5', 'Think hard about it', 'deep');
    await say(tk, '6', 'Another pet, another line');
    await env.DB.prepare("INSERT INTO memory_notes (token_id, kind, name, at) VALUES ('5', 'fed_by', 'Maya', 5), ('6', 'fed_by', 'Noor', 5)").run();
    await env.DB.prepare("INSERT INTO jobs (id, token_id, kind, payload, status, result, created_at) VALUES ('w5', '5', 'wake', ?, 'done', '{\"code\":\"ai_unavailable\"}', 5), ('w6', '6', 'wake', ?, 'done', '{\"code\":\"ai_unavailable\"}', 5)")
      .bind(JSON.stringify({ cause: 'link', friend: 'Maya' }), JSON.stringify({ cause: 'link', friend: 'Noor' }))
      .run();
    const before = await receipts();
    expect(before.filter((r) => r.token_id === '5')).toHaveLength(2);
    const otherBefore = await rows("SELECT * FROM thoughts WHERE token_id = '6'");

    const res = await clear(tk);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(h.logs()).toContain('memory_cleared');

    await noWords();
    expect(await rows("SELECT erased_at FROM thoughts WHERE token_id = '5'")).toEqual([{ erased_at: Date.now() }, { erased_at: Date.now() }]);
    expect(await rows("SELECT * FROM memory_notes WHERE token_id = '5'")).toEqual([]);
    expect(await rows("SELECT payload FROM jobs WHERE token_id = '5'")).toEqual(expect.arrayContaining([{ payload: null }]));
    expect((await rows("SELECT payload FROM jobs WHERE token_id = '5'")).every((j) => j.payload === null)).toBe(true);
    expect(await receipts()).toEqual(before);
    // the conversation the owner sees is empty, the pet does not remember the lines
    expect((await api('/api/pets/5/conversation', { token: tk })).body.lines).toEqual([]);
    // another pet is as it was
    expect(await rows("SELECT * FROM thoughts WHERE token_id = '6'")).toEqual(otherBefore);
    expect(await rows("SELECT * FROM memory_notes WHERE token_id = '6'")).toHaveLength(1);
    expect((await rows("SELECT payload FROM jobs WHERE token_id = '6'"))[0]!.payload).not.toBeNull();

    // the next request to NEAR AI carries no earlier line and no friend
    const next = await say(tk, '5', 'Who am I?');
    expect(next.thought.text).toBe('Hello there, friend.');
    expect(lastRequest().map((m) => m.role)).toEqual(['system', 'user']);
    expect(lastRequest().at(-1)!.content).toBe('Who am I?');
    expect(JSON.stringify(h.net().ai.calls.at(-1)!.body)).not.toMatch(/blue key|Maya|Think hard|Hello there/);
    // the wallet and the network are not touched
    expect(h.net().contract.sends).toEqual([]);
    expect(h.net().fetched.filter((u) => u === env.NEAR_RPC_URL).length).toBeGreaterThan(0);
  });

  // spec: add-account › Memory deletion data › не владелец
  it('erases nothing for a player who is not the owner by the contract, and nothing for a visitor', async () => {
    const pet = h.net().contract.addPet('5', OWNER);
    const tk = await owner();
    await say(tk, '5', 'My secret is the blue key');
    const before = await rows('SELECT * FROM thoughts');
    const calls = await rows('SELECT * FROM thought_calls');

    // a stranger, a forged request
    const stranger = await clear(await token('did:privy:stranger', NEAR_ACCOUNT(2)));
    expect(stranger.status).toBe(403);
    expect(stranger.body).toEqual({ code: 'not_owner' });
    // the giver's tab left open after a gift: the contract says the pet is someone else's now
    pet.owner_id = NEAR_ACCOUNT(2);
    const giver = await clear(tk);
    expect(giver.status).toBe(403);
    expect(giver.body).toEqual({ code: 'not_owner' });
    // no session at all
    expect((await clear(undefined)).status).toBe(401);
    // a pet that is not there, an id that is no id
    expect((await clear(tk, '404')).status).toBe(404);
    expect((await clear(tk, 'abc')).status).toBe(404);

    expect(await rows('SELECT * FROM thoughts')).toEqual(before);
    expect(await rows('SELECT * FROM thought_calls')).toEqual(calls);
    expect((await rows("SELECT memory_epoch FROM pets WHERE token_id = '5'"))[0]!.memory_epoch).toBe(0);
  });

  // spec: add-account › Memory deletion data › сеть не читается
  it('erases nothing and says the network is unreachable when the owner cannot be read from the contract', async () => {
    h.net().contract.addPet('5', OWNER);
    const tk = await owner();
    await say(tk, '5', 'My secret is the blue key');
    const before = await rows('SELECT * FROM thoughts');
    const calls = await rows('SELECT * FROM thought_calls');

    h.net().contract.down = true;
    const res = await clear(tk);
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ code: 'chain_unreachable' });
    // the node answers, but not the view
    h.net().contract.down = false;
    h.net().contract.failingViews.add('pet_view');
    expect((await clear(tk)).status).toBe(503);

    expect(await rows('SELECT * FROM thoughts')).toEqual(before);
    expect(await rows('SELECT * FROM thought_calls')).toEqual(calls);
    expect((await rows("SELECT memory_epoch FROM pets WHERE token_id = '5'"))[0]!.memory_epoch).toBe(0);
  });

  // spec: add-account › Memory deletion data › стёрто не всё
  it('leaves everything as before the tap when a statement of the batch breaks in the middle', async () => {
    h.net().contract.addPet('5', OWNER);
    const tk = await owner();
    await say(tk, '5', 'My secret is the blue key');
    await env.DB.prepare("INSERT INTO memory_notes (token_id, kind, name, at) VALUES ('5', 'fed_by', 'Maya', 5)").run();
    await env.DB.prepare("INSERT INTO jobs (id, token_id, kind, payload, status, result, created_at) VALUES ('w5', '5', 'wake', ?, 'done', '{\"code\":\"ai_unavailable\"}', 5)")
      .bind(JSON.stringify({ cause: 'link', friend: 'Maya' }))
      .run();
    const tables = ['pets', 'thoughts', 'thought_calls', 'memory_notes', 'jobs'];
    const before = await Promise.all(tables.map((t) => rows(`SELECT * FROM ${t} ORDER BY rowid`)));

    // the statements before the jobs have run when this one stops the batch
    await env.DB.exec("CREATE TRIGGER stop_the_batch BEFORE UPDATE ON jobs BEGIN SELECT RAISE(ABORT, 'broken in the middle'); END");
    try {
      const res = await clear(tk);
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ code: 'clear_failed' });
      expect(h.logs()).toContain('clear_failed');
    } finally {
      await env.DB.exec('DROP TRIGGER stop_the_batch');
    }

    expect(await Promise.all(tables.map((t) => rows(`SELECT * FROM ${t} ORDER BY rowid`)))).toEqual(before);
    // and the conversation is still there, the tap can be tried again
    expect((await api('/api/pets/5/conversation', { token: tk })).body.lines).toHaveLength(2);
    expect((await clear(tk)).status).toBe(200);
    await noWords();
  });

  // spec: add-account › Memory deletion data › несписанная сессия
  it('keeps the receipt of an unbilled thought, and the cron debits the session with the same receipts', async () => {
    h.net().contract.addPet('5', OWNER, { project_food: (100n * S).toString() });
    for (let i = 0; i < 3; i += 1) {
      const out = await run(env, '5', { kind: 'reply', mode: 'chat', text: `line ${i}` });
      expect('thoughtId' in out).toBe(true);
    }
    const tk = await owner();
    const before = await receipts();
    const owed = await unbilledYocto(env.DB, '5');
    expect(before).toHaveLength(3);
    expect(owed).toBeGreaterThan(0n);

    expect((await clear(tk)).status).toBe(200);

    // price, model, hashes and signature are as they were; only the words and the bytes went
    await noWords();
    expect(await receipts()).toEqual(before);
    expect(await unbilledYocto(env.DB, '5')).toBe(owed);
    expect((await rows('SELECT status, COUNT(*) AS n FROM thoughts GROUP BY status'))).toEqual([{ status: 'unbilled', n: 3 }]);

    await tick(env, Date.now() + 11 * MIN);
    const [batch] = h.net().contract.debits;
    expect(h.net().contract.debits).toHaveLength(1);
    expect(batch!.thoughts).toEqual(
      before.map((r) => ({
        model: env.MODEL_ID,
        price: r.price_yocto,
        calls: [
          {
            req_sha256: r.req_sha256,
            res_sha256: r.res_sha256,
            signature: r.signature,
            sig_kind: r.sig_kind,
            signer: r.signer,
            tokens_in: r.tokens_in,
            tokens_out: r.tokens_out,
            tokens_reasoning: r.tokens_reasoning,
            cut: false,
          },
        ],
      })),
    );
    expect(await rows('SELECT status, COUNT(*) AS n FROM thoughts GROUP BY status')).toEqual([{ status: 'billed', n: 3 }]);
  });

  // spec: add-account › Memory deletion data › ответ в пути
  it('keeps the words of an answer that arrives after the clear out of the conversation and the memory, and its receipt in the session', async () => {
    h.net().contract.addPet('5', OWNER, { project_food: (100n * S).toString() });
    const tk = await owner();
    await say(tk, '5', 'Earlier line');
    h.net().ai.push({ delay: 120 });
    const sent = await api('/api/pets/5/thoughts', { token: tk, body: { text: 'Secret line', mode: 'chat' } });
    expect(sent.status).toBe(202);
    await until(() => h.net().ai.calls.length === 2);

    expect((await clear(tk)).status).toBe(200);
    const out = await settle(tk, '5', sent.body.job);

    // the page is told the memory is gone; the answer is not handed over
    expect(out.code).toBe('memory_cleared');
    expect(out.thought).toBeUndefined();
    await noWords();
    expect((await api('/api/pets/5/conversation', { token: tk })).body.lines).toEqual([]);
    expect(await rows("SELECT 1 FROM memory_notes WHERE token_id = '5'")).toEqual([]);
    // its receipt is in the session, billed as usual
    const [earlier, late] = await receipts();
    expect(late!.id).not.toBe(earlier!.id);
    expect(BigInt(late!.price_yocto)).toBeGreaterThan(0n);
    expect(late!.status).toBe('unbilled');
    expect(late!.req_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(late!.signature).toMatch(/^0xsig-/);
    expect((await rows('SELECT erased_at FROM thoughts WHERE id = ?', late!.id))[0]!.erased_at).not.toBeNull();

    // the next request carries neither line
    await say(tk, '5', 'Fresh start');
    expect(lastRequest().map((m) => m.content).join('|')).not.toMatch(/Secret line|Earlier line|Hello there/);
    await tick(env, Date.now() + 11 * MIN);
    expect(h.net().contract.debits[0]!.thoughts).toHaveLength(3);
    expect(await rows('SELECT status, COUNT(*) AS n FROM thoughts GROUP BY status')).toEqual([{ status: 'billed', n: 3 }]);
  });

  /** Runs `clear` inside the first `pet_view` read that finds the job `jobId()` claimed: the gap
   * between the desk's claim and the epoch `run` used to read, held by the RPC. */
  function clearWhenClaimed(tk: string, jobId: () => string): void {
    const chain = h.net().contract;
    const arm = () => {
      chain.meanwhile.pet_view = async () => {
        const row = await env.DB.prepare('SELECT status FROM jobs WHERE id = ?').bind(jobId()).first<{ status: string }>();
        if (row?.status === 'running') await clear(tk);
        else arm();
      };
    };
    arm();
  }

  // spec: add-account › Memory deletion data › ответ в пути
  it('keeps out the words of a line the desk had claimed when the clear landed, before the run reached its first read', async () => {
    h.net().contract.addPet('5', OWNER, { project_food: (100n * S).toString() });
    const tk = await owner();
    await say(tk, '5', 'Earlier line');
    // a long thought, and a line behind it: claimed the moment that thought ends
    h.net().ai.push({ delay: 80 });
    const first = await api('/api/pets/5/thoughts', { token: tk, body: { text: 'Long one', mode: 'chat' } });
    await until(() => h.net().ai.calls.length === 2);
    const queued = await api('/api/pets/5/thoughts', { token: tk, body: { text: 'Queued secret', mode: 'chat' } });
    expect(queued.status).toBe(202);
    clearWhenClaimed(tk, () => queued.body.job);

    await settle(tk, '5', first.body.job);
    const out = await settle(tk, '5', queued.body.job);
    expect(out).toMatchObject({ code: 'memory_cleared', jobKind: 'reply', memoryEpoch: 1 });
    expect(out.thought).toBeUndefined();
    // the clear did land inside the gap: the job was running, and both thoughts that followed are bare
    expect((await rows('SELECT memory_epoch FROM pets WHERE token_id = ?', '5'))[0]!.memory_epoch).toBe(1);
    await noWords();
    expect((await api('/api/pets/5/conversation', { token: tk })).body.lines).toEqual([]);
    expect(JSON.stringify(await rows('SELECT * FROM jobs'))).not.toMatch(/Queued secret|Long one/);
    // the receipt stays, as for every answer on its way
    expect((await rows('SELECT erased_at FROM thoughts WHERE token_id = ? ORDER BY created_at DESC, rowid DESC', '5'))[0]!.erased_at).not.toBeNull();
  });

  // spec: add-account › Memory deletion data › ответ в пути
  it('keeps out the friend and the words of a wake thought the desk had claimed when the clear landed', async () => {
    const pet = await asleepPet();
    pet.given_food = S.toString();
    const tk = await owner();
    expect(await wakeIfFed(env, '5', 'link', 'Maya')).toBe(true);
    const [wake] = await rows("SELECT id FROM jobs WHERE kind = 'wake'");
    clearWhenClaimed(tk, () => wake.id);

    await alarm('5');
    const after = (await rows('SELECT status, result, payload FROM jobs WHERE id = ?', wake.id))[0]!;
    expect(after.status).toBe('done');
    // the thought was spoken (its receipt is in the session) but its words went with the clear
    expect(JSON.parse(after.result)).toHaveProperty('thoughtId');
    expect(after.payload).toBeNull();
    expect((await rows('SELECT erased_at FROM thoughts WHERE token_id = ?', '5'))[0]!.erased_at).not.toBeNull();
    await noWords();
    expect(await rows("SELECT 1 FROM memory_notes WHERE token_id = '5'")).toEqual([]);
    expect((await api('/api/pets/5/conversation', { token: tk })).body.lines).toEqual([]);
  });
});

describe('Memory deletion data, the pairs', () => {
  // spec: add-account › Memory deletion data › ответ в пути × исход задания
  it('ends the job of an answer on its way as done, with the outcome «memory_cleared» for every poll of it, also after a reload', async () => {
    h.net().contract.addPet('5', OWNER);
    const tk = await owner();
    h.net().ai.push({ delay: 100 });
    const sent = await api('/api/pets/5/thoughts', { token: tk, body: { text: 'Secret line', mode: 'chat' } });
    await until(() => h.net().ai.calls.length === 1);
    await clear(tk);
    const first = await settle(tk, '5', sent.body.job);
    expect(first).toMatchObject({ code: 'memory_cleared', jobKind: 'reply', memoryEpoch: 1 });
    // a reload of the page asks again: the same outcome, and no thought
    const again = await api(`/api/pets/5/state?job=${sent.body.job}`, { token: tk });
    expect(again.body).toMatchObject({ code: 'memory_cleared' });
    expect(again.body.thought).toBeUndefined();
    expect((await rows('SELECT status FROM jobs WHERE id = ?', sent.body.job))[0]!.status).toBe('done');
    // and the owner's view has no thought on its way and none to fetch
    expect(again.body).toMatchObject({ pendingJob: null, lastThought: null });
  });

  // spec: add-account › Memory deletion data › стёрто × реплика в очереди
  it('fails a line waiting in the queue with «memory_cleared», without a call to NEAR AI and without its text', async () => {
    h.net().contract.addPet('5', OWNER);
    const tk = await owner();
    // the first call stays in flight until the test lets it go: a wall-clock delay let a slow machine
    // finish it, and run the queued line, before the clear
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.net().ai.push({ during: () => gate });
    const first = await api('/api/pets/5/thoughts', { token: tk, body: { text: 'First line', mode: 'chat' } });
    await until(() => h.net().ai.calls.length === 1);
    const queued = await api('/api/pets/5/thoughts', { token: tk, body: { text: 'Queued secret', mode: 'chat' } });
    expect(queued.status).toBe(202);
    expect((await rows('SELECT status, payload FROM jobs WHERE id = ?', queued.body.job))[0]).toMatchObject({ status: 'queued' });

    await clear(tk);
    const row = (await rows('SELECT status, result, payload FROM jobs WHERE id = ?', queued.body.job))[0]!;
    expect(row.status).toBe('failed');
    expect(JSON.parse(row.result)).toEqual({ code: 'memory_cleared' });
    expect(row.payload).toBeNull();

    expect(await settle(tk, '5', queued.body.job)).toMatchObject({ code: 'memory_cleared' });
    release();
    await settle(tk, '5', first.body.job);
    // the queued line never left the Worker
    expect(h.net().ai.calls).toHaveLength(1);
    expect(JSON.stringify(h.net().ai.calls.map((c) => c.body))).not.toContain('Queued secret');
    // the owner's view shows nothing queued, and the player's own line is nowhere
    const view = await api('/api/pets/5', { token: tk });
    expect(view.body).toMatchObject({ pendingJob: null, pendingText: null });
    expect(JSON.stringify(await rows('SELECT * FROM jobs'))).not.toMatch(/Queued secret|First line/);
  });

  // spec: add-account › Memory deletion data › стёрто × упавшая мысль пробуждения
  it('forgets the friend of a failed wake thought: «Try again» has nothing to retry, also when the thought fails after the clear', async () => {
    const pet = await asleepPet();
    pet.given_food = S.toString();
    await wakeIfFed(env, '5', 'link', 'Maya');
    h.net().ai.push({ status: 500 });
    await alarm('5');
    const [failed] = await rows("SELECT * FROM jobs WHERE kind = 'wake'");
    expect(JSON.parse(failed.result)).toEqual({ code: 'ai_unavailable' });
    expect(failed.payload).toContain('Maya');
    const tk = await owner();

    await clear(tk);
    expect((await rows('SELECT payload FROM jobs WHERE id = ?', failed.id))[0]!.payload).toBeNull();
    expect((await rows("SELECT 1 FROM memory_notes WHERE token_id = '5'"))).toEqual([]);
    expect((await api('/api/pets/5/wake', { token: tk, method: 'POST' })).body).toEqual({ job: null });

    // the second wake: the call is in the air when the owner clears; the thought fails after the clear
    await env.DB.prepare('UPDATE pets SET slept_at = 2 WHERE token_id = ?').bind('5').run();
    expect(await wakeIfFed(env, '5', 'link', 'Noor')).toBe(true);
    h.net().ai.push({ delay: 100, status: 500 });
    const running = alarm('5');
    await until(() => h.net().ai.calls.length === 2);
    await clear(tk);
    await running;
    const wakes = await rows("SELECT status, result, payload FROM jobs WHERE kind = 'wake' ORDER BY created_at, rowid");
    expect(wakes.at(-1)).toMatchObject({ status: 'done', result: JSON.stringify({ code: 'ai_unavailable' }), payload: null });
    expect(JSON.stringify(await rows('SELECT * FROM jobs'))).not.toMatch(/Maya|Noor/);
    expect((await api('/api/pets/5/wake', { token: tk, method: 'POST' })).body).toEqual({ job: null });
  });

  // spec: add-feeding › Feed by link flow › друг покормил × Clear memory
  it('erases the name of the friend who woke the pet with the rest of the memory, and keeps the wake counter and the index', async () => {
    const pet = await asleepPet();
    pet.given_food = S.toString();
    expect(await wakeIfFed(env, '5', 'link', 'Maya')).toBe(true);
    await env.DB.prepare("INSERT INTO known_index (token_id, account) VALUES ('5', ?)").bind(NEAR_ACCOUNT(2)).run();
    expect((await rows("SELECT wake_seq, wake_by FROM pets WHERE token_id = '5'"))[0]).toEqual({ wake_seq: 1, wake_by: 'Maya' });
    const tk = await owner();
    await clear(tk);
    expect((await rows("SELECT wake_seq, wake_by FROM pets WHERE token_id = '5'"))[0]).toEqual({ wake_seq: 1, wake_by: null });
    expect(await rows('SELECT account FROM known_index')).toEqual([{ account: NEAR_ACCOUNT(2) }]);
    // a page that missed the wake is told of it, but the name is gone with the memory
    const state = await api('/api/pets/5/state?wakes=0', { token: tk });
    expect(state.body.events).toEqual(['woke']);
    expect(state.body.friend).toBeUndefined();
    expect(JSON.stringify(state.body)).not.toContain('Maya');
  });

  // spec: add-account › Memory deletion data › стёрто × питомец спит
  it('works for a sleeping pet: nothing is spent, and it stays asleep', async () => {
    await asleepPet();
    await seedHistory('5', ['one', 'two']);
    const tk = await owner();
    const res = await clear(tk);
    expect(res.status).toBe(200);
    await noWords();
    expect(h.net().ai.calls).toEqual([]);
    expect((await rows("SELECT slept_at FROM pets WHERE token_id = '5'"))[0]!.slept_at).toBe(1);
    expect((await api('/api/pets/5', { token: tk })).body.fullness.state).toBe('asleep');
  });

  // spec: add-account › Memory deletion data › стёрто × пауза служб
  it('works while the services are paused', async () => {
    h.net().contract.addPet('5', OWNER);
    const tk = await owner();
    await say(tk, '5', 'My secret is the blue key');
    await env.DB.prepare("INSERT INTO service_pause (id, reason, since, last_probe) VALUES (1, 'ai', ?, ?)").bind(Date.now(), Date.now()).run();
    expect((await api('/api/pets/5/thoughts', { token: tk, body: { text: 'Hello?', mode: 'chat' } })).status).toBe(409);

    const res = await clear(tk);
    expect(res.status).toBe(200);
    await noWords();
    expect((await api('/api/pets/5', { token: tk })).body.paused).toBe(true);
  });

  // spec: add-account › Memory deletion data › несписанная сессия × пачка после удаления
  it('sends one batch with the cleared thought and the one after the clear, whose words are kept as usual', async () => {
    h.net().contract.addPet('5', OWNER, { project_food: (100n * S).toString() });
    await run(env, '5', { kind: 'reply', mode: 'chat', text: 'line 0' });
    const tk = await owner();
    const before = await receipts();
    await clear(tk);
    // the session is still open: a thought after the clear joins it with its words
    await run(env, '5', { kind: 'reply', mode: 'chat', text: 'line 1' });
    expect(lastRequest().map((m) => m.role)).toEqual(['system', 'user']);
    expect((await rows("SELECT player_text, erased_at FROM thoughts WHERE token_id = '5' ORDER BY rowid")).map((t) => [t.player_text, t.erased_at === null])).toEqual([
      [null, false],
      ['line 1', true],
    ]);
    await tick(env, Date.now() + 11 * MIN);
    expect(h.net().contract.debits).toHaveLength(1);
    const sent = h.net().contract.debits[0]!.thoughts;
    expect(sent).toHaveLength(2);
    expect(sent[0]!.price).toBe(before[0]!.price_yocto);
    expect(sent[0]!.calls).toMatchObject([{ req_sha256: before[0]!.req_sha256, res_sha256: before[0]!.res_sha256, signature: before[0]!.signature }]);
  });
});

describe('Memory deletion flow, the server side', () => {
  /** The newborn: hatched by the Worker, its greeting job queued and not yet run. */
  async function born() {
    const tk = await token('did:privy:player', NEAR_ACCOUNT(10));
    const res = await api('/api/hatch', { token: tk, body: { name: 'Pixel' } });
    expect(res.status).toBe(200);
    return { tk, id: res.body.tokenId as string };
  }

  // spec: add-account › Memory deletion flow › стёр × приветствие снова
  it('does not make the pet speak first after a clear, also when its greeting never landed', async () => {
    const { tk, id } = await born();
    expect((await rows("SELECT status FROM jobs WHERE token_id = ? AND kind = 'greeting'", id))[0]!.status).toBe('queued');

    expect((await clear(tk, id)).status).toBe(200);
    // the queued greeting is over, and the empty Pet screen asking for it again gets none
    expect((await rows("SELECT status, result FROM jobs WHERE token_id = ? AND kind = 'greeting'", id))[0]).toMatchObject({ status: 'failed', result: JSON.stringify({ code: 'memory_cleared' }) });
    const ask = await api(`/api/pets/${id}/greeting`, { token: tk, method: 'POST' });
    expect(ask.status).toBe(202);
    expect(ask.body).toEqual({ job: null });
    await alarm(id);
    expect(h.net().ai.calls).toEqual([]);
    expect(await rows("SELECT * FROM thoughts WHERE token_id = ?", id)).toEqual([]);
    // an ordinary pet's greeting, before any clear, is still made
    h.net().contract.addPet('7', OWNER);
    const other = await api('/api/pets/7/greeting', { token: await owner(), method: 'POST' });
    expect(other.body.job).toEqual(expect.any(String));
    await settle(await owner(), '7', other.body.job);
  });

  // spec: add-account › Memory deletion flow › стёр × подсказка поля
  it('keeps «Talk to…» for an owner who has written, and «Say hi to…» for one who has not', async () => {
    h.net().contract.addPet('5', OWNER);
    h.net().contract.addPet('6', OWNER);
    const tk = await owner();
    await say(tk, '5', 'Hi Pixel!');
    const wrote = await api('/api/pets/5', { token: tk });
    expect(wrote.body).toMatchObject({ hello: false, memoryEpoch: 0 });
    // a pet that only greeted: nothing written by the owner
    await run(env, '6', { kind: 'greeting' });
    expect((await api('/api/pets/6', { token: tk })).body.hello).toBe(true);

    await clear(tk, '5');
    await clear(tk, '6');
    const after = await api('/api/pets/5', { token: tk });
    expect(after.body).toMatchObject({ hello: false, memoryEpoch: 1, lastThought: null });
    expect((await api('/api/pets/6', { token: tk })).body).toMatchObject({ hello: true, memoryEpoch: 1 });
    // the state poll carries the number too, for a second tab
    expect((await api('/api/pets/5/state', { token: tk })).body.memoryEpoch).toBe(1);
    // a second clear is the same: the number counts the clears
    await clear(tk, '5');
    expect((await api('/api/pets/5/state', { token: tk })).body.memoryEpoch).toBe(2);
  });
});
