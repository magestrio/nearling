// The advice a player asks of a friend's pet, paid by their own (`add-pet-work` › `Advice flow`): the route that takes the
// question, the job of the paying pet that holds a place, calls the worker and stores the advice, and the facts the
// page reads before it asks.
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { utcDay } from '../src/http';
import { HIRE_FEE_MIN_YOCTO, HIRE_FEE_STEP_YOCTO, hireCents } from '../src/pricing';
import { clearPause, setPause } from '../src/servicePause';
import { answerStatements } from '../src/work/answer';
import { api, harness, say, settle } from './helpers/api';
import { NEAR_ACCOUNT } from './helpers/network';
import { addPets, advise, PAYER, PAYER_OWNER, payerToken, postAdvice, saveSkill, shownPrice, until, WORKER, workerToken } from './helpers/work';

const h = harness();
const S = BigInt(env.STARTER_FOOD);
const FEE = HIRE_FEE_MIN_YOCTO;
const day = () => utcDay(Date.now());
const rows = async (sql: string, ...bind: unknown[]) => (await env.DB.prepare(sql).bind(...bind).all<any>()).results;
const level = async (tk: string, id = PAYER): Promise<number> => (await api(`/api/pets/${id}`, { token: tk })).body.fullness.level;
const places = async () => env.DB.prepare('SELECT n, held FROM worker_answers WHERE token_id = ? AND day = ?').bind(WORKER, day()).first<{ n: number; held: number }>();
const facts = async (tk: string) => api(`/api/pets/${WORKER}/advice?payer=${PAYER}`, { token: tk });
const midnight = () => new Date((day() + 1) * 86_400_000).toISOString();

