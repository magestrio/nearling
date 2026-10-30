import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { tick } from '../src/cron';
import { ownerFields } from '../src/pet/view';
import { ceilingFor, ceilingPrice, DAILY_CAP_YOCTO, minCallPrice, thoughtPrice, typicalPrice, yoctoToUsdMicros } from '../src/pricing';
import { api, harness, learnBound, say, seedHistory } from './helpers/api';
import { NEAR_ACCOUNT, token } from './helpers/network';

const h = harness();
const OWNER = NEAR_ACCOUNT(1);
const S = BigInt(env.STARTER_FOOD);
const owner = () => token('did:privy:owner', OWNER);
const MIN = 60_000;

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
const rows = async (sql: string) => (await env.DB.prepare(sql).all<any>()).results;
const view = async (tk?: string) => (await api('/api/pets/5', tk ? { token: tk } : {})).body;
const nextDay = () => vi.setSystemTime(new Date(Math.floor(Date.now() / 86_400_000) * 86_400_000 + 86_400_000 + 30_000));
/** A pet with a memory long enough that its cheapest call is dearer than one scale thought: between the two there is the edge of sleep. */
const MEMORY = Array.from({ length: 8 }, (_, i) => `${i} ${'a long answer of the past. '.repeat(26)}`);

describe('Pet food data', () => {
  // spec: add-pet › Pet food data › мысль ещё не списана
  it('shows a lower fullness to the owner, a guest and a visitor at once after an answer, while the contract still has the food', async () => {
    h.net().contract.addPet('5', OWNER);
    const tk = await owner();
    await say(tk, '5', 'Hi');
    const price = BigInt((await rows('SELECT price_yocto FROM thoughts'))[0].price_yocto);
    const expected = Number(S - price) / Number(S);
    for (const body of [await view(tk), await view(await token('did:privy:g', NEAR_ACCOUNT(2))), await view()]) {
      expect(body.fullness.level).toBeCloseTo(expected, 6);
    }
    expect(h.net().contract.pets.get('5')!.project_food).toBe(env.STARTER_FOOD);
    // after the session is debited the contract has the lower food and the fullness is the same
    await tick(env, Date.now() + 11 * MIN);
    expect(BigInt(h.net().contract.pets.get('5')!.project_food)).toBe(S - price);
    expect((await view(tk)).fullness.level).toBeCloseTo(expected, 6);
  });

  // spec: add-pet › Pet food data › курс сменился
  it('keeps the state and the level when the rate of NEAR changes, and moves only the prices in NEAR', async () => {
    const pet = h.net().contract.addPet('5', OWNER, { project_food: ((S * 5n) / 12n).toString() });
    const at = (rate: string) => Object.assign(Object.create(env), { NEAR_USD_RATE: rate }) as Env;
    const a = await ownerFields(at('4.59'), '5', pet as never, false);
    const b = await ownerFields(at('3.0'), '5', pet as never, false);
    expect(a.fullness).toEqual(b.fullness);
    expect(a.fullness.state).toBe('hungry');
    expect(a.deepPrice.yocto).not.toBe(b.deepPrice.yocto);
    expect(BigInt(b.deepPrice.yocto)).toBeGreaterThan(BigInt(a.deepPrice.yocto));
    // the whole price is fixed in USD: the same cents at any rate
    expect(a.deepPrice.cents).toBe(b.deepPrice.cents);
    expect(typicalPrice(at('3.0'))).toBeGreaterThan(typicalPrice(at('4.59')));
  });
});

