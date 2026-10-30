import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { tick } from '../src/cron';
import { run } from '../src/spend';
import { callUsd12, minCallPrice, thoughtPrice, usd12ToMicros } from '../src/pricing';
import { api, harness, learnBound, say, seedHistory } from './helpers/api';
import { NEAR_ACCOUNT, token } from './helpers/network';

const h = harness();
const OWNER = NEAR_ACCOUNT(1);
const S = BigInt(env.STARTER_FOOD);
const owner = () => token('did:privy:owner', OWNER);

const spend = async () => (await env.DB.prepare('SELECT kind, usd_micros FROM project_spend ORDER BY rowid').all<{ kind: string; usd_micros: number }>()).results;
const thoughts = async (id = '5') => (await env.DB.prepare('SELECT * FROM thoughts WHERE token_id = ? ORDER BY created_at, rowid').bind(id).all<any>()).results;
const reserve = async () => env.DB.prepare('SELECT * FROM pet_spend').all();

describe('Thought request data', () => {
  // spec: add-pet › Thought request data › ответ без реплики
  it('takes `content: null` as an empty answer: counted, and the project pays what it knows of the tokens', async () => {
    h.net().contract.addPet('5', OWNER);
    const tk = await owner();
    h.net().ai.push({ content: null, tokensOut: 12 });
    expect((await say(tk, '5', 'Hello?')).code).toBe('ai_unavailable');
    expect((await env.DB.prepare('SELECT n FROM empty_answers').first<{ n: number }>())?.n).toBe(1);
    expect((await spend()).map((r) => r.kind)).toEqual(['no_thought']);
  });

  // spec: add-pet › Deep thought flow › переспрос
  it('re-asks on `content: null` at the ceiling, as on an empty string', async () => {
    h.net().contract.addPet('5', OWNER);
    h.net().ai.push({ content: null, finish: 'length', tokensOut: 3000, reasoning: 3000 }, { content: 'Short.', tokensOut: 10 });
    const out = await say(await owner(), '5', 'Think about this', 'deep');
    expect(out.thought).toMatchObject({ text: 'Short.', reasked: true });
  });

  // spec: add-pet › Deep thought flow › переспрос
  it('never shows a reasoning that was cut before its `</think>`: it is no reply', async () => {
    h.net().contract.addPet('5', OWNER);
    h.net().ai.push({ content: '<think>\nThe player asks about the sky, so I', finish: 'length', tokensOut: 3000, reasoning: 3000 }, { content: 'Because of the air.', tokensOut: 10 });
    const out = await say(await owner(), '5', 'Why is the sky blue?', 'deep');
    expect(out.thought).toMatchObject({ text: 'Because of the air.', reasked: true });
  });

  // spec: add-pet › Thought request data › ответ без реплики
  it('still refuses an answer with no id or no usage', async () => {
    h.net().contract.addPet('5', OWNER);
    h.net().ai.broken = { usage: true };
    expect((await say(await owner(), '5', 'Hello?')).code).toBe('ai_unavailable');
    expect(await env.DB.prepare('SELECT n FROM empty_answers').first()).toBeNull();
  });

  // spec: add-pet › Thought request data › ответ без реплики
  it('shows, stores and charges nothing for the first three empty answers of the day, and the project pays their tokens', async () => {
    h.net().contract.addPet('5', OWNER);
    const tk = await owner();
    for (let i = 0; i < 3; i += 1) {
      h.net().ai.push({ content: '', tokensOut: 12 });
      const out = await say(tk, '5', `line ${i}`);
      expect(out.code).toBe('ai_unavailable');
      expect(out.thought).toBeUndefined();
    }
    expect(await thoughts()).toEqual([]);
    expect((await reserve()).results).toEqual([]);
    const rows = await spend();
    expect(rows.map((r) => r.kind)).toEqual(['no_thought', 'no_thought', 'no_thought']);
    for (const [i, row] of rows.entries()) {
      const tokensIn = Math.ceil(h.net().ai.calls[i]!.reqBytes.length / 4);
      expect(row.usd_micros).toBe(usd12ToMicros(callUsd12(env, tokensIn, 12)));
    }
    // the food did not move and the player's lines are not in the conversation
    expect((await api('/api/pets/5', { token: tk })).body.fullness.level).toBe(1);
    expect((await api('/api/pets/5/conversation', { token: tk })).body.lines).toEqual([]);
  });

  // spec: add-pet › Thought request data › ответ без реплики
  it('charges the project both calls of an empty re-ask, with one gas share', async () => {
    h.net().contract.addPet('5', OWNER);
    const tk = await owner();
    h.net().ai.push({ content: '', finish: 'length', tokensOut: 3000, reasoning: 3000 }, { content: '   ', tokensOut: 4 });
    const out = await say(tk, '5', 'Think about this', 'deep');
    expect(out.code).toBe('ai_unavailable');
    const [a, b] = h.net().ai.calls.map((c) => Math.ceil(c.reqBytes.length / 4));
    const usd12 = callUsd12(env, a!, 3000) + callUsd12(env, b!, 4) - callUsd12(env, 0, 0);
    expect(await spend()).toEqual([{ kind: 'no_thought', usd_micros: usd12ToMicros(usd12) }]);
    expect(await thoughts()).toEqual([]);
  });

  // spec: add-pet › Thought request data › пустые ответы сверх трёх
  it('makes the pet pay the fourth empty answer of the day, counting the answers of its workers, and keeps the bytes', async () => {
    h.net().contract.addPet('5', OWNER);
    const tk = await owner();
    h.net().ai.push({ content: '', tokensOut: 12 }, { content: '', tokensOut: 12 }, { content: '', tokensOut: 12 }, { content: '', tokensOut: 12 });
    expect((await say(tk, '5', 'one')).code).toBe('ai_unavailable');
    expect((await say(tk, '5', 'two')).code).toBe('ai_unavailable');
    // an answer of a worker the pet pays goes through the same queue and the same counter
    const worker = await run(env, '5', { kind: 'diary', day: 1 });
    expect(worker).toEqual({ code: 'ai_unavailable' });
    expect(await thoughts()).toEqual([]);

    const fourth = await say(tk, '5', 'four');
    expect(fourth.code).toBe('empty_paid');
    const [row] = await thoughts();
    expect(row).toMatchObject({ reply_text: null, player_text: null, status: 'unbilled', payer: 'pet' });
    const [call] = (await env.DB.prepare('SELECT * FROM thought_calls WHERE thought_id = ?').bind(row.id).all<any>()).results;
    expect(call.tokens_out).toBe(12);
    expect(call.res_bytes.length).toBeGreaterThan(0);
    expect(row.price_yocto).toBe(thoughtPrice(env, [{ tokensIn: call.tokens_in, tokensOut: 12 }]).toString());
    // the project paid only the three
    expect((await spend()).map((r) => r.kind)).toEqual(['no_thought', 'no_thought', 'no_thought']);
    // the pet's food is lower, and the conversation shows nothing of it
    const view = await api('/api/pets/5', { token: tk });
    expect(view.body.fullness.level).toBeLessThan(1);
    expect((await api('/api/pets/5/conversation', { token: tk })).body.lines).toEqual([]);
  });

  // spec: add-pet › Thought request data › пустые ответы сверх трёх × the fourth empty answer of the day
  it('is asleep after a fourth empty answer that ate the last of the food', async () => {
    h.net().contract.addPet('5', OWNER);
    const tk = await owner();
    for (let i = 0; i < 4; i += 1) h.net().ai.push({ content: '', tokensOut: 12 });
    for (let i = 0; i < 3; i += 1) await say(tk, '5', `line ${i}`);
    // 1.2 scale thoughts left: the fourth takes more than that
    h.net().contract.pets.get('5')!.project_food = ((S / 12n) * 12n) / 10n + '';
    const out = await say(tk, '5', 'last');
    expect(out.code).toBe('empty_paid');
    expect(out.events).toContain('fell_asleep');
    expect((await api('/api/pets/5', { token: tk })).body.fullness.state).toBe('asleep');
  });

  // spec: add-pet › Thought request data › еды не хватает на вызов × the fourth empty answer of the day
  it('charges the fourth empty answer at the edge of sleep all the food that is left, not the usage', async () => {
    // a pet with a memory: its cheapest call costs more than one scale thought, so there is an edge
    const memory = Array.from({ length: 8 }, (_, i) => `${i} ${'a long answer of the past. '.repeat(26)}`);
    const bound = await learnBound(h, 'last', 'chat', memory);
    const min = minCallPrice(env, bound);
    h.net().contract.addPet('5', OWNER);
    await seedHistory('5', memory);
    const tk = await owner();
    for (let i = 0; i < 3; i += 1) {
      h.net().ai.push({ content: '', tokensOut: 5 });
      await say(tk, '5', `line ${i}`);
    }
    // one ordinary thought of the session first, then the food a yocto short of the cheapest call
    // (above one scale thought) on top of what that thought took
    h.net().ai.push({ tokensIn: 100, tokensOut: 10 });
    await say(tk, '5', 'ordinary');
    const ordinary = BigInt((await thoughts()).find((r) => r.status === 'unbilled')!.price_yocto);
    const food = min - 1n;
    expect(food * 12n).toBeGreaterThan(S);
    const pet = h.net().contract.pets.get('5')!;
    pet.project_food = (ordinary + food).toString();
    h.net().ai.push({ content: '', tokensOut: 5 });
    const out = await say(tk, '5', 'last');
    expect(out.code).toBe('empty_paid');
    expect(h.net().ai.calls.at(-1)!.body.max_tokens).toBe(40);
    const rows = (await thoughts()).filter((r) => r.status === 'unbilled');
    expect(rows).toHaveLength(2);
    expect(rows[1].price_yocto).toBe(food.toString());
    expect(out.events).toContain('fell_asleep');
    // the batch with both is accepted under the rule «the sum is not above the food»
    await tick(env, Date.now() + 11 * 60_000);
    expect(h.net().contract.debits.map((d) => d.thoughts.length)).toEqual([2]);
    expect(pet.project_food).toBe('0');
  });
});

