// The skill's data in the owner's own chat (code-first drift 2026-11-12). Bug: Max, taught `weather` with Open-Meteo, was
// asked «какая погода в киеве?» by its owner and knew nothing: the skill's sources served only others and errands.
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { thoughtPrice } from '../src/pricing';
import { harness, say } from './helpers/api';
import { connect, FakeMcp, owner, OWNER, PET, SOURCE_URL } from './helpers/sources';
import { saveSkill } from './helpers/work';

const h = harness();
const ai = () => h.net().ai;
const rows = async (sql: string, ...bind: unknown[]) => (await env.DB.prepare(sql).bind(...bind).all<any>()).results;
const ASK_DATA = { toolCalls: [{ name: 's1_events_on', arguments: '{"month": 11, "day": 3}' }], tokensIn: 900, tokensOut: 40 };

async function skilledPet(): Promise<{ tk: string; mcp: FakeMcp }> {
  h.net().contract.addPet(PET, OWNER, { name: 'Max' });
  await saveSkill('Say the temperature and what to wear.', 'weather', PET);
  const mcp = new FakeMcp(h.net().web, SOURCE_URL, {});
  const tk = await owner();
  const saved = await connect(tk, { label: 'Daybook', address: SOURCE_URL, ticks: ['events_on'] }, PET);
  if (saved.status !== 200) throw new Error(`the source did not connect: ${saved.status}`);
  mcp.requests.length = 0;
  return { tk, mcp };
}

describe('the skill in the owner\'s own chat', () => {
  it('reads the skill\'s data first, answers from it, and keeps both calls on the pet\'s one receipt', async () => {
    const { tk, mcp } = await skilledPet();
    mcp.opts.callResult = () => ({ content: [{ type: 'text', text: 'Kyiv: 3.8 C, wind 9 km/h' }] });
    ai().push(ASK_DATA, { content: 'It is chilly in Kyiv, wear a scarf.', tokensIn: 1_100, tokensOut: 30 });
    const out = await say(tk, PET, 'какая погода в киеве?');
    expect(out.thought.text).toBe('It is chilly in Kyiv, wear a scarf.');

    const [dataCall, answerCall] = ai().calls;
    expect(ai().calls).toHaveLength(2);
    expect(dataCall!.body.tool_choice).toBe('auto');
    expect((dataCall!.body.tools as any[]).map((t) => t.function.name)).toEqual(['s1_events_on']);
    expect(dataCall!.body.messages[0]!.content).toContain('Say the temperature and what to wear.');
    expect(dataCall!.body.messages[0]!.content).toContain('at most three calls');
    expect(mcp.requests.filter((r) => r.method === 'tools/call').map((r) => r.params)).toEqual([{ name: 'events_on', arguments: { month: 11, day: 3 } }]);
    // the answer: the retelling line in the system message, the data only in the owner's line, quoted
    expect(answerCall!.body.messages[0]!.content).toContain('You looked up data for this.');
    expect(answerCall!.body.messages[0]!.content).not.toContain('Kyiv: 3.8 C');
    expect(answerCall!.body.messages.at(-1)!.content).toContain('какая погода в киеве?\nThe data you looked up: ');
    expect(answerCall!.body.messages.at(-1)!.content).toContain('Kyiv: 3.8 C, wind 9 km/h');

    const [thought] = await rows("SELECT id, price_yocto, data_labels FROM thoughts WHERE token_id = ? AND kind = 'reply'", PET);
    expect(JSON.parse(thought.data_labels)).toEqual(['Daybook']);
    const calls = await rows('SELECT n, label, tokens_in, tokens_out FROM thought_calls WHERE thought_id = ? ORDER BY n', thought.id);
    expect(calls.map((c) => c.label)).toEqual(['data', null]);
    expect(BigInt(thought.price_yocto)).toBe(thoughtPrice(env, calls.map((c) => ({ tokensIn: c.tokens_in, tokensOut: c.tokens_out }))));
  });

  it('answers as before when the data call asks for no tool, and the pet does not pay for that call', async () => {
    const { tk, mcp } = await skilledPet();
    ai().push({ content: '', tokensIn: 900, tokensOut: 5 }, { content: 'Hello!', tokensIn: 800, tokensOut: 10 });
    const out = await say(tk, PET, 'hi');
    expect(out.thought.text).toBe('Hello!');
    expect(mcp.requests.filter((r) => r.method === 'tools/call')).toEqual([]);
    expect(ai().calls[1]!.body.messages.at(-1)!.content).toBe('hi');
    const [thought] = await rows("SELECT id, price_yocto, data_labels FROM thoughts WHERE token_id = ? AND kind = 'reply'", PET);
    expect(thought.data_labels).toBeNull();
    const calls = await rows('SELECT label, tokens_in, tokens_out FROM thought_calls WHERE thought_id = ?', thought.id);
    expect(calls).toEqual([{ label: null, tokens_in: 800, tokens_out: 10 }]);
    expect(await rows("SELECT * FROM project_spend WHERE kind = 'no_thought'")).toHaveLength(1);
  });

  it('makes no data call for a pet without a skill source', async () => {
    h.net().contract.addPet(PET, OWNER, { name: 'Max' });
    ai().push({ content: 'Hello!' });
    await say(await owner(), PET, 'hi');
    expect(ai().calls).toHaveLength(1);
    expect(ai().calls[0]!.body.tools).toBeUndefined();
  });
});