describe('Pet condition rule', () => {
  // spec: add-pet › Pet condition rule › Голоден
  it('refuses «Think hard» to a hungry pet and answers ordinary lines', async () => {
    h.net().contract.addPet('5', OWNER, { project_food: ((S * 5n) / 12n).toString() });
    const tk = await owner();
    expect((await view(tk)).fullness.state).toBe('hungry');
    const deep = await say(tk, '5', 'Think hard', 'deep');
    expect(deep.code).toBe('too_hungry');
    expect(h.net().ai.calls).toEqual([]);
    expect((await say(tk, '5', 'Hello')).thought.text).toBe('Hello there, friend.');
  });

  // spec: add-pet › Pet condition rule › Голоден × граница 11.5 мысли шкалы и одна мысль шкалы
  it('draws the line at 11.5 scale thoughts and at one, to the yocto, and reads 12 and more as a full scale', async () => {
    const pet = h.net().contract.addPet('5', OWNER);
    const tk = await owner();
    const at = async (food: bigint) => {
      pet.project_food = food.toString();
      return (await view(tk)).fullness;
    };
    const top = (23n * S) / 24n; // floor of 11.5 scale thoughts
    expect((await at(top)).state).toBe('hungry');
    expect((await at(top + 1n)).state).toBe('full');
    const one = ceilDiv(S, 12n); // a scale thought is not a whole number of yocto
    expect((await at(one)).state).toBe('hungry');
    expect((await at(one - 1n)).state).toBe('asleep');
    expect(await at(S)).toEqual({ state: 'full', level: 1 });
    expect(await at(13n * S)).toEqual({ state: 'full', level: 1 });
    expect((await at(0n)).state).toBe('asleep');
  });
});