describe('Connection rule', () => {
  // spec: add-pet › Connection rule › AI-провайдер недоступен
  it('spends nothing of the pet when the answer does not come in time, and the project pays the ceiling', async () => {
    h.net().contract.addPet('5', OWNER);
    const tk = await owner();
    h.net().ai.push({ hang: true });
    const out = await say(tk, '5', 'Hello?');
    expect(out.code).toBe('ai_unavailable');
    expect(await thoughts()).toEqual([]);
    expect((await reserve()).results).toEqual([]);
    expect((await spend()).map((r) => r.kind)).toEqual(['no_thought']);
    expect((await api('/api/pets/5', { token: tk })).body.fullness.level).toBe(1);
    expect(h.logs()).toContain('ai_timeout');
  });

  // spec: add-pet › Connection rule › AI-провайдер недоступен
  it('is unavailable on a rate limit of NEAR AI without a pause and without a project spend', async () => {
    h.net().contract.addPet('5', OWNER);
    const tk = await owner();
    h.net().ai.push({ status: 429 });
    expect((await say(tk, '5', 'Hello?')).code).toBe('ai_unavailable');
    expect(await spend()).toEqual([]);
    expect((await env.DB.prepare('SELECT * FROM service_pause').all()).results).toEqual([]);
    // the player's line was not taken: a retry sends it again and the pet answers
    expect((await say(tk, '5', 'Hello?')).thought.text).toBe('Hello there, friend.');
  });

  // spec: add-pet › Connection rule › пустой ответ за счёт питомца
  it('lowers the food by the price of the call and puts the pet to sleep when that was the last of it', async () => {
    h.net().contract.addPet('5', OWNER);
    const tk = await owner();
    for (let i = 0; i < 3; i += 1) {
      h.net().ai.push({ content: '', tokensOut: 5 });
      await say(tk, '5', `line ${i}`);
    }
    h.net().ai.push({ content: '', tokensOut: 5 });
    const before = (await api('/api/pets/5', { token: tk })).body.fullness.level;
    const out = await say(tk, '5', 'paid');
    expect(out.code).toBe('empty_paid');
    const [row] = await thoughts();
    const after = (await api('/api/pets/5', { token: tk })).body.fullness.level;
    expect(after).toBeCloseTo(before - Number(row.price_yocto) / Number(S), 6);
    expect(out.events ?? []).not.toContain('fell_asleep');
  });
});
