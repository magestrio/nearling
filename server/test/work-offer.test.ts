// A pet in Manual asks first (`add-pet-work` › `Pet hire flow`): the offer the pet leaves at its decision, the owner's
// answer to it (a tap on «Ask {worker}», «No thanks», a new line) and what an offer standing meets on the way.
import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { utcDay } from '../src/http';
import { HIRE_FEE_MIN_YOCTO, HIRE_FEE_STEP_YOCTO } from '../src/pricing';
import { unbilledYocto } from '../src/pet/view';
import { api, harness, say, settle } from './helpers/api';
import { NEAR_ACCOUNT, token } from './helpers/network';
import { addHirer, addWorker, PAYER, payerToken, saveSkill, until } from './helpers/work';

const h = harness();
const FEE = HIRE_FEE_MIN_YOCTO;
const day = () => utcDay(Date.now());
const rows = async (sql: string, ...bind: unknown[]) => (await env.DB.prepare(sql).bind(...bind).all<any>()).results;
const places = async (id = '6') => env.DB.prepare('SELECT n, held FROM worker_answers WHERE token_id = ? AND day = ?').bind(id, day()).first<{ n: number; held: number }>();
const ask = (n = 1, question = 'How do I grow radishes?') => ({ content: `ASK ${n}: ${question}` });
const calls = () => h.net().ai.calls;
const role = (call: number, i = 0) => calls()[call]!.body.messages[i]!;
const state = async (tk: string, job?: string) => (await api(`/api/pets/${PAYER}/state${job === undefined ? '' : `?job=${job}`}`, { token: tk })).body;
const post = (tk: string, path: string, body?: unknown) => api(`/api/pets/${PAYER}/${path}`, { token: tk, method: 'POST', ...(body === undefined ? {} : { body }) });
const tap = async (tk: string, price: string = FEE.toString()) => {
  const sent = await post(tk, 'offer/ask', { price });
  return sent.status === 202 ? settle(tk, PAYER, sent.body.job) : { sent: sent.status, ...sent.body };
};

/** A pet in Manual that knows a worker, and the turn that left an offer for it. */
async function offered(patch = {}, worker = {}): Promise<string> {
  addHirer(h, patch);
  await addWorker(h, '6', 2, worker);
  await env.DB.prepare("INSERT OR REPLACE INTO hire_modes (token_id, mode) VALUES (?, 'manual')").bind(PAYER).run();
  const tk = await payerToken();
  h.net().ai.push(ask());
  const out = await say(tk, PAYER, 'What should I plant?');
  expect(out.code).toBe('offer');
  return tk;
}