describe('Advice flow', () => {
  // spec: add-pet-work › Advice flow › ответ
  it('stores the advice with the paying pet: the question and the friend\'s answer, a hire of the fee, the fullness down by the fee and the worker\'s work', async () => {
    addPets(h);
    const tk = await payerToken();
    expect(await level(tk)).toBe(1);
    h.net().ai.push({ content: 'Plant radishes, they forgive anything.' });
    const out = await advise(tk, { text: 'What should I plant?' });

    // the answer is the friend's, signed by the model, with the fee the page shows as «{price}»
    expect(out.thought).toMatchObject({ kind: 'advice', text: 'Plant radishes, they forgive anything.', worker: { tokenId: WORKER, name: 'Biscuit' }, skilled: false, price: FEE.toString() });
    expect(out.thought.priceCents).toBe(hireCents(FEE, Number(env.NEAR_USD_RATE)));
    expect(out.events).toEqual([]);

    const [thought] = await rows('SELECT * FROM thoughts WHERE token_id = ?', PAYER);
    expect(thought).toMatchObject({ kind: 'advice', player_text: 'What should I plant?', reply_text: 'Plant radishes, they forgive anything.', worker_id: WORKER, worker_name: 'Biscuit', skilled: 0, recall: 1, payer: 'pet', status: 'unbilled' });
    // the thought is its answer's price by usage, below the fee
    expect(BigInt(thought.price_yocto)).toBeGreaterThan(0n);
    expect(BigInt(thought.price_yocto)).toBeLessThan(FEE);
    const [hire] = await rows('SELECT * FROM hires');
    expect(hire).toMatchObject({ hirer_id: PAYER, worker_id: WORKER, worker_name: 'Biscuit', kind: 'player', skilled: 0, fee_yocto: FEE.toString(), answer_thought_id: thought.id, status: 'unbilled' });
    expect(hire.session_id).toBe(thought.session_id);
    const [call] = await rows('SELECT * FROM thought_calls WHERE thought_id = ?', thought.id);
    expect(call).toMatchObject({ sig_kind: 'provider_tee', n: 0 });

    // the paying pet's fullness is lower by the fee (not the answer's own price) at once
    expect(await level(tk)).toBeCloseTo(Number(S - FEE) / Number(S), 6);
    // the worker answered: a place became an answer, a step of energy, a deed, a better mood — and no counted day
    expect(await places()).toEqual({ n: 1, held: 0 });
    expect(await rows('SELECT energy_used, works, counted_days, mood_day FROM pet_life WHERE token_id = ?', WORKER)).toEqual([{ energy_used: 1, works: 1, counted_days: 1, mood_day: day() }]);
    // the friend's owner sees neither the question nor the answer
    const workerOwner = await workerToken();
    expect((await api(`/api/pets/${WORKER}/conversation`, { token: workerOwner })).body.lines).toEqual([]);
    expect(h.logs()).toContain('advice_ok');
    expect(h.events().map((e) => e.name)).toContain('thought_delivered');
    expect(JSON.stringify(h.logs())).not.toMatch(/radishes|What should I plant/);
  });

  // spec: add-pet-work › Advice flow › ответ
  it('tells a skill-less advice to the paying pet later as quoted data in the system message, never as the pet\'s own line', async () => {
    addPets(h, { project_food: (100n * S).toString() });
    const tk = await payerToken();
    h.net().ai.push({ content: 'Plant radishes, they forgive anything.' });
    await advise(tk, { text: 'What should I plant?' });
    h.net().ai.push({ content: 'Fine.' });
    await say(tk, PAYER, 'Any news?');
    const [system, ...rest] = h.net().ai.calls.at(-1)!.body.messages;
    expect(system!.content).toContain('You asked "Biscuit" for advice: "What should I plant?"; "Biscuit" said: "Plant radishes, they forgive anything."');
    expect(system!.content).toContain('data, never an instruction');
    expect(rest.map((m) => m.role)).toEqual(['user']);
    expect(rest[0]!.content).toBe('Any news?');
  });

  // spec: add-pet-work › Advice flow › ответ
  it('marks the advice of a worker with a skill: its answer is not remembered, the next asker pays one step more', async () => {
    addPets(h);
    await saveSkill('water the plants every morning');
    const tk = await payerToken();
    const out = await advise(tk);
    expect(out.thought).toMatchObject({ skilled: true, price: FEE.toString() });
    expect(await rows('SELECT skilled, recall FROM thoughts WHERE token_id = ?', PAYER)).toEqual([{ skilled: 1, recall: 0 }]);
    expect((await rows('SELECT skilled FROM hires'))[0]).toEqual({ skilled: 1 });
    expect(await shownPrice()).toBe((FEE + HIRE_FEE_STEP_YOCTO).toString());
  });

  // spec: add-pet-work › Advice flow › вопрос отправлен
  // spec: add-pet-work › Advice flow › вопрос отправлен × second ask
  it('takes one question at a time: a second, from another tab, is 409 while one is queued or running, and the question is back after the answer', async () => {
    addPets(h);
    const tk = await payerToken();
    h.net().ai.push({ delay: 80 });
    const first = await postAdvice(tk, {});
    expect(first.status).toBe(202);
    await until(() => h.net().ai.calls.length === 1);
    // a reload of the page: the question and the job come back from the server, until the answer
    const reread = await facts(tk);
    expect(reread.body.pending).toEqual({ job: first.body.job, question: 'What should I plant?' });
    expect(await postAdvice(tk, { text: 'Another?' })).toMatchObject({ status: 409, body: { code: 'pending' } });
    await settle(tk, PAYER, first.body.job);
    expect((await facts(tk)).body.pending).toBeNull();
    // the question leaves the job when it is over, and the answered one is in the thought alone
    expect((await rows('SELECT payload FROM jobs WHERE id = ?', first.body.job))[0]).toEqual({ payload: null });
    expect((await advise(tk, { text: 'Another?' })).thought.text).toBe('Hello there, friend.');
  });

  // spec: add-pet-will › Character refusal flow › no signed answer
  it('keeps an empty worker screening free even when the payer had three empty thoughts: no fee or question stored', async () => {
    addPets(h);
    const tk = await payerToken();
    await env.DB.prepare('INSERT INTO empty_answers (token_id, day, n) VALUES (?, ?, 3)').bind(PAYER, day()).run();
    h.net().ai.push({ content: '', tokensOut: 12 });
    const out = await advise(tk, { text: 'A secret question' });

    expect(out.code).toBe('screening_failed');
    expect(out.thought).toBeUndefined();
    expect(await rows('SELECT * FROM thoughts WHERE token_id = ?', PAYER)).toEqual([]);
    expect(await rows('SELECT 1 FROM hires')).toEqual([]);
    expect((await rows('SELECT kind FROM project_spend'))).toEqual([{ kind: 'will_screening' }]);
    expect(await level(tk)).toBe(1);
    // nothing reached the asker: the place is back, no answer counted, and it did no work worth a step
    expect(await places()).toEqual({ n: 0, held: 0 });
    expect(await rows('SELECT 1 FROM pet_life WHERE token_id = ?', WORKER)).toEqual([]);
    expect(JSON.stringify(await rows('SELECT * FROM thoughts'))).not.toContain('A secret question');
  });

  // spec: add-pet-work › Advice flow › пустой ответ работника
  // spec: add-pet-will › Character refusal flow › no signed answer
  it('shows a failed screening with no charge for an empty worker answer; the question stays with the player', async () => {
    addPets(h);
    const tk = await payerToken();
    h.net().ai.push({ content: '' });
    const out = await advise(tk);
    expect(out.code).toBe('screening_failed');
    expect(await rows('SELECT 1 FROM thoughts')).toEqual([]);
    expect(await rows('SELECT 1 FROM hires')).toEqual([]);
    expect(await level(tk)).toBe(1);
    expect(await places()).toEqual({ n: 0, held: 0 });
  });

  // spec: add-pet-work › Advice flow › memory cleared on the way
  // spec: add-pet-work › Hire food data › memory cleared before the answer
  // spec: add-pet-work › Hire quote data › no answer
  it('ends with `memory_cleared` when the paying pet\'s memory is cleared while the worker answers: no fee and no hire, the answer by usage, the place back, the worker earns nothing', async () => {
    addPets(h);
    const tk = await payerToken();
    h.net().ai.push({ delay: 500 });
    const sent = await postAdvice(tk, { text: 'A private question' });
    await until(() => h.net().ai.calls.length === 1);
    expect((await api(`/api/pets/${PAYER}/memory/clear`, { token: tk, method: 'POST' })).status).toBe(200);
    const out = await settle(tk, PAYER, sent.body.job);

    expect(out.code).toBe('memory_cleared');
    expect(out.thought).toBeUndefined();
    const [thought] = await rows('SELECT * FROM thoughts WHERE token_id = ?', PAYER);
    expect(thought).toMatchObject({ player_text: null, reply_text: null, status: 'unbilled', worker_id: WORKER });
    expect(thought.erased_at).not.toBeNull();
    // the bytes of the call go too; the receipt's hashes and signature stay
    const [call] = await rows('SELECT length(req_bytes) AS req, length(res_bytes) AS res, req_sha256, signature FROM thought_calls WHERE thought_id = ?', thought.id);
    expect(call).toMatchObject({ req: 0, res: 0 });
    expect(call.req_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(call.signature).toMatch(/^0xsig-/);
    // no fee and no hire: the paying pet pays the worker's answer by usage, far below a fee
    expect(await rows('SELECT 1 FROM hires')).toEqual([]);
    expect(BigInt(thought.price_yocto)).toBeLessThan(FEE);
    expect(await level(tk)).toBeGreaterThan(Number(S - FEE) / Number(S));
    expect(await level(tk)).toBeLessThan(1);
    // the place went back and the worker did no work: the count and the price stay as they were
    expect(await places()).toEqual({ n: 0, held: 0 });
    expect(await rows('SELECT 1 FROM pet_life WHERE token_id = ?', WORKER)).toEqual([]);
    expect(await shownPrice()).toBe(FEE.toString());
    expect((await api(`/api/pets/${PAYER}/conversation`, { token: tk })).body.lines).toEqual([]);
    expect(JSON.stringify(await rows('SELECT * FROM thoughts'))).not.toContain('A private question');
  });

  // spec: add-pet-work › Advice flow › memory cleared on the way
  // spec: add-pet-work › Hire food data › memory cleared before the answer
  it('refuses the hire\'s row itself when a clear lands between the worker\'s answer and the batch: no fee, the words erased', async () => {
    addPets(h);
    await env.DB.prepare('INSERT INTO pets (token_id, hatched_by, born_at, birth_tx, memory_epoch) VALUES (?, ?, 1, \'\', 1)').bind(PAYER, PAYER_OWNER).run();
    const outcome = {
      kind: 'answer' as const,
      reply: 'Plant radishes.',
      price: 1000n,
      skilled: false,
      data: null,
      labels: [],
      call: {
        answer: { reqBytes: new Uint8Array([1]), resBytes: new Uint8Array([2]), reqSha: 'a'.repeat(64), resSha: 'b'.repeat(64), id: 'c', tokensIn: 10, tokensOut: 5, tokensReasoning: 0, finishReason: 'stop' },
        signed: { signature: '0xsig-x', sigKind: 'provider_tee', signer: '0xsigner' },
      },
    };
    const store = async (epoch: number, thoughtId: string) => {
      const { statements, hireAt } = answerStatements(env, {
        kind: 'advice', payerId: PAYER, thoughtId, sessionId: 's', stored: Date.now(), playerText: 'A private question', worker: { id: WORKER, name: 'Biscuit' },
        outcome: outcome as never, fee: FEE, hire: { kind: 'player', mode: null }, turnId: null, epoch,
      });
      const written = await env.DB.batch(statements);
      return written[hireAt!]!.results.length;
    };
    // the epoch of the claim is 0, the pet's is 1 now: the clear won
    expect(await store(0, 't1')).toBe(0);
    expect(await rows('SELECT 1 FROM hires')).toEqual([]);
    expect((await rows('SELECT player_text, reply_text, erased_at FROM thoughts WHERE id = ?', 't1'))[0]).toMatchObject({ player_text: null, reply_text: null });
    // the same epoch: the hire stands
    expect(await store(1, 't2')).toBe(1);
    expect((await rows('SELECT answer_thought_id, status FROM hires'))[0]).toEqual({ answer_thought_id: 't2', status: 'unbilled' });
    expect((await rows('SELECT reply_text FROM thoughts WHERE id = ?', 't2'))[0]).toEqual({ reply_text: 'Plant radishes.' });
  });

  // spec: add-pet-work › Hire quote data › shown price too low
  it('answers `price_rose` with the price now when the price shown is below it: nothing goes to NEAR AI, nothing is held or spent', async () => {
    addPets(h, { project_food: (100n * S).toString() });
    await saveSkill('water the plants every morning');
    const tk = await payerToken();
    const shown = await shownPrice();
    // another asker's answer raises the price by a step after the page showed it
    await advise(tk, { price: shown });
    const calls = h.net().ai.calls.length;
    const before = await level(tk);
    const out = await advise(tk, { price: shown });
    expect(out).toMatchObject({ code: 'price_rose', price: { yocto: (FEE + HIRE_FEE_STEP_YOCTO).toString(), cents: hireCents(FEE + HIRE_FEE_STEP_YOCTO, Number(env.NEAR_USD_RATE)) } });
    expect(h.net().ai.calls).toHaveLength(calls);
    expect(await places()).toEqual({ n: 1, held: 0 });
    expect(await level(tk)).toBe(before);
    // a new tap at the new price goes through
    expect((await advise(tk, { price: (FEE + HIRE_FEE_STEP_YOCTO).toString() })).thought.price).toBe((FEE + HIRE_FEE_STEP_YOCTO).toString());
  });

  // spec: add-pet-work › Hire price rule › new day
  it('takes a tap at a higher price still on screen at the lower price of the new day', async () => {
    addPets(h);
    await saveSkill('water the plants every morning');
    // yesterday's answers raised the price; today there are none
    await env.DB.prepare('INSERT INTO worker_answers (token_id, day, n) VALUES (?, ?, 4)').bind(WORKER, day() - 1).run();
    const high = (FEE + 4n * HIRE_FEE_STEP_YOCTO).toString();
    const out = await advise(await payerToken(), { price: high });
    expect(out.thought.price).toBe(FEE.toString());
    expect(await rows('SELECT fee_yocto FROM hires')).toEqual([{ fee_yocto: FEE.toString() }]);
  });
});

describe('Advice flow facts', () => {
  // spec: add-pet-work › Advice flow › совет открыт
  it('tells the page the price, the friend\'s pet and the paying pet: all well', async () => {
    addPets(h);
    const out = await facts(await payerToken());
    expect(out.status).toBe(200);
    expect(out.body).toEqual({
      last: null,
      price: { yocto: FEE.toString(), cents: hireCents(FEE, Number(env.NEAR_USD_RATE)) },
      skilled: false,
      screeningAvailable: true,
      screeningResetAt: null,
      labels: [],
      workerAsleep: false,
      resting: null,
      payer: { tokenId: PAYER, name: 'Pixel', state: 'ok', until: null },
      dropsAt: null,
      pending: null,
      paused: false,
    });
  });

  // spec: add-pet-work › Advice flow › advice from a pet with a skill
  it('says the pet has a skill, and when a price above its start falls back', async () => {
    addPets(h);
    await saveSkill('water the plants every morning');
    const tk = await payerToken();
    expect((await facts(tk)).body).toMatchObject({ skilled: true, dropsAt: null });
    await env.DB.prepare('INSERT INTO worker_answers (token_id, day, n) VALUES (?, ?, 2)').bind(WORKER, day()).run();
    expect((await facts(tk)).body).toMatchObject({ skilled: true, price: { yocto: (FEE + 2n * HIRE_FEE_STEP_YOCTO).toString() }, dropsAt: midnight() });
  });

  // spec: add-pet-work › Advice flow › работник уснул
  it('says the friend\'s pet is asleep, and refuses the job with nothing held', async () => {
    addPets(h, {}, { project_food: '0' });
    const tk = await payerToken();
    expect((await facts(tk)).body.workerAsleep).toBe(true);
    expect(await advise(tk)).toMatchObject({ code: 'worker_asleep' });
    expect(h.net().ai.calls).toHaveLength(0);
    expect(await places()).toBeNull();
    expect(await level(tk)).toBe(1);
  });

  // spec: add-pet-work › Advice flow › свой питомец не может заплатить
  it('says the paying pet is asleep, or would keep no food for one scale thought after the price', async () => {
    addPets(h, { project_food: '0' });
    const tk = await payerToken();
    expect((await facts(tk)).body.payer).toMatchObject({ state: 'asleep', until: null });
    expect(await advise(tk)).toMatchObject({ code: 'asleep' });

    // 0.00095 NEAR: awake, but 0.00095 − 0.00083 is below one scale thought
    h.net().contract.pets.get(PAYER)!.project_food = '950000000000000000000';
    expect((await facts(tk)).body.payer).toMatchObject({ state: 'short', until: null });
    expect(await advise(tk)).toMatchObject({ code: 'short' });
    expect(h.net().ai.calls).toHaveLength(0);
    expect(await places()).toBeNull();
  });

  // spec: add-pet-work › Advice flow › свой питомец устал
  it('says the paying pet is tired when the price is over what the daily cap leaves, until 00:00 UTC', async () => {
    addPets(h, { debited_today: '49500000000000000000000' });
    const tk = await payerToken();
    expect((await facts(tk)).body.payer).toMatchObject({ state: 'tired', until: midnight() });
    expect(await advise(tk)).toMatchObject({ code: 'tired' });
    expect(h.net().ai.calls).toHaveLength(0);
    expect(await level(tk)).toBe(1);
  });

  // spec: add-pet-work › Advice flow › several at once
  it('puts the paying pet\'s asleep before its being tired, and the friend\'s pet after the paying pet', async () => {
    addPets(h, { project_food: '0', debited_today: '49500000000000000000000' }, { project_food: '0' });
    const tk = await payerToken();
    const out = await facts(tk);
    expect(out.body.payer.state).toBe('asleep');
    expect(out.body.workerAsleep).toBe(true);
    expect(await advise(tk)).toMatchObject({ code: 'asleep' });
  });

  // spec: add-pet-work › Advice flow › работник уснул
  it('says the friend\'s pet is resting when it has no energy left today, and when it has answered as often as a day allows', async () => {
    addPets(h);
    const tk = await payerToken();
    await env.DB.prepare('INSERT INTO pet_life (token_id, energy_day, energy_used) VALUES (?, ?, 10)').bind(WORKER, day()).run();
    expect((await facts(tk)).body.resting).toEqual({ until: midnight() });
    expect(await advise(tk)).toMatchObject({ code: 'worker_resting' });
    expect(h.net().ai.calls).toHaveLength(0);

    // ten answers today and no energy used up: the same rest, to 00:00 UTC
    await env.DB.exec('DELETE FROM pet_life');
    expect((await facts(tk)).body.resting).toBeNull();
    await env.DB.prepare('INSERT INTO worker_answers (token_id, day, n) VALUES (?, ?, 10)').bind(WORKER, day()).run();
    expect((await facts(tk)).body.resting).toEqual({ until: midnight() });
    expect(await advise(tk)).toMatchObject({ code: 'worker_resting' });
  });

  // spec: add-pet-work › Advice flow › several at once
  it('refuses a question on a pause with nothing queued', async () => {
    addPets(h);
    await setPause(env.DB, 'ai', Date.now());
    const sent = await postAdvice(await payerToken(), {});
    expect(sent).toMatchObject({ status: 409, body: { code: 'paused' } });
    expect(await rows('SELECT 1 FROM jobs')).toEqual([]);
  });

  // spec: add-pet-work › Advice flow › several at once
  it('carries the services\' pause in the page\'s read, and drops it when the pause lifts, with no other change', async () => {
    addPets(h);
    const tk = await payerToken();
    expect((await facts(tk)).body.paused).toBe(false);
    await setPause(env.DB, 'ai', Date.now());
    const paused = await facts(tk);
    expect(paused.status).toBe(200);
    expect(paused.body).toMatchObject({ paused: true, workerAsleep: false, payer: { state: 'ok' } });
    await clearPause(env.DB);
    expect((await facts(tk)).body.paused).toBe(false);
  });

  // spec: add-pet-work › Advice flow › вопрос отправлен
  it('takes a question of 500 code points with a visible sign, and no more', async () => {
    addPets(h);
    const tk = await payerToken();
    expect((await postAdvice(tk, { text: 'x'.repeat(501) })).status).toBe(400);
    expect((await postAdvice(tk, { text: ' \n ' })).status).toBe(400);
    expect((await postAdvice(tk, { text: 42 })).status).toBe(400);
    expect((await postAdvice(tk, { price: '1.5' })).status).toBe(400);
    expect(await rows('SELECT 1 FROM jobs')).toEqual([]);
    expect((await postAdvice(tk, { text: '😀'.repeat(500) })).status).toBe(202);
  });

  // spec: add-pet-work › Advice flow › совет открыт
  it('asks nothing of a player who is signed out, a worker that does not exist, or the player\'s own pet', async () => {
    addPets(h);
    h.net().contract.addPet('7', PAYER_OWNER, { name: 'Other' });
    const tk = await payerToken();
    expect((await api(`/api/pets/${WORKER}/advice?payer=${PAYER}`)).status).toBe(401);
    expect((await facts(tk)).status).toBe(200);
    expect((await api(`/api/pets/99/advice?payer=${PAYER}`, { token: tk })).status).toBe(404);
    expect((await api(`/api/pets/7/advice?payer=${PAYER}`, { token: tk })).body).toEqual({ code: 'same_owner' });
    expect((await api(`/api/pets/${WORKER}/advice?payer=x`, { token: tk })).status).toBe(400);
  });
});

describe('Advice follow-up and a page opened again', () => {
  const sent = () => h.net().ai.calls.at(-1)!.body.messages;

  // spec: add-pet-work › Hire request data › a follow-up question
  // spec: add-pet-work › Advice flow › вопрос отправлен
  it('sends the asker\'s last exchange with this worker before the new question, and no older one', async () => {
    addPets(h, { project_food: (100n * S).toString() });
    const tk = await payerToken();
    h.net().ai.push({ content: 'Plant radishes.' });
    await advise(tk, { text: 'What should I plant?' });
    expect(sent().map((m) => m.role)).toEqual(['system', 'user']);

    h.net().ai.push({ content: 'They grow fast.' });
    await advise(tk, { text: 'Why?' });
    expect(sent().map((m) => [m.role, m.content]).slice(1)).toEqual([
      ['user', 'What should I plant?'],
      ['assistant', 'Plant radishes.'],
      ['user', 'Why?'],
    ]);

    h.net().ai.push({ content: 'Water them.' });
    await advise(tk, { text: 'And then?' });
    // only the last exchange goes: the first is not told again
    expect(sent().map((m) => m.content).slice(1)).toEqual(['Why?', 'They grow fast.', 'And then?']);
    // the worker's side keeps nothing of it
    expect(await rows('SELECT 1 FROM thoughts WHERE token_id = ?', WORKER)).toEqual([]);
    expect(JSON.stringify(await rows('SELECT * FROM memory_notes WHERE token_id = ?', WORKER))).not.toContain('radishes');
  });

  // spec: add-pet-work › Hire request data › a follow-up question
  it('sends nothing of another worker\'s exchange, and a skilled worker gets its own answer back', async () => {
    addPets(h, { project_food: (100n * S).toString() });
    h.net().contract.addPet('7', NEAR_ACCOUNT(3), { name: 'Nori', character: 'I am a calm nori.' });
    await saveSkill('water the plants every morning');
    const tk = await payerToken();
    h.net().ai.push({ content: 'Plant radishes.' });
    await advise(tk, { text: 'What should I plant?' });
    // another worker has not been asked before
    await advise(tk, { text: 'What should I plant?' }, '7');
    expect(sent().map((m) => m.role)).toEqual(['system', 'user']);
    // the skilled one is asked again: its own answer comes back to it, though its pet's memory does not hold it (recall 0)
    h.net().ai.push({ content: 'Because they are quick.' });
    await advise(tk, { text: 'Why?' });
    expect(sent().map((m) => m.content).slice(1)).toEqual(['What should I plant?', 'Plant radishes.', 'Why?']);
  });

  // spec: add-pet-work › Hire request data › a follow-up question × memory cleared
  it('forgets the exchange with the asker\'s memory: a clear leaves nothing to tell', async () => {
    addPets(h, { project_food: (100n * S).toString() });
    const tk = await payerToken();
    h.net().ai.push({ content: 'Plant radishes.' });
    await advise(tk, { text: 'What should I plant?' });
    expect((await api(`/api/pets/${PAYER}/memory/clear`, { token: tk, method: 'POST' })).status).toBe(200);
    await advise(tk, { text: 'Why?' });
    expect(sent().map((m) => m.role)).toEqual(['system', 'user']);
  });

  // spec: add-pet-work › Advice flow › page opened again
  // spec: add-pet-work › Advice flow › page opened again × memory cleared
  it('gives the page the last question with its answer and the fee, and the question in flight with nothing answered', async () => {
    addPets(h);
    const tk = await payerToken();
    h.net().ai.push({ content: 'Plant radishes.' });
    await advise(tk, { text: 'What should I plant?' });
    const answered = (await facts(tk)).body;
    const [thought] = await rows("SELECT id FROM thoughts WHERE token_id = ? AND kind = 'advice'", PAYER);
    expect(answered.last).toEqual({
      id: thought.id,
      question: 'What should I plant?',
      text: 'Plant radishes.',
      skilled: false,
      price: FEE.toString(),
      priceCents: Number((hireCents(FEE, Number(env.NEAR_USD_RATE)) * 1).toPrecision(2)),
    });
    expect(answered.pending).toBeNull();

    // a new question on its way: the page shows it with «is thinking…» while the earlier answer waits behind it
    h.net().ai.push({ delay: 80 });
    const next = await postAdvice(tk, { text: 'Why?' });
    await until(() => h.net().ai.calls.length === 2);
    expect((await facts(tk)).body.pending).toEqual({ job: next.body.job, question: 'Why?' });
    await settle(tk, PAYER, next.body.job);

    // cleared memory: nothing of the exchange is left to show
    expect((await api(`/api/pets/${PAYER}/memory/clear`, { token: tk, method: 'POST' })).status).toBe(200);
    expect((await facts(tk)).body.last).toBeNull();
  });
});
