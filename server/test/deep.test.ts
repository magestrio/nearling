import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { enqueueJob } from '../src/pet/desk';
import { ceilingFor, ceilingPrice, DAILY_CAP_YOCTO, EDGE_CEILING, thoughtPrice } from '../src/pricing';
import { api, harness, learnBound, say } from './helpers/api';
import { NEAR_ACCOUNT, token } from './helpers/network';

const h = harness();
const OWNER = NEAR_ACCOUNT(1);
const owner = () => token('did:privy:owner', OWNER);

async function thoughtRow(tokenId: string) {
  return env.DB.prepare('SELECT * FROM thoughts WHERE token_id = ? ORDER BY created_at DESC LIMIT 1').bind(tokenId).first<any>();
}

describe('Deep thought flow', () => {
  // spec: add-pet › Deep thought flow › отправлено
  it('thinks with reasoning at the 3,000 ceiling, prices it exactly and shows the estimate to the owner only', async () => {
    h.net().contract.addPet('5', OWNER);
    const tk = await owner();
    const view = await api('/api/pets/5', { token: tk });
    // «≈ 0.12¢»: 2,300 in and 300 out at the rates of §4, two significant digits; the rate of NEAR does not enter
    expect(view.body.deepPrice.cents).toBe(0.12);
    const guest = await api('/api/pets/5', { token: await token('did:privy:g', NEAR_ACCOUNT(2)) });
    expect(guest.body.deepPrice).toBeUndefined();
    expect((await api('/api/pets/5')).body.deepPrice).toBeUndefined();

    h.net().ai.push({ content: '<think>hm</think>The deeper answer.', tokensOut: 380, reasoning: 351 });
    const out = await say(tk, '5', 'Why is the sky blue?', 'deep');
    const [call] = h.net().ai.calls;
    expect(call!.body.chat_template_kwargs).toEqual({ enable_thinking: true });
    expect(call!.body.max_tokens).toBe(3000);
    // the reply is what follows the last </think>
    expect(out.thought.text).toBe('The deeper answer.');
    const row = await thoughtRow('5');
    const price = thoughtPrice(env, [{ tokensIn: Math.ceil(call!.reqBytes.length / 4), tokensOut: 380 }]);
    expect(out.thought.price).toBe(price.toString());
    expect(row.price_yocto).toBe(price.toString());
    // the same price in US cents for the client's «Thought hard · {price}» (the rate it was made at, not rounded to two digits)
    const micros = await env.DB.prepare('SELECT price_usd_micros AS m FROM thoughts WHERE id = ?').bind(row.id).first<{ m: number }>();
    expect(out.thought.priceCents).toBe(micros!.m / 10_000);
    expect(out.thought.priceCents).toBeGreaterThan(0);
    const stored = await env.DB.prepare('SELECT tokens_out, tokens_reasoning FROM thought_calls WHERE thought_id = ?').bind(row.id).first<any>();
    expect(stored).toEqual({ tokens_out: 380, tokens_reasoning: 351 });
    expect(h.events().find((e) => e.name === 'thought_delivered')!.props).toEqual({ model: 'strong', for: 'owner' });
    // the food is lower by it
    const after = await api('/api/pets/5', { token: tk });
    expect(after.body.fullness.level).toBeCloseTo(Number(BigInt(env.STARTER_FOOD) - price) / Number(env.STARTER_FOOD), 6);
  });

  // spec: add-pet › Thought queue data › параллельные запросы ждут очереди
  it('tells the owner the job that is on its way, its mode and their own line, so a reloaded page shows them', async () => {
    h.net().contract.addPet('5', OWNER);
    const tk = await owner();
    expect((await api('/api/pets/5', { token: tk })).body).toMatchObject({ pendingJob: null, pendingMode: null, pendingKind: null, pendingText: null });
    const id = await enqueueJob(env.DB, '5', { kind: 'reply', mode: 'deep', text: 'Why is the sky blue?' });
    expect((await api('/api/pets/5', { token: tk })).body).toMatchObject({ pendingJob: id, pendingMode: 'deep', pendingKind: 'reply', pendingText: 'Why is the sky blue?' });
    expect((await api('/api/pets/5/state', { token: tk })).body).toMatchObject({ pendingJob: id, pendingText: 'Why is the sky blue?' });
    // a guest gets none of it
    const guest = await api('/api/pets/5', { token: await token('did:privy:other', NEAR_ACCOUNT(2)) });
    expect(guest.body).not.toHaveProperty('pendingText');
  });

  // spec: add-pet › Thought queue data › параллельные запросы ждут очереди
  it('does not make the page wait for a diary that writes itself at night', async () => {
    h.net().contract.addPet('5', OWNER);
    await enqueueJob(env.DB, '5', { kind: 'diary', day: 1 });
    expect((await api('/api/pets/5', { token: await owner() })).body).toMatchObject({ pendingJob: null, pendingKind: null });
  });

  // spec: add-pet › Deep thought flow › переспрос
  it('re-asks without reasoning when the reasoning left no reply: two calls, one receipt, one gas share', async () => {
    h.net().contract.addPet('5', OWNER);
    const tk = await owner();
    h.net().ai.push({ content: '', finish: 'length', tokensOut: 3000, reasoning: 3000 }, { content: 'Short and clear.', tokensOut: 25 });
    const out = await say(tk, '5', 'Think about this', 'deep');
    const [first, second] = h.net().ai.calls;
    expect(first!.body.chat_template_kwargs.enable_thinking).toBe(true);
    expect(second!.body.chat_template_kwargs.enable_thinking).toBe(false);
    expect(second!.body.max_tokens).toBeLessThanOrEqual(2000);
    expect(second!.body.messages).toEqual(first!.body.messages);
    expect(out.thought).toMatchObject({ text: 'Short and clear.', reasked: true });

    const row = await thoughtRow('5');
    const calls = (await env.DB.prepare('SELECT n, tokens_in, tokens_out FROM thought_calls WHERE thought_id = ? ORDER BY n').bind(row.id).all<any>()).results;
    expect(calls).toHaveLength(2);
    const both = thoughtPrice(env, calls.map((c) => ({ tokensIn: c.tokens_in, tokensOut: c.tokens_out })));
    expect(row.price_yocto).toBe(both.toString());
    expect(row.reasked).toBe(1);
    // the receipt says per call whether it stopped at its ceiling: the reasoning did, the re-ask did not
    const cuts = (await env.DB.prepare('SELECT cut FROM thought_calls WHERE thought_id = ? ORDER BY n').bind(row.id).all<{ cut: number }>()).results;
    expect(cuts).toEqual([{ cut: 1 }, { cut: 0 }]);
    // one gas share for the thought, not two: the two calls priced as two thoughts cost one share more
    const asTwo = calls.map((c) => thoughtPrice(env, [{ tokensIn: c.tokens_in, tokensOut: c.tokens_out }])).reduce((x, y) => x + y);
    const share = thoughtPrice(env, [{ tokensIn: 0, tokensOut: 0 }]);
    expect(asTwo - both).toBeGreaterThanOrEqual(share - 2n);
    expect(asTwo - both).toBeLessThanOrEqual(share + 2n);
    expect(out.thought.price).toBe(both.toString());
    expect(h.events().find((e) => e.name === 'thought_delivered')!.props).toEqual({ model: 'strong', for: 'owner', reasked: true });
  });

  // spec: add-pet › Deep thought flow › переспрос
  it('puts the re-ask to sleep the pet it ate the food of, after the whole reply', async () => {
    // food for the first call plus the re-ask only: the starter food minus a hair is still «Full», so
    // the pet is given just over 11.5 scale thoughts and the two calls take it under one.
    const S = BigInt(env.STARTER_FOOD);
    const food = (S * 23n) / 24n + 1n;
    h.net().contract.addPet('5', OWNER, { project_food: food.toString() });
    const tk = await owner();
    // the reasoning used all 3,000 and the re-ask used 2,000: together dearer than the pet's food
    h.net().ai.push({ content: '', finish: 'length', tokensOut: 3000, reasoning: 3000 }, { content: 'A reply that ended the food.', finish: 'length', tokensOut: 2000 });
    const out = await say(tk, '5', 'Think about this', 'deep');
    expect(out.thought.text).toBe('A reply that ended the food.');
    expect(out.events).toContain('fell_asleep');
    const row = await thoughtRow('5');
    expect(BigInt(row.price_yocto)).toBeLessThanOrEqual(food);
    expect((await api('/api/pets/5', { token: tk })).body.fullness.state).toBe('asleep');
  });

  // spec: add-pet › Deep thought flow › переспрос × the cap or the food near its end
  it('leaves room for the re-ask: the cap that pays the first call and exactly the re-ask is not spent by the first call', async () => {
    const bound = await learnBound(h, 'Think about this', 'deep');
    const reaskMin = ceilingPrice(env, bound, EDGE_CEILING, false);
    // the cap left covers a 500-token first call and the re-ask's cheapest call, to the yocto
    const capLeft = ceilingPrice(env, bound, 500) + reaskMin;
    // without the set-aside the first call's ceiling would be larger
    expect(ceilingFor(env, bound, capLeft, 3000)).toBeGreaterThan(500);
    h.net().contract.addPet('5', OWNER, { debited_today: (DAILY_CAP_YOCTO - capLeft).toString() });
    const tk = await owner();
    h.net().ai.push({ content: '', finish: 'length', tokensOut: 500, reasoning: 500 }, { content: 'Fits the cap.', tokensOut: 30 });
    const out = await say(tk, '5', 'Think about this', 'deep');
    const [first, second] = h.net().ai.calls;
    expect(first!.body.max_tokens).toBe(500);
    expect(second!.body.max_tokens).toBeGreaterThanOrEqual(EDGE_CEILING);
    expect(out.code).toBeUndefined();
    expect(out.thought).toMatchObject({ text: 'Fits the cap.', reasked: true });
    // the batch with the thought stays within the cap
    expect(BigInt((await thoughtRow('5')).price_yocto)).toBeLessThanOrEqual(capLeft);
  });
});