describe('Pet hire flow', () => {
  // spec: add-pet-work › Pet hire flow › предложение в Manual
  it('stops at an offer: the decision thought only, the offer row with the price now, nothing else spent', async () => {
    const tk = await offered();
    expect(calls()).toHaveLength(1);
    expect(role(0).content).toContain('[1] character: "I am worker number 6."');
    const [t] = await rows('SELECT * FROM thoughts WHERE token_id = ?', PAYER);
    expect(t).toMatchObject({ kind: 'hire_question', player_text: 'What should I plant?', reply_text: 'How do I grow radishes?', worker_id: '6', worker_name: 'Worker6', status: 'unbilled' });
    expect(await rows('SELECT * FROM hire_offers')).toEqual([
      { token_id: PAYER, turn_id: t.turn_id, worker_id: '6', worker_name: 'Worker6', question: 'How do I grow radishes?', price_yocto: FEE.toString(), created_at: expect.any(Number) },
    ]);
    // no fee, no hire, no place, no work for the worker, no own reply
    expect(await rows('SELECT 1 FROM hires')).toEqual([]);
    expect(await rows('SELECT 1 FROM thoughts WHERE token_id <> ?', PAYER)).toEqual([]);
    expect(await places()).toBeNull();
    expect(await unbilledYocto(env.DB, PAYER)).toBe(BigInt(t.price_yocto));
    expect(await rows('SELECT 1 FROM pet_life WHERE token_id = ?', '6')).toEqual([]);
    // the owner's view carries the offer, with the worker's name and the price in yocto and cents
    const view = await state(tk);
    expect(view.offer).toMatchObject({ worker: 'Worker6', question: 'How do I grow radishes?', price: { yocto: FEE.toString(), cents: expect.any(Number) } });
    expect(view.pendingJob).toBeNull();
    // a reload reads the same offer from D1
    expect((await state(tk)).offer).toEqual(view.offer);
    expect(h.events().filter((e) => e.name === 'thought_delivered').map((e) => e.props.for)).toEqual(['hire']);
    expect(JSON.stringify(h.logs())).not.toMatch(/radishes|plant/i);
  });

  // spec: add-pet-work › Pet hire flow › спрашивает
  it('asks the worker when the owner taps «Ask {worker}»: the hire of the offer, mode manual, the offer gone, the answer instead of the ask', async () => {
    const tk = await offered();
    let progress: string | null = 'unset';
    h.net().ai.push({ content: 'Plant them in spring.', during: async () => void (progress = (await rows("SELECT progress FROM jobs WHERE token_id = ? AND status = 'running'", PAYER))[0]?.progress ?? null) }, { content: 'Spring, says Worker6.' });
    h.events().length = 0;
    const out = await tap(tk);

    expect(out.thought.text).toBe('Spring, says Worker6.');
    expect(JSON.parse(progress!)).toEqual({ asking: 'Worker6' });
    expect(calls()).toHaveLength(3);
    // the question the pet wrote goes to the worker; the own reply has the worker's words and no candidates
    expect(role(1, 1)).toEqual({ role: 'user', content: 'How do I grow radishes?' });
    expect(role(2).content).toContain('"Worker6" said: "Plant them in spring."');
    expect(role(2).content).not.toContain('Pets you know');
    expect(role(2, 1)).toEqual({ role: 'user', content: 'What should I plant?' });
    const turn = await rows('SELECT kind, turn_id FROM thoughts WHERE token_id = ? ORDER BY created_at, rowid', PAYER);
    expect(turn.map((t) => t.kind)).toEqual(['hire_question', 'hire_answer', 'reply']);
    expect(new Set(turn.map((t) => t.turn_id)).size).toBe(1);
    expect(await rows('SELECT hirer_id, worker_id, kind, mode, fee_yocto, status FROM hires')).toEqual([{ hirer_id: PAYER, worker_id: '6', kind: 'pet', mode: 'manual', fee_yocto: FEE.toString(), status: 'unbilled' }]);
    expect(await rows('SELECT 1 FROM hire_offers')).toEqual([]);
    expect(await places()).toEqual({ n: 1, held: 0 });
    expect((await state(tk)).offer).toBeNull();
    expect(h.events().filter((e) => e.name === 'hire_offer_answered')).toEqual([{ name: 'hire_offer_answered', props: { accepted: true } }]);
    expect(h.events().filter((e) => e.name === 'thought_delivered').map((e) => e.props.for)).toEqual(['hirer', 'owner']);
  });

  // spec: add-pet-work › Pet hire flow › price rose on an offer
  it('spends nothing when the price rose past the offer: the offer at the new price, then a new tap pays it', async () => {
    const tk = await offered();
    // the worker wrote a skill and answered once since: its price is the starting price plus one step
    await saveSkill('water the plants every morning', 'plants', '6');
    await env.DB.prepare('INSERT INTO worker_answers (token_id, day, n) VALUES (?, ?, 1)').bind('6', day()).run();
    const rose = FEE + HIRE_FEE_STEP_YOCTO;
    const before = calls().length;
    const unbilled = await unbilledYocto(env.DB, PAYER);

    const out = await tap(tk);
    expect(out.code).toBe('price_rose');
    expect(out.price).toMatchObject({ yocto: rose.toString() });
    expect(calls()).toHaveLength(before);
    expect(await unbilledYocto(env.DB, PAYER)).toBe(unbilled);
    expect(await rows('SELECT 1 FROM hires')).toEqual([]);
    expect(await places()).toEqual({ n: 1, held: 0 });
    // the offer stands at the new price, for the new tap
    expect((await rows('SELECT price_yocto FROM hire_offers'))[0]).toEqual({ price_yocto: rose.toString() });
    expect((await state(tk)).offer.price.yocto).toBe(rose.toString());

    h.net().ai.push({ content: 'Plant them in spring.' }, { content: 'Spring.' });
    const hired = await tap(tk, rose.toString());
    expect(hired.thought.text).toBe('Spring.');
    expect(await rows('SELECT fee_yocto, skilled FROM hires')).toEqual([{ fee_yocto: rose.toString(), skilled: 1 }]);
  });

  // spec: add-pet-work › Pet hire flow › предложение в Manual × new day
  it('pays the lower price when the tap comes after 00:00 UTC: the price shown is only a ceiling', async () => {
    await offered();
    // the offer was made at a higher price: the skilled worker had answered once that day
    await saveSkill('water the plants every morning', 'plants', '6');
    await env.DB.prepare('INSERT INTO worker_answers (token_id, day, n) VALUES (?, ?, 1)').bind('6', day()).run();
    await env.DB.prepare('UPDATE hire_offers SET price_yocto = ?').bind((FEE + HIRE_FEE_STEP_YOCTO).toString()).run();
    vi.setSystemTime(Date.now() + 24 * 3_600_000);
    h.net().ai.push({ content: 'Plant them in spring.' }, { content: 'Spring.' });
    // a session is good for an hour: the owner signs in again the next day
    const out = await tap(await payerToken(), (FEE + HIRE_FEE_STEP_YOCTO).toString());
    expect(out.thought.text).toBe('Spring.');
    expect(await rows('SELECT fee_yocto FROM hires')).toEqual([{ fee_yocto: FEE.toString() }]);
  });

  // spec: add-pet-work › Pet hire flow › отказ в Manual
  it('answers on its own, with no fee, when the owner taps «No thanks»', async () => {
    const tk = await offered();
    h.net().ai.push({ content: 'Plant them in spring.' });
    h.events().length = 0;
    const sent = await post(tk, 'offer/decline');
    expect(sent.status).toBe(202);
    const out = await settle(tk, PAYER, sent.body.job);

    expect(out.thought.text).toBe('Plant them in spring.');
    // the decision and the own reply; the worker is not called and no candidates are offered again
    expect(calls()).toHaveLength(2);
    expect(role(1).content).not.toContain('Pets you know');
    expect(role(1).content).not.toContain('You asked');
    expect(role(1, 1)).toEqual({ role: 'user', content: 'What should I plant?' });
    const turn = await rows('SELECT kind, player_text, reply_text, price_yocto FROM thoughts WHERE token_id = ? ORDER BY created_at, rowid', PAYER);
    expect(turn.map((t) => t.kind)).toEqual(['hire_question', 'reply']);
    expect(await rows('SELECT 1 FROM hire_offers')).toEqual([]);
    expect(await rows('SELECT 1 FROM hires')).toEqual([]);
    expect(await places()).toBeNull();
    expect(await unbilledYocto(env.DB, PAYER)).toBe(BigInt(turn[0]!.price_yocto) + BigInt(turn[1]!.price_yocto));
    expect(h.events().filter((e) => e.name === 'hire_offer_answered')).toEqual([{ name: 'hire_offer_answered', props: { accepted: false } }]);
  });

  // spec: add-pet-work › Pet hire flow › отказ в Manual
  // spec: add-pet-work › Pet hire flow › отказ в Manual × Think hard
  it('declines first and answers the new line next, whether the line is a chat line or «Think hard»', async () => {
    for (const mode of ['chat', 'deep'] as const) {
      await env.DB.exec('DELETE FROM jobs');
      await env.DB.exec('DELETE FROM thoughts');
      const tk = await offered();
      h.net().ai.push({ content: 'On my own.' }, { content: mode === 'deep' ? 'Deeply.' : 'Next.' });
      const sent = await api(`/api/pets/${PAYER}/thoughts`, { token: tk, body: { text: 'Never mind, tell me a joke', mode } });
      expect(sent.status).toBe(202);
      const out = await settle(tk, PAYER, sent.body.job);
      expect(out.thought.text).toBe(mode === 'deep' ? 'Deeply.' : 'Next.');
      expect((await rows("SELECT kind FROM jobs WHERE token_id = ? ORDER BY created_at, rowid", PAYER)).map((j) => j.kind)).toEqual(['reply', 'decline', 'reply']);
      const turn = await rows('SELECT kind, player_text, reply_text FROM thoughts WHERE token_id = ? ORDER BY created_at, rowid', PAYER);
      expect(turn.map((t) => [t.kind, t.player_text, t.reply_text])).toEqual([
        ['hire_question', 'What should I plant?', 'How do I grow radishes?'],
        ['reply', 'What should I plant?', 'On my own.'],
        [mode === 'deep' ? 'deep' : 'reply', 'Never mind, tell me a joke', mode === 'deep' ? 'Deeply.' : 'Next.'],
      ]);
      expect(await rows('SELECT 1 FROM hire_offers')).toEqual([]);
      expect(await rows('SELECT 1 FROM hires')).toEqual([]);
      h.net().ai.calls.length = 0;
      await env.DB.exec('DELETE FROM thought_calls');
      await env.DB.exec('DELETE FROM empty_answers');
    }
  });

  // spec: add-pet-work › Pet hire flow › предложение в Manual × gift
  it('goes with the pet at a gift: the new owner reads the offer and answers it, the old one cannot', async () => {
    const tk = await offered();
    h.net().contract.pets.get(PAYER)!.owner_id = NEAR_ACCOUNT(4);
    expect((await post(tk, 'offer/decline')).status).toBe(403);
    expect((await state(tk)).code).toBe('not_owner');
    const next = await token('did:privy:next', NEAR_ACCOUNT(4));
    expect((await state(next)).offer).toMatchObject({ worker: 'Worker6' });
    h.net().ai.push({ content: 'Plant them in spring.' }, { content: 'Spring.' });
    expect((await tap(next)).thought.text).toBe('Spring.');
  });

  // spec: add-pet-work › Pet hire flow › предложение в Manual × mode switched
  it('stays when the owner switches to Auto: the tap is still a Manual hire', async () => {
    const tk = await offered();
    expect((await api(`/api/pets/${PAYER}/hire-mode`, { method: 'PUT', token: tk, body: { mode: 'auto' } })).status).toBe(200);
    expect((await state(tk)).offer).toMatchObject({ worker: 'Worker6' });
    h.net().ai.push({ content: 'Plant them in spring.' }, { content: 'Spring.' });
    expect((await tap(tk)).thought.text).toBe('Spring.');
    expect(await rows('SELECT mode FROM hires')).toEqual([{ mode: 'manual' }]);
  });

  // spec: add-pet-work › Pet hire flow › найм не состоялся
  it('answers on its own, no fee, the offer gone, when the worker fell asleep before the tap', async () => {
    const tk = await offered();
    h.net().contract.pets.get('6')!.project_food = '0';
    h.net().ai.push({ content: 'Alone.' });
    const out = await tap(tk);
    expect(out.thought.text).toBe('Alone.');
    expect(calls()).toHaveLength(2);
    expect((await rows('SELECT kind, reply_text FROM thoughts WHERE token_id = ? ORDER BY created_at, rowid', PAYER)).map((t) => [t.kind, t.reply_text])).toEqual([
      ['hire_question', 'How do I grow radishes?'],
      ['hire_event', 'failed'],
      ['reply', 'Alone.'],
    ]);
    expect(await rows('SELECT 1 FROM hires')).toEqual([]);
    expect(await rows('SELECT 1 FROM hire_offers')).toEqual([]);
  });

  // spec: add-pet-work › Pet hire flow › нажатая кнопка вернулась
  it('keeps the offer when the tapped «Ask {worker}» ends with no answer of the worker and none of the pet: the buttons come back, no fee, no event line', async () => {
    const tk = await offered();
    h.net().contract.pets.get('6')!.project_food = '0';
    h.net().ai.push({ status: 500 });
    h.events().length = 0;
    const out = await tap(tk);

    expect(out.code).toBe('ai_unavailable');
    // the offer still stands for the next tap, the turn reads as it did before the tap
    expect((await state(tk)).offer).toMatchObject({ worker: 'Worker6', question: 'How do I grow radishes?' });
    expect((await rows('SELECT kind FROM thoughts WHERE token_id = ?', PAYER)).map((t) => t.kind)).toEqual(['hire_question']);
    expect(await rows('SELECT 1 FROM hires')).toEqual([]);
    expect(await places()).toBeNull();
    expect(h.events().filter((e) => e.name === 'hire_offer_answered')).toEqual([]);

    // the worker is back: the same offer is hired at the next tap, the offer answered once
    h.net().contract.pets.get('6')!.project_food = FEE.toString();
    h.net().ai.push({ content: 'Plant them in spring.' }, { content: 'Spring.' });
    expect((await tap(tk)).thought.text).toBe('Spring.');
    expect(await rows('SELECT 1 FROM hire_offers')).toEqual([]);
    expect(h.events().filter((e) => e.name === 'hire_offer_answered')).toEqual([{ name: 'hire_offer_answered', props: { accepted: true } }]);
  });

  // spec: add-pet-work › Pet hire flow › нажатая кнопка вернулась
  it('keeps the offer when a tapped «Ask {worker}» meets an empty reply the pet pays for, and when «No thanks» does', async () => {
    const tk = await offered();
    await env.DB.prepare('INSERT INTO empty_answers (token_id, day, n) VALUES (?, ?, 3)').bind(PAYER, day()).run();
    h.net().contract.pets.get('6')!.project_food = '0';
    h.net().ai.push({ content: '', tokensOut: 12 });
    expect((await tap(tk)).code).toBe('empty_paid');
    expect((await state(tk)).offer).toMatchObject({ worker: 'Worker6' });
    expect((await rows('SELECT kind FROM thoughts WHERE token_id = ? ORDER BY created_at, rowid', PAYER)).map((t) => t.kind)).toEqual(['hire_question', 'reply']);

    // the same for «No thanks»: a failed answer leaves the buttons, a good one takes them
    h.net().ai.push({ status: 500 });
    const declined = await post(tk, 'offer/decline');
    expect(declined.status).toBe(202);
    expect((await settle(tk, PAYER, declined.body.job)).code).toBe('ai_unavailable');
    expect((await state(tk)).offer).toMatchObject({ worker: 'Worker6' });
    h.net().ai.push({ content: 'On my own.' });
    const again = await post(tk, 'offer/decline');
    expect((await settle(tk, PAYER, again.body.job)).thought.text).toBe('On my own.');
    expect((await state(tk)).offer).toBeNull();
  });

  // spec: add-pet-work › Pet hire flow › нажатая кнопка вернулась
  it('does not keep the offer behind a new line that came instead of an answer: the line is the next turn', async () => {
    const tk = await offered();
    h.net().ai.push({ status: 500 }, { content: 'Next.' });
    const sent = await api(`/api/pets/${PAYER}/thoughts`, { token: tk, body: { text: 'Never mind', mode: 'chat' } });
    expect((await settle(tk, PAYER, sent.body.job)).thought.text).toBe('Next.');
    expect((await state(tk)).offer).toBeNull();
  });

  // spec: add-pet-work › Pet hire flow › offer goes stale
  it('is deleted where it is read once the hirer sleeps: its words stay, nothing is spent or queued, a late tap is `no_offer`', async () => {
    const tk = await offered();
    h.net().contract.pets.get(PAYER)!.project_food = '0';
    h.net().contract.pets.get(PAYER)!.given_food = '0';
    const jobs = (await rows('SELECT 1 FROM jobs')).length;
    const spent = calls().length;

    expect((await state(tk)).offer).toBeNull();
    expect(await rows('SELECT 1 FROM hire_offers')).toEqual([]);
    expect((await rows('SELECT reply_text FROM thoughts WHERE token_id = ? AND kind = ?', PAYER, 'hire_question'))[0]).toEqual({ reply_text: 'How do I grow radishes?' });
    expect((await api(`/api/pets/${PAYER}/conversation`, { token: tk })).body.lines.some((l: any) => l.hireTo === 'Worker6')).toBe(true);
    // a late «Ask» and «No thanks» find nothing, and nothing is queued
    expect(await post(tk, 'offer/ask', { price: FEE.toString() })).toMatchObject({ status: 409, body: { code: 'no_offer' } });
    expect(await post(tk, 'offer/decline')).toMatchObject({ status: 409, body: { code: 'no_offer' } });
    expect(await rows('SELECT 1 FROM jobs')).toHaveLength(jobs);
    expect(calls()).toHaveLength(spent);
    expect(await rows('SELECT 1 FROM hires')).toEqual([]);
  });

  // spec: add-pet-work › Pet hire flow › offer goes stale
  it('is also deleted by the route that meets it first: a tap on a pet that fell asleep', async () => {
    const tk = await offered();
    h.net().contract.pets.get(PAYER)!.project_food = '0';
    h.net().contract.pets.get(PAYER)!.given_food = '0';
    expect(await post(tk, 'offer/ask', { price: FEE.toString() })).toMatchObject({ status: 409, body: { code: 'no_offer' } });
    expect(await rows('SELECT 1 FROM hire_offers')).toEqual([]);
    expect(await rows('SELECT 1 FROM jobs WHERE kind IN (?, ?)', 'hire', 'decline')).toEqual([]);
  });
});

