import { env } from 'cloudflare:workers';
import { runDurableObjectAlarm } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { thoughtPrice } from '../src/pricing';
import { api, harness, say } from './helpers/api';
import { NEAR_ACCOUNT, token } from './helpers/network';

const h = harness();
const PLAYER = NEAR_ACCOUNT(10);
const S = BigInt(env.STARTER_FOOD);

/** The player hatches a pet; the desk's alarm then runs what the birth queued, with no request from the client. */
async function born(): Promise<{ tk: string; id: string }> {
  const tk = await token('did:privy:player', PLAYER);
  const res = await api('/api/hatch', { token: tk, body: { name: 'Pixel' } });
  expect(res.status).toBe(200);
  return { tk, id: res.body.tokenId };
}
const alarm = async (id: string) => runDurableObjectAlarm(env.PET_DESK.get(env.PET_DESK.idFromName(id)));

describe('First thought flow', () => {
  // spec: add-pet › First thought flow › Приветствие
  it('greets by itself after the birth, from the starter food, and a second ask does not make a second greeting', async () => {
    const { tk, id } = await born();
    // nothing went to NEAR AI at the birth: the job waits for the desk's alarm
    expect(h.net().ai.calls).toEqual([]);
    expect(await alarm(id)).toBe(true);

    const greetings = await env.DB.prepare("SELECT * FROM thoughts WHERE token_id = ? AND kind = 'greeting'").bind(id).all<any>();
    expect(greetings.results).toHaveLength(1);
    expect(greetings.results[0].reply_text).toBe('Hello there, friend.');
    expect(greetings.results[0].player_text).toBeNull();
    expect(h.events().filter((e) => e.name === 'thought_delivered')).toEqual([{ name: 'thought_delivered', props: { model: 'cheap', for: 'owner' } }]);
    // the greeting is cheaper than the starter food, which is the project's
    expect(h.net().ai.calls[0]!.body.messages.at(-1)!.content).toContain('Say hello');
    // the empty Pet screen asks again: no second greeting, no second call
    const again = await api(`/api/pets/${id}/greeting`, { token: tk, body: {} });
    expect(again.status).toBe(202);
    await alarm(id);
    expect(h.net().ai.calls).toHaveLength(1);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM thoughts WHERE token_id = ? AND kind = 'greeting'").bind(id).first<{ n: number }>())!.n).toBe(1);
    // and it is the owner's first line that makes «Say hi to…» into «Talk to…»
    expect((await api(`/api/pets/${id}`, { token: tk })).body.hello).toBe(true);
    await say(tk, id, 'Hi Pixel!');
    expect((await api(`/api/pets/${id}`, { token: tk })).body.hello).toBe(false);
  });

  // spec: add-pet › First thought flow › Приветствие × сытость новорождённого после приветствия
  it('is «Full» 8 of 8 before the greeting and «Hungry» after a typical one, with «Think hard» refused', async () => {
    const { tk, id } = await born();
    const before = await api(`/api/pets/${id}`, { token: tk });
    expect(before.body.fullness).toEqual({ state: 'full', level: 1 });
    // a typical thought of §4: 2,300 tokens in, 30 out
    h.net().ai.push({ tokensIn: 2300, tokensOut: 30 });
    await alarm(id);
    const price = thoughtPrice(env, [{ tokensIn: 2300, tokensOut: 30 }]);
    const after = await api(`/api/pets/${id}`, { token: tk });
    expect(after.body.fullness.state).toBe('hungry');
    expect(after.body.fullness.level).toBeCloseTo(Number(S - price) / Number(S), 6);
    // 11 scale thoughts, not 12: the cells are 7 of 8 (DS Fullness), the number is the server's level
    expect(after.body.fullness.level).toBeGreaterThan(10.5 / 12);
    expect(after.body.fullness.level).toBeLessThan(11.5 / 12);
    const deep = await say(tk, id, 'Think hard about it', 'deep');
    expect(deep.code).toBe('too_hungry');
    expect(h.net().ai.calls).toHaveLength(1);
    // an ordinary line still works
    expect((await say(tk, id, 'Hi!')).thought.text).toBe('Hello there, friend.');
  });
});
