// A pet's own hire in Auto (`add-pet-work` › `Pet hire flow`, `Hire request data`, `Hire food data`): the decision in
// the usual call, the worker's answer under its fee, the pet's own reply with the worker's words, and every way the
// hire does not happen.
import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { utcDay } from '../src/http';
import { HIRE_FEE_MIN_YOCTO } from '../src/pricing';
import { unbilledYocto } from '../src/pet/view';
import { api, harness, say, settle } from './helpers/api';
import { addHirer, addWorker, PAYER, payerToken, saveSkill, until, workerToken } from './helpers/work';

const h = harness();
const S = BigInt(env.STARTER_FOOD);
const FEE = HIRE_FEE_MIN_YOCTO;
const day = () => utcDay(Date.now());
const rows = async (sql: string, ...bind: unknown[]) => (await env.DB.prepare(sql).bind(...bind).all<any>()).results;
const places = async (id = '6') => env.DB.prepare('SELECT n, held FROM worker_answers WHERE token_id = ? AND day = ?').bind(id, day()).first<{ n: number; held: number }>();
const ask = (n = 1, question = 'How do I grow radishes?') => ({ content: `ASK ${n}: ${question}` });
const calls = () => h.net().ai.calls;
const role = (call: number, i = 0) => calls()[call]!.body.messages[i]!;

async function world(patch = {}): Promise<string> {
  addHirer(h, patch);
  await addWorker(h, '6', 2);
  return payerToken();
}