describe('Hire offer routes', () => {
  // spec: add-pet-work › Pet hire flow › предложение в Manual
  it('turn away a guest, a call without a session, a bad price, a pause, and a second tap while the first is on its way', async () => {
    const tk = await offered();
    const guest = await token('did:privy:guest', NEAR_ACCOUNT(7));
    expect(await post(guest, 'offer/ask', { price: FEE.toString() })).toMatchObject({ status: 403, body: { code: 'not_owner' } });
    expect(await post(guest, 'offer/decline')).toMatchObject({ status: 403 });
    expect(await api(`/api/pets/${PAYER}/offer/decline`, { method: 'POST' })).toMatchObject({ status: 401 });
    for (const bad of [undefined, 7, '', '1.5', '-1', 'x'.repeat(5)]) expect(await post(tk, 'offer/ask', { price: bad })).toMatchObject({ status: 400, body: { code: 'bad_request' } });
    expect(await rows('SELECT 1 FROM jobs WHERE kind IN (?, ?)', 'hire', 'decline')).toEqual([]);

    h.net().ai.push({ content: 'Plant them in spring.', delay: 80 }, { content: 'Spring.' });
    const sent = await post(tk, 'offer/ask', { price: FEE.toString() });
    expect(sent.status).toBe(202);
    await until(() => calls().length === 2);
    expect(await post(tk, 'offer/ask', { price: FEE.toString() })).toMatchObject({ status: 409, body: { code: 'no_offer' } });
    expect(await post(tk, 'offer/decline')).toMatchObject({ status: 409, body: { code: 'no_offer' } });
    await settle(tk, PAYER, sent.body.job);
    expect(await rows('SELECT 1 FROM hires')).toHaveLength(1);
  });

  // spec: add-pet-work › Pet hire flow › offer goes stale
  it('find no offer to answer on a pet that made none: 409 no_offer, nothing queued', async () => {
    addHirer(h);
    const tk = await payerToken();
    expect(await post(tk, 'offer/ask', { price: FEE.toString() })).toMatchObject({ status: 409, body: { code: 'no_offer' } });
    expect(await post(tk, 'offer/decline')).toMatchObject({ status: 409, body: { code: 'no_offer' } });
    expect(await rows('SELECT 1 FROM jobs')).toEqual([]);
  });
});
