import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { petView } from '../src/chain';
import { utcDay } from '../src/http';
import { HIRE_AUTO_LIMIT_YOCTO, HIRE_FEE_MIN_YOCTO, HIRE_FEE_STEP_YOCTO } from '../src/pricing';
import { unbilledYocto } from '../src/pet/view';
import { tick } from '../src/cron';
import { parseReaction } from '../src/society/reaction';
import { checkWorker } from '../src/work/candidates';
import { hold, pairPrice, release } from '../src/work/quote';
import { api, harness, say, settle } from './helpers/api';
import { addHirer, addWorker, addPets, advise, hirerNow, PAYER, payerToken, saveSkill, WORKER } from './helpers/work';

const h = harness();
const day = () => utcDay(Date.now());
const liked = async () => env.DB.prepare("INSERT INTO society_relations (token_id, other_id, stance, created_at) VALUES (?, ?, 'liked', ?)")
  .bind(PAYER, WORKER, Date.now()).run();
const refuse = async (until = Date.now() + 86_400_000) => env.DB.prepare(
  "INSERT INTO society_relations (token_id, other_id, stance, break_until, created_at) VALUES (?, ?, 'strained', ?, ?)",
).bind(WORKER, PAYER, until, Date.now()).run();

describe('society quote and paid answer', () => {
  // spec: add-pet-society › Society quote data › liked pair
  it('holds the exact 10% fee from the experience-neutral base and returns to base after erasure', async () => {
    await liked();
    const expected = HIRE_FEE_MIN_YOCTO * 9n / 10n;
    expect((await pairPrice(env, PAYER, WORKER, day(), Date.now())).yocto).toBe(expected);
    expect(await hold(env, WORKER, day(), expected, Date.now(), PAYER)).toMatchObject({ ok: true, fee: expected, discounted: true });
    await release(env, WORKER, day());
    await env.DB.prepare('DELETE FROM society_relations WHERE token_id = ?').bind(PAYER).run();
    expect((await pairPrice(env, PAYER, WORKER, day(), Date.now())).yocto).toBe(HIRE_FEE_MIN_YOCTO);
    expect(await hold(env, WORKER, day(), expected, Date.now(), PAYER)).toEqual({ ok: false, price: HIRE_FEE_MIN_YOCTO, open: true });
  });

  // spec: add-pet-society › Society quote data › liked pair
  it('applies the discount after skill growth, but keeps the tenth worker place cap', async () => {
    await liked();
    await saveSkill('Care for seedlings.');
    await env.DB.prepare('INSERT INTO worker_answers (token_id, day, n) VALUES (?, ?, 3)').bind(WORKER, day()).run();
    const base = HIRE_FEE_MIN_YOCTO + 3n * HIRE_FEE_STEP_YOCTO;
    const fee = base * 9n / 10n;
    expect((await pairPrice(env, PAYER, WORKER, day(), Date.now())).yocto).toBe(fee);
    expect(await hold(env, WORKER, day(), fee, Date.now(), PAYER)).toMatchObject({ ok: true, fee, discounted: true });
    await release(env, WORKER, day());
    await env.DB.prepare('UPDATE worker_answers SET n = 10 WHERE token_id = ? AND day = ?').bind(WORKER, day()).run();
    expect(await hold(env, WORKER, day(), HIRE_AUTO_LIMIT_YOCTO, Date.now(), PAYER)).toMatchObject({ ok: false, open: false });
  });

  // spec: add-pet-society › Society hire flow › auto paid
  it('checks the discounted effective fee against Auto’s existing ceiling', async () => {
    addHirer(h);
    await addWorker(h, WORKER, 2);
    await liked();
    await saveSkill('Care for seedlings.');
    await env.DB.prepare('INSERT INTO worker_answers (token_id, day, n) VALUES (?, ?, 3)').bind(WORKER, day()).run();
    const worker = (await petView(env, WORKER))!;
    const check = await checkWorker(env, await hirerNow(), WORKER, worker, 'auto', Date.now());
    expect(check).toEqual({ ok: false, why: 'over_limit' });
    expect((await pairPrice(env, PAYER, WORKER, day(), Date.now())).yocto).toBeGreaterThan(HIRE_AUTO_LIMIT_YOCTO);
  });

  // spec: add-pet-society › Society hire flow › player advice quote
  it('returns the pair price before advice and charges exactly that fee', async () => {
    addPets(h);
    await liked();
    const tk = await payerToken();
    const shown = await api(`/api/pets/${WORKER}/advice?payer=${PAYER}`, { token: tk });
    const fee = HIRE_FEE_MIN_YOCTO * 9n / 10n;
    expect(shown.body.price.yocto).toBe(fee.toString());
    expect(shown.body.discounted).toBe(true);
    h.net().ai.push({ content: 'Try mint. [[society:respectful]]' });
    const out = await advise(tk, { price: fee.toString() });
    expect(out.thought.text).toBe('Try mint.');
    expect((await env.DB.prepare('SELECT fee_yocto FROM hires').first<{ fee_yocto: string }>())?.fee_yocto).toBe(fee.toString());
    expect((await env.DB.prepare('SELECT society_reaction FROM hires').first<{ society_reaction: string }>())?.society_reaction).toBe('respectful');
    expect(h.net().ai.calls[0]!.body.messages[0]!.content).toContain('current pair stance is liked');
  });

  // spec: add-pet-society › Society quote data › liked pair × hire/Clear memory/eviction/gift/reload
  it('requires a fresh acceptance when the liked relation is erased after the advice quote', async () => {
    addPets(h);
    await liked();
    const tk = await payerToken();
    const shown = (await api(`/api/pets/${WORKER}/advice?payer=${PAYER}`, { token: tk })).body.price.yocto;
    await env.DB.prepare('DELETE FROM society_relations WHERE token_id = ? AND other_id = ?').bind(PAYER, WORKER).run();
    const out = await advise(tk, { price: shown });
    expect(out.code).toBe('price_rose');
    expect(out.price.yocto).toBe(HIRE_FEE_MIN_YOCTO.toString());
    expect(h.net().ai.calls).toHaveLength(0);
    expect(await env.DB.prepare('SELECT 1 FROM hires').first()).toBeNull();
  });

  // spec: add-pet-society › Society hire flow › player advice refused
  it('refuses before a worker call, hold or debit, and expires at exactly 24 hours', async () => {
    addPets(h);
    const until = Date.now() + 86_400_000;
    await refuse(until);
    const tk = await payerToken();
    const shown = await api(`/api/pets/${WORKER}/advice?payer=${PAYER}`, { token: tk });
    expect(shown.body.refusalUntil).toBe(new Date(until).toISOString());
    const out = await advise(tk);
    expect(out).toMatchObject({ code: 'society_refused', refusalUntil: new Date(until).toISOString() });
    expect(h.net().ai.calls).toHaveLength(0);
    expect(await env.DB.prepare('SELECT 1 FROM hires').first()).toBeNull();
    expect(await env.DB.prepare('SELECT 1 FROM thought_calls').first()).toBeNull();
    expect(await env.DB.prepare('SELECT 1 FROM worker_answers').first()).toBeNull();
    expect((await pairPrice(env, PAYER, WORKER, day(), until)).refusalUntil).toBeNull();
  });

  // spec: add-pet-society › Society hire flow › refusal expired
  it('can ask again after the exact refusal expiry with a fresh base quote', async () => {
    addPets(h);
    await refuse(Date.now() - 1);
    const tk = await payerToken();
    const shown = await api(`/api/pets/${WORKER}/advice?payer=${PAYER}`, { token: tk });
    expect(shown.body.refusalUntil).toBeUndefined();
    expect(shown.body.price.yocto).toBe(HIRE_FEE_MIN_YOCTO.toString());
    h.net().ai.push({ content: 'Try basil.' });
    expect((await advise(tk)).thought.text).toBe('Try basil.');
    expect(h.net().ai.calls).toHaveLength(1);
  });

  // spec: add-pet-society › Society hire flow › manual hire refused
  // spec: add-pet-society › Society hire flow › manual refusal reply
  it('closes a refused Manual offer and answers the original line at ordinary thought price', async () => {
    addHirer(h);
    await addWorker(h, WORKER, 2);
    await env.DB.prepare("INSERT INTO hire_modes (token_id, mode) VALUES (?, 'manual')").bind(PAYER).run();
    const tk = await payerToken();
    h.net().ai.push({ content: 'ASK 1: Can you help?' });
    expect((await say(tk, PAYER, 'Help me grow mint.')).code).toBe('offer');
    await refuse();
    h.net().ai.push({ content: 'I can try it myself.' });
    const offer = await env.DB.prepare('SELECT price_yocto FROM hire_offers').first<{ price_yocto: string }>();
    const sent = await api(`/api/pets/${PAYER}/offer/ask`, { token: tk, body: { price: offer!.price_yocto } });
    const out = await settle(tk, PAYER, sent.body.job);
    expect(out.thought.text).toBe('I can try it myself.');
    expect(h.net().ai.calls).toHaveLength(2);
    expect(await env.DB.prepare('SELECT 1 FROM hire_offers').first()).toBeNull();
    expect(await env.DB.prepare('SELECT 1 FROM hires').first()).toBeNull();
    const lines = (await env.DB.prepare('SELECT kind, reply_text, price_yocto FROM thoughts ORDER BY rowid').all<{ kind: string; reply_text: string; price_yocto: string }>()).results;
    expect(lines.map((line) => line.kind)).toEqual(['hire_question', 'hire_event', 'reply']);
    expect(lines.filter((line) => line.kind === 'hire_event')).toHaveLength(1);
    expect(lines[1]!.reply_text).toBe(`society_refused|${new Date(Date.now() + 86_400_000).toISOString()}`);
    expect(BigInt(lines[2]!.price_yocto)).toBeGreaterThan(0n);
    expect(await unbilledYocto(env.DB, PAYER)).toBe(BigInt(lines[0]!.price_yocto) + BigInt(lines[2]!.price_yocto));
    await tick(env, Date.now() + 11 * 60_000);
    const recorded = h.net().contract.debits.flatMap((debit) => debit.thoughts);
    expect(recorded.map((thought) => thought.price)).toEqual([lines[0]!.price_yocto, lines[2]!.price_yocto]);
    expect(recorded.some((thought) => thought.hire !== undefined)).toBe(false);
  });

  // spec: add-pet-society › Society hire flow › manual quote
  it('puts the liked pair fee into a Manual offer before its Ask tap', async () => {
    addHirer(h);
    await addWorker(h, WORKER, 2);
    await liked();
    await env.DB.prepare("INSERT INTO hire_modes (token_id, mode) VALUES (?, 'manual')").bind(PAYER).run();
    const tk = await payerToken();
    h.net().ai.push({ content: 'ASK 1: Can you help?' });
    expect((await say(tk, PAYER, 'Help me grow mint.')).code).toBe('offer');
    const offer = await env.DB.prepare('SELECT price_yocto FROM hire_offers').first<{ price_yocto: string }>();
    expect(offer?.price_yocto).toBe((HIRE_FEE_MIN_YOCTO * 9n / 10n).toString());
    const ownerView = await api(`/api/pets/${PAYER}`, { token: tk });
    expect(ownerView.body.offer).toMatchObject({ discounted: true, price: { yocto: offer?.price_yocto } });
    await env.DB.prepare('DELETE FROM society_relations WHERE token_id = ? AND other_id = ?').bind(PAYER, WORKER).run();
    expect((await api(`/api/pets/${PAYER}`, { token: tk })).body.offer).toMatchObject({ discounted: true, price: { yocto: offer?.price_yocto } });
    expect(h.net().ai.calls).toHaveLength(1);
  });

  // spec: add-pet-society › Society hire flow › auto paid
  it('records the discounted Auto fee in the resulting Worker job and chain debit', async () => {
    addHirer(h);
    await addWorker(h, WORKER, 2);
    await liked();
    const tk = await payerToken();
    h.net().ai.push({ content: 'ASK 1: Can you help?' }, { content: 'Try mint.' }, { content: 'Mint sounds good.' });
    const out = await say(tk, PAYER, 'Help me grow mint.');
    expect(out.thought.text).toBe('Mint sounds good.');
    const fee = HIRE_FEE_MIN_YOCTO * 9n / 10n;
    const hire = await env.DB.prepare('SELECT fee_yocto, status FROM hires').first<{ fee_yocto: string; status: string }>();
    expect(hire?.fee_yocto).toBe(fee.toString());
    await tick(env, Date.now() + 11 * 60_000);
    expect((await env.DB.prepare('SELECT status FROM hires').first<{ status: string }>())?.status).toBe('recorded');
    expect(h.net().contract.debits.flatMap((debit) => debit.thoughts).filter((thought) => thought.hire))
      .toEqual([expect.objectContaining({ hire: expect.objectContaining({ kind: 'pet', fee: fee.toString() }) })]);
    const conversation = (await api(`/api/pets/${PAYER}/conversation`, { token: tk })).body.lines;
    expect(conversation.find((line: any) => line.hire?.price)?.hire.price).toBe(fee.toString());
  });

  // spec: add-pet-society › Society hire flow › auto paid
  it('keeps the recorded Auto mode in a paid conversation after the owner switches to Manual', async () => {
    addHirer(h);
    await addWorker(h, WORKER, 2);
    const tk = await payerToken();
    h.net().ai.push({ content: 'ASK 1: Can you help?' }, { content: 'Try mint.' }, { content: 'I found an answer.' });
    await say(tk, PAYER, 'Help me grow mint.');
    await env.DB.prepare("INSERT INTO hire_modes (token_id, mode) VALUES (?, 'manual')").bind(PAYER).run();
    const lines = (await api(`/api/pets/${PAYER}/conversation`, { token: tk })).body.lines;
    expect(lines.find((line: any) => line.hire?.price)?.hire.mode).toBe('auto');
  });

  // spec: add-pet-society › Society hire flow › auto hire refused
  it('uses the own reply when a worker starts a break after Auto chose it', async () => {
    addHirer(h);
    await addWorker(h, WORKER, 2);
    const tk = await payerToken();
    h.net().ai.push({ content: 'ASK 1: Can you help?', during: async () => { await refuse(); } },
      { content: 'I will answer myself.' });
    const out = await say(tk, PAYER, 'Help me grow mint.');
    expect(out.thought.text).toBe('I will answer myself.');
    expect(h.net().ai.calls).toHaveLength(2);
    expect(await env.DB.prepare('SELECT 1 FROM hires').first()).toBeNull();
    expect(await env.DB.prepare('SELECT 1 FROM thought_calls WHERE thought_id IN (SELECT answer_thought_id FROM hires)').first()).toBeNull();
    const event = await env.DB.prepare("SELECT reply_text FROM thoughts WHERE kind = 'hire_event'").first<{ reply_text: string }>();
    expect(event?.reply_text).toBe(`society_refused|${new Date(Date.now() + 86_400_000).toISOString()}`);
    await env.DB.prepare("INSERT INTO hire_modes (token_id, mode) VALUES (?, 'manual')").bind(PAYER).run();
    const conversation = (await api(`/api/pets/${PAYER}/conversation`, { token: tk })).body.lines;
    expect(conversation.find((line: any) => line.code === 'society_refused')?.hireMode).toBe('auto');
    const prices = (await env.DB.prepare("SELECT price_yocto FROM thoughts WHERE token_id = ? AND kind IN ('hire_question', 'reply') ORDER BY rowid").bind(PAYER).all<{ price_yocto: string }>()).results;
    expect(await unbilledYocto(env.DB, PAYER)).toBe(prices.reduce((sum, row) => sum + BigInt(row.price_yocto), 0n));
    await tick(env, Date.now() + 11 * 60_000);
    const recorded = h.net().contract.debits.flatMap((debit) => debit.thoughts);
    expect(recorded.map((thought) => thought.price)).toEqual(prices.map((row) => row.price_yocto));
    expect(recorded.some((thought) => thought.hire !== undefined)).toBe(false);
  });

  // spec: add-pet-society › Society reaction data › paid call
  it('sends only bounded pair context and strips a single clear terminal reaction', async () => {
    addPets(h);
    const tk = await payerToken();
    h.net().ai.push({ content: 'Plant mint. [[society:rude]]' });
    const out = await advise(tk);
    expect(out.thought.text).toBe('Plant mint.');
    const system = h.net().ai.calls[0]!.body.messages[0]!.content;
    expect(system).toContain('current pair stance is neutral');
    expect(system).toContain('Pixel');
    expect(system).toContain('Biscuit');
    expect(system).not.toContain('near');
    expect(h.net().ai.calls).toHaveLength(1);
    expect((await env.DB.prepare('SELECT society_reaction FROM hires').first<{ society_reaction: string }>())?.society_reaction).toBe('rude');
    expect(parseReaction('hello [[society:rude]]')).toEqual({ reply: 'hello', reaction: 'rude' });
    expect(parseReaction('hello [[society:rude]] [[society:respectful]]')).toEqual({ reply: 'hello', reaction: null });
    expect(parseReaction('hello [[society:unclear]]')).toEqual({ reply: 'hello', reaction: null });
    expect(parseReaction('hello')).toEqual({ reply: 'hello', reaction: null });
  });

  // spec: add-pet-society › Society formation flow › respectful work
  it('stages no change when a paid answer has an ambiguous or absent reaction', async () => {
    addPets(h);
    const tk = await payerToken();
    h.net().ai.push({ content: 'Plant mint. [[society:rude]] [[society:respectful]]' });
    expect((await advise(tk)).thought.text).toBe('Plant mint.');
    expect((await env.DB.prepare('SELECT society_reaction FROM hires').first<{ society_reaction: string | null }>())?.society_reaction).toBeNull();
    h.net().ai.push({ content: 'Try basil.' });
    expect((await advise(tk)).thought.text).toBe('Try basil.');
    const rows = (await env.DB.prepare('SELECT society_reaction FROM hires ORDER BY created_at, rowid').all<{ society_reaction: string | null }>()).results;
    expect(rows.map((row) => row.society_reaction)).toEqual([null, null]);
  });
});
