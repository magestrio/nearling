import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { DAILY_CAP_YOCTO, minCallPrice, thoughtPrice } from '../src/pricing';
import { api, harness, settle } from './helpers/api';
import { NEAR_ACCOUNT, token } from './helpers/network';

const h = harness();
const OWNER = NEAR_ACCOUNT(1);
const S = BigInt(env.STARTER_FOOD);
const owner = () => token('did:privy:owner', OWNER);
const reserves = async () => (await env.DB.prepare('SELECT * FROM pet_spend').all<any>()).results;

/** The answered outcome first, the refused one second. */
const ordered = (outcomes: any[]) => [...outcomes].sort((a, b) => Number(b.thought !== undefined) - Number(a.thought !== undefined));

/** Sends two lines at once, from "two tabs"; returns the two job ids. */
async function twoAtOnce(tk: string) {
  const [a, b] = await Promise.all([
    api('/api/pets/5/thoughts', { token: tk, body: { text: 'from tab one', mode: 'chat' } }),
    api('/api/pets/5/thoughts', { token: tk, body: { text: 'from tab two', mode: 'chat' } }),
  ]);
  expect([a.status, b.status]).toEqual([202, 202]);
  return [a.body.job as string, b.body.job as string];
}

describe('Thought queue data', () => {
  // spec: add-pet › Thought queue data › параллельные запросы ждут очереди
  it('sends the second line to NEAR AI only after the first one is over, with one reserve at a time', async () => {
    h.net().contract.addPet('5', OWNER);
    const tk = await owner();
    h.net().ai.push({ delay: 60, tokensIn: 100, tokensOut: 30 }, { delay: 5, tokensIn: 100, tokensOut: 30 });
    const jobs = await twoAtOnce(tk);
    // while the first call is in flight there is one reserve, the second line is waiting
    for (let i = 0; i < 200 && h.net().ai.calls.length < 1; i += 1) await new Promise((r) => setTimeout(r, 2));
    expect(h.net().ai.calls).toHaveLength(1);
    expect(await reserves()).toHaveLength(1);
    const outcomes = [await settle(tk, '5', jobs[0]!), await settle(tk, '5', jobs[1]!)];
    expect(outcomes.map((o) => o.thought.text)).toEqual(['Hello there, friend.', 'Hello there, friend.']);
    expect(h.net().ai.peak).toBe(1);
    // whichever line arrived first went first, and the second request already carries that exchange
    const [one, two] = h.net().ai.calls.map((c) => c.body.messages);
    const firstLine = one!.at(-1)!.content;
    const secondLine = two!.at(-1)!.content;
    expect([firstLine, secondLine].sort()).toEqual(['from tab one', 'from tab two']);
    expect(two!.map((m) => m.content)).toContain(firstLine);
    expect(one!.map((m) => m.content)).not.toContain(secondLine);
    expect(await reserves()).toEqual([]);
  });

  // spec: add-pet › Thought queue data › параллельные запросы ждут очереди
  it('puts the pet to sleep on the first line and turns the second away asleep, without a call', async () => {
    const p1 = thoughtPrice(env, [{ tokensIn: 100, tokensOut: 30 }]);
    // after the first thought, a hair less than one scale thought is left
    h.net().contract.addPet('5', OWNER, { project_food: (p1 + S / 12n - 1n).toString() });
    const tk = await owner();
    for (let i = 0; i < 2; i += 1) h.net().ai.push({ delay: 20, tokensIn: 100, tokensOut: 30 });
    const jobs = await twoAtOnce(tk);
    // (the two requests race to the door: whichever came first is the answered one)
    const [first, second] = ordered(await Promise.all(jobs.map((j) => settle(tk, '5', j))));
    expect(first.thought.text).toBe('Hello there, friend.');
    expect(first.events).toContain('fell_asleep');
    expect(second.code).toBe('asleep');
    expect(h.net().ai.calls).toHaveLength(1);
    expect(await reserves()).toEqual([]);
  });

  // spec: add-pet › Thought queue data › параллельные запросы ждут очереди
  it('turns the second line away tired when the first one left no room under the daily cap', async () => {
    const p1 = thoughtPrice(env, [{ tokensIn: 100, tokensOut: 30 }]);
    const room = p1 + minCallPrice(env, 0) - 1n;
    h.net().contract.addPet('5', OWNER, { debited_today: (DAILY_CAP_YOCTO - room).toString() });
    const tk = await owner();
    for (let i = 0; i < 2; i += 1) h.net().ai.push({ delay: 20, tokensIn: 100, tokensOut: 30 });
    const jobs = await twoAtOnce(tk);
    const [first, second] = ordered(await Promise.all(jobs.map((j) => settle(tk, '5', j))));
    expect(first.thought.text).toBe('Hello there, friend.');
    // the cap ran out on the first thought: that is where «tired» is announced
    expect(first.events).toContain('daily_cap_reached');
    expect(second.code).toBe('tired');
    expect(h.net().ai.calls).toHaveLength(1);
    // «Устал» now holds for the owner's view
    expect((await api('/api/pets/5', { token: tk })).body.tired).toBe(true);
  });
});