describe('Sleep and wake flow', () => {
  // spec: add-pet › Sleep and wake flow › Засыпает
  it('cuts a long reply where the food ran out, then sleeps, with the events for both', async () => {
    h.net().contract.addPet('5', OWNER, { project_food: (S / 6n).toString() });
    const tk = await owner();
    h.net().ai.push({ finish: 'length', content: 'A very long story that goes on and on and' });
    const out = await say(tk, '5', 'Tell me a story');
    expect(out.thought).toMatchObject({ text: 'A very long story that goes on and on and', cut: 'food' });
    expect(out.thought.cut).toBe('food');
    expect(h.net().ai.calls[0]!.body.max_tokens).toBeLessThan(2000);
    expect(out.events).toContain('fell_asleep');
    expect(h.events().map((e) => e.name)).toEqual(expect.arrayContaining(['pet_fell_asleep', 'thought_delivered']));
    expect(h.events().find((e) => e.name === 'thought_delivered')!.props).toMatchObject({ cut: 'food' });
    expect((await view(tk)).fullness.state).toBe('asleep');
    expect((await env.DB.prepare('SELECT slept_at FROM pets WHERE token_id = ?').bind('5').first<any>()).slept_at).not.toBeNull();
    // asleep: the next line is turned away, no call
    expect((await say(tk, '5', 'More!')).code).toBe('asleep');
    expect(h.net().ai.calls).toHaveLength(1);
  });

  // spec: add-pet › Sleep and wake flow › Засыпает
  it('sleeps after a whole short reply when it took the last scale thought', async () => {
    h.net().contract.addPet('5', OWNER, { project_food: ((S / 12n) * 105n / 100n + 5n * 10n ** 19n).toString() });
    const tk = await owner();
    const out = await say(tk, '5', 'Hi');
    expect(out.thought.cut).toBeNull();
    expect(out.events).toContain('fell_asleep');
    expect(h.events().find((e) => e.name === 'thought_delivered')!.props).not.toHaveProperty('cut');
  });

  // spec: add-pet › Sleep and wake flow › Засыпает
  // spec: add-pet › Thought request data › еды не хватает на вызов
  it('answers briefly for all the food that is left when it does not pay even a call with a 40-token ceiling', async () => {
    const bound = await learnBound(h, 'Hi', 'chat', MEMORY);
    const min = minCallPrice(env, bound);
    h.net().contract.addPet('5', OWNER);
    await seedHistory('5', MEMORY);
    const food = min - 1n;
    expect(food * 12n).toBeGreaterThan(S);
    const pet = h.net().contract.pets.get('5')!;
    pet.project_food = food.toString();
    const tk = await owner();
    // the usage came out cheaper than the food: the price is all the food all the same
    h.net().ai.push({ tokensIn: 50, tokensOut: 5, content: 'Hi there.' });
    const out = await say(tk, '5', 'Hi');
    expect(h.net().ai.calls[0]!.body.max_tokens).toBe(40);
    expect(out.thought.text).toBe('Hi there.');
    expect(out.events).toContain('fell_asleep');
    const [row] = await rows("SELECT price_yocto FROM thoughts WHERE status = 'unbilled'");
    expect(row.price_yocto).toBe(food.toString());
    expect(await rows("SELECT * FROM project_spend WHERE kind = 'edge'")).toEqual([]);
    // the batch with it is accepted by the contract: the sum is the food, no more
    await tick(env, Date.now() + 11 * MIN);
    expect(pet.project_food).toBe('0');
    expect(h.net().contract.debits).toHaveLength(1);
    expect(h.events().map((e) => e.name)).toContain('pet_fell_asleep');
  });

  // spec: add-pet › Thought request data › еды не хватает на вызов
  it('charges the project the part of the call the food did not pay, and cuts at the ceiling', async () => {
    const bound = await learnBound(h, 'Hi', 'chat', MEMORY);
    const min = minCallPrice(env, bound);
    h.net().contract.addPet('5', OWNER);
    await seedHistory('5', MEMORY);
    const food = min - 2n * 10n ** 19n;
    h.net().contract.pets.get('5')!.project_food = food.toString();
    const tk = await owner();
    // the whole input used and the ceiling reached: the call costs `min`, the food pays `food`
    h.net().ai.push({ tokensIn: bound, tokensOut: 40, finish: 'length', content: 'Short but cut' });
    const out = await say(tk, '5', 'Hi');
    expect(out.thought.cut).toBe('food');
    const [row] = await rows("SELECT price_yocto FROM thoughts WHERE status = 'unbilled'");
    expect(row.price_yocto).toBe(food.toString());
    expect(await rows("SELECT kind, usd_micros FROM project_spend")).toEqual([{ kind: 'edge', usd_micros: yoctoToUsdMicros(min - food, Number(env.NEAR_USD_RATE)) }]);
    expect(h.events().find((e) => e.name === 'thought_delivered')!.props).toMatchObject({ cut: 'food' });
  });

  // spec: add-pet › Thought request data › еды не хватает на вызов
  it('uses the ordinary ceiling when the food pays exactly the cheapest call, and charges the usage', async () => {
    const bound = await learnBound(h, 'Hi', 'chat', MEMORY);
    const min = minCallPrice(env, bound);
    h.net().contract.addPet('5', OWNER);
    await seedHistory('5', MEMORY);
    h.net().contract.pets.get('5')!.project_food = min.toString();
    const tk = await owner();
    h.net().ai.push({ tokensIn: 100, tokensOut: 10 });
    await say(tk, '5', 'Hi');
    expect(h.net().ai.calls[0]!.body.max_tokens).toBe(ceilingFor(env, bound, min, 2000));
    const [row] = await rows("SELECT price_yocto FROM thoughts WHERE status = 'unbilled'");
    expect(row.price_yocto).toBe(thoughtPrice(env, [{ tokensIn: 100, tokensOut: 10 }]).toString());
    expect(await rows("SELECT * FROM project_spend WHERE kind = 'edge'")).toEqual([]);
  });

  // spec: add-pet › Thought request data › еды не хватает на вызов × the cap left is also below a 40-ceiling call
  it('is tired, with no call and no project spend, when the cap left is below a 40-ceiling call too', async () => {
    const bound = await learnBound(h, 'Hi', 'chat', MEMORY);
    const min = minCallPrice(env, bound);
    const pet = h.net().contract.addPet('5', OWNER, { project_food: (min - 1n).toString(), debited_today: (DAILY_CAP_YOCTO - (min - 1n)).toString() });
    await seedHistory('5', MEMORY);
    const tk = await owner();
    const out = await say(tk, '5', 'Hi');
    expect(out.code).toBe('tired');
    expect(h.net().ai.calls).toEqual([]);
    expect(await rows('SELECT * FROM project_spend')).toEqual([]);
    expect(await rows("SELECT * FROM thoughts WHERE status = 'unbilled'")).toEqual([]);
    expect(pet.project_food).toBe((min - 1n).toString());
  });
});

