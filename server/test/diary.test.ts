import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { tick } from '../src/cron';
import { harness } from './helpers/api';
import { NEAR_ACCOUNT } from './helpers/network';

const h = harness();
const S = BigInt(env.STARTER_FOOD);
const at = (h_: number, m: number) => Date.UTC(2036, 10, 4, h_, m, 0);

async function pet(id: string, opts: { asleep?: boolean; food?: bigint } = {}) {
  h.net().contract.addPet(id, NEAR_ACCOUNT(Number(id) + 1), { project_food: (opts.food ?? S).toString() });
  await env.DB.prepare('INSERT INTO pets (token_id, hatched_by, born_at, birth_tx, slept_at) VALUES (?, ?, 1, ?, ?)').bind(id, NEAR_ACCOUNT(Number(id) + 1), '', opts.asleep ? 1 : null).run();
}
const diaries = async () => (await env.DB.prepare("SELECT token_id, reply_text, price_yocto, player_text FROM thoughts WHERE kind = 'diary' ORDER BY token_id").all<any>()).results;

describe('Return after absence flow', () => {
  // spec: add-pet › Return after absence flow › дневник без игрока
  it('writes the diary of every awake pet in the first half hour of the day, from its own food, with no player', async () => {
    vi.setSystemTime(at(0, 5));
    await pet('1');
    await pet('2');
    await pet('3', { asleep: true });
    await tick(env, at(0, 5));
    const written = await diaries();
    expect(written.map((d) => d.token_id)).toEqual(['1', '2']);
    expect(written[0].player_text).toBeNull();
    expect(written[0].reply_text).toBe('Hello there, friend.');
    // the food is lower by it (not debited yet), and the sleeping pet got nothing
    const unbilled = BigInt(written[0].price_yocto);
    expect(unbilled).toBeGreaterThan(0n);
    expect(h.net().ai.calls).toHaveLength(2);
    expect(h.net().ai.calls[0]!.body.messages.at(-1)!.content).toContain('diary');
    // done for the day: the next minute asks for nothing
    await tick(env, at(0, 6));
    expect(h.net().ai.calls).toHaveLength(2);
    expect(await diaries()).toHaveLength(2);
    // the pet that is asleep in the network but not in the server's note is skipped for the day, not retried every minute
    await pet('4', { food: 0n });
    await tick(env, at(0, 7));
    await tick(env, at(0, 8));
    expect((await env.DB.prepare("SELECT diary_day FROM pets WHERE token_id = '4'").first<any>()).diary_day).not.toBeNull();
    expect(h.net().ai.calls).toHaveLength(2);
  });

  // spec: add-pet › Return after absence flow › дневник без игрока
  it('tries again every minute after a failure, and puts none after 00:30', async () => {
    vi.setSystemTime(at(0, 5));
    await pet('1');
    h.net().ai.push({ status: 500 });
    await tick(env, at(0, 5));
    expect(await diaries()).toEqual([]);
    await tick(env, at(0, 6));
    expect((await diaries()).map((d) => d.token_id)).toEqual(['1']);

    await pet('2');
    h.net().ai.push({ status: 500 }, { status: 500 });
    await tick(env, at(0, 29));
    await tick(env, at(0, 30)); // 00:30 is out of the window
    await tick(env, at(0, 31));
    expect((await diaries()).map((d) => d.token_id)).toEqual(['1']);
    expect(h.net().ai.calls).toHaveLength(3);
  });

  // spec: add-pet › Return after absence flow › дневник без игрока
  it('calls NEAR AI for at most 8 pets at once, and takes the rest on the next minutes', async () => {
    vi.setSystemTime(at(0, 1));
    for (let i = 0; i < 20; i += 1) await pet(String(i));
    for (let i = 0; i < 20; i += 1) h.net().ai.push({ delay: 15 });
    await tick(env, at(0, 1));
    expect(h.net().ai.peak).toBeLessThanOrEqual(8);
    expect(await diaries()).toHaveLength(8);
    await tick(env, at(0, 2));
    await tick(env, at(0, 3));
    expect(await diaries()).toHaveLength(20);
    expect(h.net().ai.peak).toBeLessThanOrEqual(8);
  });
});