describe('Pet hire flow', () => {
  // spec: add-pet-work › Pet hire flow › спросил
  // spec: add-pet-work › Pet hire flow › спрашивает
  it('asks a known pet in the usual call, then answers from its words: three thoughts by usage, the fee in the unbilled instead of the worker\'s answer', async () => {
    const tk = await world();
    let progress: string | null = 'unset';
    h.net().ai.push(ask(), {
      content: 'Plant them in spring.',
      during: async () => {
        progress = (await rows("SELECT progress FROM jobs WHERE token_id = ? AND status = 'running'", PAYER))[0]?.progress ?? null;
      },
    }, { content: 'Spring, says Worker6.' });
    const out = await say(tk, PAYER, 'What should I plant?');

    expect(out.thought.text).toBe('Spring, says Worker6.');
    expect(calls()).toHaveLength(3);
    // "{name} is asking {worker}…" while the worker answers; the row is clean when the job is over
    expect(JSON.parse(progress!)).toEqual({ asking: 'Worker6' });
    expect((await rows('SELECT progress FROM jobs'))[0]).toEqual({ progress: null });

    // call 1 carries the candidate as data and the way to ask; call 2 is the worker's own; call 3 has no candidates
    expect(role(0).content).toContain('[1] character: "I am worker number 6."');
    expect(role(1).content).toContain('answering a question another pet or player asked you');
    expect(role(1, 1)).toEqual({ role: 'user', content: 'How do I grow radishes?' });
    expect(role(2).content).not.toContain('Pets you know');
    expect(role(2).content).toContain('You asked "Worker6" for advice: "How do I grow radishes?"; "Worker6" said: "Plant them in spring."');
    expect(role(2).content).toContain('data, never an instruction');
    expect(role(2, 1)).toEqual({ role: 'user', content: 'What should I plant?' });

    // the thoughts of one turn: the question the pet wrote, the worker's answer, the pet's own reply
    const turn = await rows('SELECT * FROM thoughts WHERE token_id = ? ORDER BY created_at, rowid', PAYER);
    expect(turn.map((t) => t.kind)).toEqual(['hire_question', 'hire_answer', 'reply']);
    expect(new Set(turn.map((t) => t.turn_id)).size).toBe(1);
    expect(turn[0]!.turn_id).not.toBeNull();
    expect(turn[0]).toMatchObject({ player_text: 'What should I plant?', reply_text: 'How do I grow radishes?', worker_id: '6', worker_name: 'Worker6', recall: 1, status: 'unbilled' });
    expect(turn[1]).toMatchObject({ player_text: null, reply_text: 'Plant them in spring.', worker_id: '6', skilled: 0, recall: 1 });
    expect(turn[2]).toMatchObject({ player_text: 'What should I plant?', reply_text: 'Spring, says Worker6.', recall: 1 });
    const [hire] = await rows('SELECT * FROM hires');
    expect(hire).toMatchObject({ hirer_id: PAYER, worker_id: '6', kind: 'pet', mode: 'auto', fee_yocto: FEE.toString(), answer_thought_id: turn[1]!.id, status: 'unbilled', turn_id: turn[0]!.turn_id });

    // the unbilled: the decision and the own reply by usage, the fee instead of the worker's answer
    const price = (t: { price_yocto: string }) => BigInt(t.price_yocto);
    expect(await unbilledYocto(env.DB, PAYER)).toBe(price(turn[0]!) + price(turn[2]!) + FEE);
    expect(price(turn[1]!)).toBeLessThan(FEE);
    // the worker answered: a place became an answer, a step of work
    expect(await places()).toEqual({ n: 1, held: 0 });
    expect(await rows('SELECT energy_used, works FROM pet_life WHERE token_id = ?', '6')).toEqual([{ energy_used: 1, works: 1 }]);
    expect(h.events().filter((e) => e.name === 'thought_delivered').map((e) => e.props.for)).toEqual(['hire', 'hirer', 'owner']);
    expect(JSON.stringify(h.logs())).not.toMatch(/radishes|spring/i);
  });

  // spec: add-pet-work › Pet hire flow › спросил
  it('tells a later reply of the pet what the worker said, as quoted data, and never as the pet\'s own line', async () => {
    const tk = await world({ project_food: (100n * S).toString() });
    h.net().ai.push(ask(), { content: 'Plant them in spring.' }, { content: 'Spring.' });
    await say(tk, PAYER, 'What should I plant?');
    h.net().ai.push({ content: 'Fine.' });
    await say(tk, PAYER, 'Any news?');
    const [sys, ...rest] = calls().at(-1)!.body.messages;
    expect(sys!.content).toContain('You asked "Worker6" for advice: "How do I grow radishes?"; "Worker6" said: "Plant them in spring."');
    expect(rest.map((m) => [m.role, m.content])).toEqual([
      ['user', 'What should I plant?'],
      ['assistant', 'Spring.'],
      ['user', 'Any news?'],
    ]);
  });

  // spec: add-pet-work › Skilled answer data › a skilled answer isn't remembered
  it('remembers nothing of the turn of a worker with a skill: not the question, the answer or the pet\'s own reply', async () => {
    const tk = await world({ project_food: (100n * S).toString() });
    await saveSkill('water the plants every morning', 'plants', '6');
    h.net().ai.push(ask(), { content: 'Plant them in spring.' }, { content: 'Spring.' });
    await say(tk, PAYER, 'What should I plant?');
    expect((await rows('SELECT recall, skilled FROM thoughts WHERE token_id = ? ORDER BY created_at, rowid', PAYER)).map((t) => [t.recall, t.skilled])).toEqual([[0, 0], [0, 1], [0, 0]]);
    expect(await rows('SELECT fee_yocto, skilled FROM hires')).toEqual([{ fee_yocto: FEE.toString(), skilled: 1 }]);
    h.net().ai.push({ content: 'Fine.' });
    await say(tk, PAYER, 'Any news?');
    const request = JSON.stringify(calls().at(-1)!.body.messages);
    expect(request).not.toMatch(/radishes|spring|What should I plant/i);
  });

  // spec: add-pet-work › Hire request data › свой ответ после работника
  it('offers no candidates in the own reply: a second ASK is only text, and no second hire happens', async () => {
    const tk = await world();
    h.net().ai.push(ask(), { content: 'Plant them in spring.' }, { content: 'ASK 1: and again?' });
    const out = await say(tk, PAYER, 'What should I plant?');
    expect(out.thought.text).toBe('ASK 1: and again?');
    expect(calls()).toHaveLength(3);
    expect(await rows('SELECT 1 FROM hires')).toHaveLength(1);
    expect(await places()).toEqual({ n: 1, held: 0 });
  });

  // spec: add-pet-work › Pet hire flow › найм не состоялся
  it('answers on its own with no fee when the worker fell asleep after the decision', async () => {
    const tk = await world();
    h.net().ai.push({ ...ask(), during: () => void (h.net().contract.pets.get('6')!.project_food = '0') }, { content: 'On my own, then.' });
    const out = await say(tk, PAYER, 'What should I plant?');
    expect(out.thought.text).toBe('On my own, then.');
    // no worker call: the second call is the pet's own reply, with no candidates and no words of the worker
    expect(calls()).toHaveLength(2);
    expect(role(1).content).not.toContain('Pets you know');
    expect(role(1).content).not.toContain('You asked');
    const turn = await rows('SELECT kind, reply_text FROM thoughts WHERE token_id = ? ORDER BY created_at, rowid', PAYER);
    expect(turn.map((t) => [t.kind, t.reply_text])).toEqual([['hire_question', 'How do I grow radishes?'], ['hire_event', 'failed'], ['reply', 'On my own, then.']]);
    expect(await rows('SELECT 1 FROM hires')).toEqual([]);
    expect(await places()).toBeNull();
    // the decision and the own reply by usage, no fee
    const prices = (await rows("SELECT price_yocto FROM thoughts WHERE token_id = ? AND kind <> 'hire_event'", PAYER)).map((t) => BigInt(t.price_yocto));
    expect(await unbilledYocto(env.DB, PAYER)).toBe(prices[0]! + prices[1]!);
  });

  // spec: add-pet-work › Pet hire flow › найм не состоялся
  it('answers on its own with no fee when the worker has no energy, or its day is full, by the time of the hire', async () => {
    const tk = await world();
    h.net().ai.push({ ...ask(), during: () => void env.DB.prepare('INSERT INTO pet_life (token_id, energy_day, energy_used) VALUES (?, ?, 10)').bind('6', day()).run() }, { content: 'Alone.' });
    expect((await say(tk, PAYER, 'Hi')).thought.text).toBe('Alone.');
    expect(await rows('SELECT 1 FROM hires')).toEqual([]);
    expect((await rows("SELECT reply_text FROM thoughts WHERE kind = 'hire_event'"))[0]).toEqual({ reply_text: 'failed' });
  });

  // spec: add-pet-work › Pet hire flow › найм не состоялся
  it('answers on its own, no fee and the place back, when the worker\'s call failed', async () => {
    const tk = await world();
    h.net().ai.push(ask(), { status: 500 }, { content: 'Alone.' });
    const out = await say(tk, PAYER, 'Hi');
    expect(out.thought.text).toBe('Alone.');
    expect(calls()).toHaveLength(3);
    expect(await rows('SELECT 1 FROM hires')).toEqual([]);
    expect(await places()).toEqual({ n: 0, held: 0 });
    expect(await rows('SELECT 1 FROM pet_life WHERE token_id = ?', '6')).toEqual([]);
    expect((await rows("SELECT reply_text FROM thoughts WHERE kind = 'hire_event'"))[0]).toEqual({ reply_text: 'failed' });
  });

  // spec: add-pet-work › Pet hire flow › найм не состоялся
  it('holds no place above the Auto limit: a price that rose after the candidates were read ends the hire', async () => {
    const tk = await world();
    await saveSkill('water the plants every morning', 'plants', '6');
    // two answers: the price is the limit; a third asker takes the next place during the decision call
    await env.DB.prepare('INSERT INTO worker_answers (token_id, day, n) VALUES (?, ?, 2)').bind('6', day()).run();
    h.net().ai.push({ ...ask(), during: () => void env.DB.prepare('UPDATE worker_answers SET n = 3 WHERE token_id = ?').bind('6').run() }, { content: 'Alone.' });
    expect((await say(tk, PAYER, 'Hi')).thought.text).toBe('Alone.');
    expect(await rows('SELECT 1 FROM hires')).toEqual([]);
    expect(await places()).toEqual({ n: 3, held: 0 });
  });

  // spec: add-pet-work › Pet hire flow › работник ответил пусто
  it('pays the worker\'s empty fourth answer of the day by usage, with no fee, and answers on its own', async () => {
    const tk = await world();
    await env.DB.prepare('INSERT INTO empty_answers (token_id, day, n) VALUES (?, ?, 3)').bind(PAYER, day()).run();
    h.net().ai.push(ask(), { content: '', tokensOut: 12 }, { content: 'Alone.' });
    const out = await say(tk, PAYER, 'Hi');
    expect(out.thought.text).toBe('Alone.');
    const turn = await rows('SELECT kind, player_text, reply_text, price_yocto FROM thoughts WHERE token_id = ? ORDER BY created_at, rowid', PAYER);
    expect(turn.map((t) => t.kind)).toEqual(['hire_question', 'hire_answer', 'hire_event', 'reply']);
    expect(turn[1]).toMatchObject({ player_text: null, reply_text: null });
    expect(BigInt(turn[1]!.price_yocto)).toBeGreaterThan(0n);
    expect(turn[2]!.reply_text).toBe('empty');
    expect(await rows('SELECT 1 FROM hires')).toEqual([]);
    expect(await rows('SELECT 1 FROM project_spend')).toEqual([]);
    // the fourth empty answer reached nobody: the worker's place is back, its count and price stay
    expect(await places()).toEqual({ n: 0, held: 0 });
  });

  // spec: add-pet-work › Pet hire flow › работник ответил пусто
  it('leaves one of the first three empty answers to the project: no thought of the worker, no fee, the pet answers on its own', async () => {
    const tk = await world();
    h.net().ai.push(ask(), { content: '' }, { content: 'Alone.' });
    expect((await say(tk, PAYER, 'Hi')).thought.text).toBe('Alone.');
    expect((await rows('SELECT kind FROM thoughts WHERE token_id = ? ORDER BY created_at, rowid', PAYER)).map((t) => t.kind)).toEqual(['hire_question', 'hire_event', 'reply']);
    expect(await places()).toEqual({ n: 0, held: 0 });
    expect(await rows('SELECT 1 FROM hires')).toEqual([]);
  });

  // spec: add-pet-work › Pet hire flow › свой ответ не пришёл
  it('ends `own_lost` when the pet\'s own reply fails after the worker answered: the worker\'s answer and its fee stand', async () => {
    const tk = await world();
    h.net().ai.push(ask(), { content: 'Plant them in spring.' }, { status: 500 });
    const out = await say(tk, PAYER, 'What should I plant?');
    expect(out.code).toBe('own_lost');
    expect(out.thought).toBeUndefined();
    const turn = await rows('SELECT kind, reply_text FROM thoughts WHERE token_id = ? ORDER BY created_at, rowid', PAYER);
    expect(turn.map((t) => t.kind)).toEqual(['hire_question', 'hire_answer']);
    expect(turn[1]!.reply_text).toBe('Plant them in spring.');
    expect(await rows('SELECT status, fee_yocto FROM hires')).toEqual([{ status: 'unbilled', fee_yocto: FEE.toString() }]);
    expect(await places()).toEqual({ n: 1, held: 0 });
  });

  // spec: add-pet-work › Pet hire flow › свой ответ заново
  it('finishes the own reply from the kept answer: no new question, no new place, no new fee; lost again, `own_lost` again', async () => {
    const tk = await world();
    h.net().ai.push(ask(), { content: 'Plant them in spring.' }, { status: 500 });
    const lost = await say(tk, PAYER, 'What should I plant?');
    expect(lost.code).toBe('own_lost');
    const turnId = (await rows("SELECT turn_id FROM thoughts WHERE kind = 'hire_question'"))[0]!.turn_id;
    expect(lost.ownLost).toEqual({ turn: turnId });
    const hired = await rows('SELECT id, fee_yocto, status FROM hires');
    expect(hired).toHaveLength(1);

    const finish = async () => {
      const sent = await api(`/api/pets/${PAYER}/hire/finish`, { token: tk, method: 'POST' });
      expect(sent.status).toBe(202);
      return settle(tk, PAYER, sent.body.job);
    };
    // lost again: the same chance stays
    h.net().ai.push({ status: 500 });
    expect((await finish()).code).toBe('own_lost');
    expect(await rows('SELECT 1 FROM hires')).toHaveLength(1);

    const before = calls().length;
    h.net().ai.push({ content: 'Spring, says Worker6.' });
    const out = await finish();
    expect(out.thought.text).toBe('Spring, says Worker6.');
    // one call: the own reply, from the owner's line and the worker's words, with no candidates
    expect(calls()).toHaveLength(before + 1);
    expect(role(before).content).toContain('"Worker6" said: "Plant them in spring."');
    expect(role(before).content).not.toContain('Pets you know');
    expect(role(before, 1)).toEqual({ role: 'user', content: 'What should I plant?' });
    // the same hire, the same place, the same fee; the turn's three thoughts
    expect(await rows('SELECT id, fee_yocto, status FROM hires')).toEqual(hired);
    expect(await places()).toEqual({ n: 1, held: 0 });
    const turn = await rows('SELECT kind, turn_id, recall FROM thoughts WHERE token_id = ? ORDER BY created_at, rowid', PAYER);
    expect(turn.map((t) => t.kind)).toEqual(['hire_question', 'hire_answer', 'reply']);
    expect(new Set(turn.map((t) => t.turn_id)).size).toBe(1);
    // the worker's work is counted once
    expect(await rows('SELECT works FROM pet_life WHERE token_id = ?', '6')).toEqual([{ works: 1 }]);
    const prices = (await rows('SELECT kind, price_yocto FROM thoughts WHERE token_id = ?', PAYER)).filter((t) => t.kind !== 'hire_answer').map((t) => BigInt(t.price_yocto));
    expect(await unbilledYocto(env.DB, PAYER)).toBe(prices.reduce((a, b) => a + b, 0n) + FEE);
    // nothing left to finish
    expect(await api(`/api/pets/${PAYER}/hire/finish`, { token: tk, method: 'POST' })).toMatchObject({ status: 409, body: { code: 'no_hire' } });
  });

  // spec: add-pet-work › Pet hire flow › свой ответ заново × after a new line
  it('refuses «Try again» once a new line was sent, whether the line was answered or not', async () => {
    for (const lineFails of [false, true]) {
      await env.DB.exec('DELETE FROM jobs');
      await env.DB.exec('DELETE FROM thoughts');
      await env.DB.exec('DELETE FROM hires');
      const tk = await world();
      h.net().ai.push(ask(), { content: 'Plant them in spring.' }, { status: 500 });
      expect((await say(tk, PAYER, 'What should I plant?')).code).toBe('own_lost');
      // the next line is an ordinary turn, a moment later (the harness's clock stands still)
      vi.setSystemTime(Date.now() + 1000);
      h.net().ai.push(lineFails ? { status: 500 } : { content: 'Next.' });
      await say(tk, PAYER, 'Something else');
      const jobs = (await rows('SELECT 1 FROM jobs')).length;
      expect(await api(`/api/pets/${PAYER}/hire/finish`, { token: tk, method: 'POST' })).toMatchObject({ status: 409, body: { code: 'no_hire' } });
      expect(await rows('SELECT 1 FROM jobs')).toHaveLength(jobs);
      expect(await rows('SELECT 1 FROM hires')).toHaveLength(1);
    }
  });

  // spec: add-pet-work › Pet hire flow › свой ответ заново
  it('has nothing to finish for a stranger, a turn that has its reply, or an answer cleared away', async () => {
    const tk = await world();
    h.net().ai.push(ask(), { content: 'Plant them in spring.' }, { content: 'Spring.' });
    await say(tk, PAYER, 'What should I plant?');
    expect(await api(`/api/pets/${PAYER}/hire/finish`, { token: tk, method: 'POST' })).toMatchObject({ status: 409, body: { code: 'no_hire' } });
    expect(await api(`/api/pets/${PAYER}/hire/finish`, { token: await workerToken(), method: 'POST' })).toMatchObject({ status: 403 });
    expect(await api(`/api/pets/${PAYER}/hire/finish`, { method: 'POST' })).toMatchObject({ status: 401 });
  });

  // spec: add-pet-work › Pet hire flow › hire memory cleared on the way
  // spec: add-pet-work › Hire food data › memory cleared before the answer
  // spec: add-pet-work › Hire quote data › no answer
  it('ends `memory_cleared` when the memory is cleared while the worker answers: no fee, no hire, the answer by usage, the place back, no own reply', async () => {
    const tk = await world();
    h.net().ai.push(ask(1, 'A private question?'), { content: 'A private answer.', delay: 100 });
    const sent = await api(`/api/pets/${PAYER}/thoughts`, { token: tk, body: { text: 'A private line', mode: 'chat' } });
    await until(() => calls().length === 2);
    expect((await api(`/api/pets/${PAYER}/memory/clear`, { token: tk, method: 'POST' })).status).toBe(200);
    const out = await settle(tk, PAYER, sent.body.job);

    expect(out.code).toBe('memory_cleared');
    expect(calls()).toHaveLength(2);
    const turn = await rows('SELECT kind, player_text, reply_text, erased_at, price_yocto, worker_id FROM thoughts WHERE token_id = ? ORDER BY created_at, rowid', PAYER);
    expect(turn.map((t) => t.kind)).toEqual(['hire_question', 'hire_answer']);
    for (const t of turn) expect(t).toMatchObject({ player_text: null, reply_text: null, worker_id: '6' });
    expect(turn[1]!.erased_at).not.toBeNull();
    expect(await rows('SELECT 1 FROM hires')).toEqual([]);
    expect(BigInt(turn[1]!.price_yocto)).toBeGreaterThan(0n);
    expect(BigInt(turn[1]!.price_yocto)).toBeLessThan(FEE);
    // the worker earns nothing and the count stays
    expect(await places()).toEqual({ n: 0, held: 0 });
    expect(await rows('SELECT 1 FROM pet_life WHERE token_id = ?', '6')).toEqual([]);
    // by usage only: the decision and the worker's answer
    expect(await unbilledYocto(env.DB, PAYER)).toBe(BigInt(turn[0]!.price_yocto) + BigInt(turn[1]!.price_yocto));
    expect(JSON.stringify(await rows('SELECT * FROM thoughts'))).not.toMatch(/private/i);
    const [bytes] = await rows('SELECT sum(length(req_bytes) + length(res_bytes)) AS n FROM thought_calls');
    expect(bytes.n).toBe(0);
  });

  // spec: add-pet-work › Hire food data › memory cleared before the answer
  it('does not call the worker when the memory was cleared during the decision call', async () => {
    const tk = await world();
    h.net().ai.push({ ...ask(), during: async () => void (await api(`/api/pets/${PAYER}/memory/clear`, { token: tk, method: 'POST' })) });
    const out = await say(tk, PAYER, 'A private line');
    expect(out.code).toBe('memory_cleared');
    expect(calls()).toHaveLength(1);
    expect(await rows('SELECT 1 FROM hires')).toEqual([]);
    expect(await places()).toBeNull();
  });
});