describe('Daily cap rule', () => {
  // spec: add-pet › Daily cap rule › Устал
  it('stops at the cap with no call, leaves the feeding alone, and speaks again after 00:00 UTC without a reload', async () => {
    const pet = h.net().contract.addPet('5', OWNER, { debited_today: (DAILY_CAP_YOCTO - 100n).toString() });
    const tk = await owner();
    const before = pet.project_food;
    const out = await say(tk, '5', 'Hello?');
    expect(out.code).toBe('tired');
    expect(out.events).toContain('daily_cap_reached');
    expect(h.net().ai.calls).toEqual([]);
    expect(h.events().map((e) => e.name)).toContain('daily_cap_reached');
    const now = await view(tk);
    expect(now.tired).toBe(true);
    expect(now.until).toBe(new Date((Math.floor(Date.now() / 86_400_000) + 1) * 86_400_000).toISOString());
    // feeding still works: the food is not touched by the refusal
    expect(pet.project_food).toBe(before);
    pet.given_food = '1000';
    expect((await view(tk)).tired).toBe(true);
    // 00:00 UTC: the contract's record is of yesterday, the owner's view is open again
    nextDay();
    const morning = await owner(); // the session of yesterday has run out with the clock
    expect((await view(morning)).tired).toBe(false);
    expect((await say(morning, '5', 'Good morning!')).thought.text).toBe('Hello there, friend.');
  });

  // spec: add-pet › Daily cap rule › Устал × the cap left can't pay a 40-ceiling call
  it('does not call below the price of a 40-token call, calls at exactly that price, and stays tired for a shorter line after a long one was refused', async () => {
    const bound = await learnBound(h, 'Hi');
    const min = minCallPrice(env, bound);
    // exactly the cheapest call: it goes, at a 40 ceiling
    h.net().contract.addPet('5', OWNER, { debited_today: (DAILY_CAP_YOCTO - min).toString() });
    const tk = await owner();
    expect((await say(tk, '5', 'Hi')).thought.text).toBe('Hello there, friend.');
    expect(h.net().ai.calls[0]!.body.max_tokens).toBe(40);

    // a yocto less: no call, no project spend
    h.net().contract.pets.get('5')!.debited_today = (DAILY_CAP_YOCTO - min + 1n).toString();
    await env.DB.exec('DELETE FROM thoughts; UPDATE pets SET tired_day = NULL');
    const refused = await say(tk, '5', 'Hi');
    expect(refused.code).toBe('tired');
    expect(h.net().ai.calls).toHaveLength(1);
    expect(await rows('SELECT * FROM project_spend')).toEqual([]);
  });

  // spec: add-pet › Daily cap rule › Устал × the cap left can't pay a 40-ceiling call
  it('keeps «tired» for a short line after a long one was refused by the cap', async () => {
    const long = 'x'.repeat(480);
    const boundLong = await learnBound(h, long);
    const room = minCallPrice(env, boundLong) - 1n;
    expect(room).toBeGreaterThan(minCallPrice(env, 0));
    h.net().contract.addPet('5', OWNER, { debited_today: (DAILY_CAP_YOCTO - room).toString() });
    const tk = await owner();
    // before the long line the field is open: the shortest call still passes
    expect((await view(tk)).tired).toBe(false);
    expect((await say(tk, '5', long)).code).toBe('tired');
    expect(h.net().ai.calls).toEqual([]);
    // the refusal holds to 00:00: the poll and a shorter line agree
    expect((await view(tk)).tired).toBe(true);
    expect((await say(tk, '5', 'Hi')).code).toBe('tired');
    expect(h.net().ai.calls).toEqual([]);
  });

  // spec: add-pet › Daily cap rule › Устал × a reply cut by the cap, then a poll
  it('cuts the reply the cap ran out on, then is tired on every poll until 00:00 and not after', async () => {
    const bound = await learnBound(h, 'Hi');
    const room = ceilingPrice(env, bound, 300);
    h.net().contract.addPet('5', OWNER, { debited_today: (DAILY_CAP_YOCTO - room).toString() });
    const tk = await owner();
    h.net().ai.push({ finish: 'length', content: 'A reply that the cap cut' });
    const out = await say(tk, '5', 'Hi');
    expect(h.net().ai.calls[0]!.body.max_tokens).toBe(300);
    expect(out.thought).toMatchObject({ text: 'A reply that the cap cut', cut: 'cap' });
    expect(out.events).toContain('daily_cap_reached');
    expect(h.events().find((e) => e.name === 'thought_delivered')!.props).toMatchObject({ cut: 'cap' });
    for (let i = 0; i < 3; i += 1) expect((await view(tk)).tired).toBe(true);
    nextDay();
    expect((await view(await owner())).tired).toBe(false);
  });
});
