import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { errandPrice, SEARCH_IN, SEARCH_OUT_BOUND, upToFor } from '../src/errands/price';
import { costUsd12, usd12ToMicros } from '../src/pricing';
import { SEARCH_INSTRUCTION } from '../src/errands/search';
import { harness, seedHistory } from './helpers/api';
import { callsOf, conversation, errand, errandRow, foodForSearches, owner, PET, richPet, spendKinds, stateOf, thoughtsOf } from './helpers/errands';
import { saveSkill } from './helpers/work';

const h = harness();
const JOB = 'When is the Leonids meteor shower?';
const CLAIM = 'Octopuses have three hearts.';
const hash = async (bytes: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
/** The errand's thought (a seeded memory or a diary may stand before it). */
const errandThoughts = async () => (await thoughtsOf()).filter((t) => t.kind === 'errand');
const bytesOf = (blob: unknown) => new Uint8Array(blob as ArrayLike<number>);

describe('Errand request data', () => {
  // spec: add-pet-errands › Errand request data › a search errand
  // spec: add-pet-errands › Errand request data › a pet with a skill
  it('sends the job\'s text and one fixed server instruction, the same for every pet, to the search call', async () => {
    richPet(h);
    const tk = await owner();
    await saveSkill('Answer like a pirate.', 'pirate', PET);
    await seedHistory(PET, ['I remember your cat Miso.']);
    h.net().ai.push({ stream: { searches: 1 } }, { content: 'The shower peaks in November [1].' });
    const out = await errand(tk, 'find', JOB);
    expect(out.thought).toBeDefined();

    const [search, report] = h.net().ai.calls;
    // the fixed instruction (a system message) and the job as the user's; the tool is offered, never forced; the usage comes with the stream
    expect(search!.body).toEqual({
      model: env.MODEL_ID,
      messages: [
        { role: 'system', content: 'Search the web for the question or claim the user gives you, then answer in one short sentence.' },
        { role: 'user', content: JOB },
      ],
      max_tokens: 100,
      stream: true,
      chat_template_kwargs: { enable_thinking: false },
      tools: [{ type: 'web_context_search' }],
      tool_choice: 'auto',
      stream_options: { include_usage: true },
    });
    expect(search!.headers).toMatchObject({ 'x-no-aliasing': 'true', 'accept-encoding': 'identity' });
    // not the pet's name, character, skill or memory: the provider that searches gets queries built from the job only
    expect(new TextDecoder().decode(search!.reqBytes)).not.toMatch(/Pixel|test character|pirate|Miso/);
    // the report call is not streamed, carries the pet's layers and skill and the job and results as data
    expect(report!.body.stream).toBe(false);
    const system = report!.body.messages[0]!.content;
    const user = report!.body.messages.at(-1)!.content;
    expect(system).toContain('Pixel');
    expect(system).toContain('Answer like a pirate.');
    expect(system).not.toContain('Title 1.1');
    expect(user).toContain(JSON.stringify(JOB));
    expect(user).toContain('Title 1.1');
    expect(JSON.stringify(report!.body)).not.toMatch(/Miso/);
    // a skilled pet's report: the one-time value, no request bytes, only the hash; the search call's bytes are kept
    expect(report!.body.nonce).toMatch(/^[0-9a-f]{32}$/);
    const [thought] = await errandThoughts();
    const calls = await callsOf(thought.id);
    expect(calls.map((c: any) => c.label)).toEqual(['search', 'report']);
    expect(Array.from(bytesOf(calls[1].req_bytes))).toEqual([]);
    expect(calls[1].req_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(bytesOf(calls[0].req_bytes).length).toBeGreaterThan(0);
    // nothing named a search provider: the Worker called NEAR AI only
    expect(h.net().fetched.filter((u) => /brave/i.test(u))).toEqual([]);
  });

  // spec: add-pet-errands › Errand request data › a search errand
  it('keeps the report\'s request bytes of a pet with no skill and sends it no one-time value', async () => {
    richPet(h);
    const tk = await owner();
    h.net().ai.push({ stream: { searches: 1 } }, { content: 'Done [1].' });
    await errand(tk, 'find', JOB);
    const [thought] = await errandThoughts();
    const calls = await callsOf(thought.id);
    // no skill: the report's bytes are kept like any call's, and no one-time value is sent
    expect(bytesOf(calls[1].req_bytes).length).toBeGreaterThan(0);
    expect(h.net().ai.calls[1]!.body.nonce).toBeUndefined();
    // the search call's instruction is the same for a pet with a skill and one without
    expect(h.net().ai.calls[0]!.body.messages).toEqual([
      { role: 'system', content: SEARCH_INSTRUCTION },
      { role: 'user', content: JOB },
    ]);
  });
});

describe('Find out flow', () => {
  // spec: add-pet-errands › Errand flow › report
  it('reports what the searches found: cited sources by host, the exact price, two receipts', async () => {
    richPet(h);
    const tk = await owner();
    // 2 searches × 3 results: [1]–[3] from the first, [4]–[6] from the second
    h.net().ai.push({ stream: { searches: 2 }, tokensIn: 13_000, tokensOut: 60 }, { content: 'It peaks in mid-November [1] and the moon is thin [4][5].', tokensIn: 900, tokensOut: 140 });
    const out = await errand(tk, 'find', JOB);
    expect(out.errand).toBeNull();
    const [thought] = await errandThoughts();
    expect(thought).toMatchObject({ kind: 'errand', form: 'find', status: 'unbilled', searches: 2, verdict: null, payer: 'pet', recall: 0, player_text: JOB });
    // the markers are read and stripped, the host has no www.
    expect(thought.reply_text).toBe('It peaks in mid-November and the moon is thin.');
    expect(JSON.parse(thought.sources)).toEqual([
      { label: 'site11.example.com', url: 'https://www.site11.example.com/page' },
      { label: 'site21.example.com', url: 'https://www.site21.example.com/page' },
      { label: 'site22.example.com', url: 'https://www.site22.example.com/page' },
    ]);
    // priced by usage: both calls' tokens and each search that ran, × 1.2, one gas share
    expect(BigInt(thought.price_yocto)).toBe(errandPrice(env, [{ tokensIn: 13_000, tokensOut: 60 }, { tokensIn: 900, tokensOut: 140 }], 2));
    // the receipt: the search call signed by the gateway, then the report signed by the model
    const calls = await callsOf(thought.id);
    expect(calls.map((c: any) => [c.label, c.sig_kind, c.cut])).toEqual([['search', 'gateway', 0], ['report', 'provider_tee', 0]]);
    expect(calls[0]).toMatchObject({ tokens_in: 13_000, tokens_out: 60 });
    const hashes = h.net().ai.hashes(calls[0].completion_id)!;
    expect(calls[0].req_sha256).toBe(hashes.req);
    expect(calls[0].res_sha256).toBe(hashes.res);
    expect(await hash(bytesOf(calls[0].res_bytes))).toBe(calls[0].res_sha256);
    // the conversation: the job under «You», the report with its sources, searches and exact price
    const lines = (await conversation(tk)).lines;
    expect(lines.map((l: any) => l.who)).toEqual(['player', 'pet']);
    expect(lines[0]).toMatchObject({ kicker: 'find', text: JOB });
    expect(lines[1].report).toMatchObject({ form: 'find', searches: 2, verdict: null, missed: [] });
    expect(lines[1].report.sources.map((s: any) => s.label)).toEqual(['site11.example.com', 'site21.example.com', 'site22.example.com']);
    expect(lines[1].report.priceCents).toBe(Number((thought.price_usd_micros / 10_000).toPrecision(2)));
    // the pet is back: one errand at a time frees, the day counted, a step of energy taken
    expect(await errandRow()).toMatchObject({ state: 'done', thought_id: thought.id, job: null, searches_ran: 2 });
    expect(await env.DB.prepare('SELECT 1 FROM pet_spend').first()).toBeNull();
    expect((await env.DB.prepare('SELECT energy_used FROM pet_life WHERE token_id = ?').bind(PET).first<{ energy_used: number }>())?.energy_used).toBe(1);
  });

  // spec: add-pet-errands › Errand flow › report
  it('cites at most five sources, one for a host', async () => {
    richPet(h);
    const tk = await owner();
    const output = Array.from({ length: 8 }, (_, k) => `[${k + 1}] Title ${k + 1}\nhttps://${k < 2 ? 'same.example.org' : `h${k}.example.org`}/p${k}\nText ${k + 1}`).join('\n\n');
    h.net().ai.push({ stream: { searches: 1, outputs: [output] } }, { content: 'See [1] [2] [3] [4] [5] [6] [7] [8] and [99].' });
    await errand(tk, 'find', JOB);
    const [thought] = await errandThoughts();
    expect(JSON.parse(thought.sources).map((s: any) => s.label)).toEqual(['same.example.org', 'h2.example.org', 'h3.example.org', 'h4.example.org', 'h5.example.org']);
  });

  // spec: add-pet-errands › Find out flow › nothing found
  it('says nothing solid when the report cites no result: no sources, still a priced report', async () => {
    richPet(h);
    const tk = await owner();
    h.net().ai.push({ stream: { searches: 2 } }, { content: 'I looked, but nothing here settles it.' });
    await errand(tk, 'find', JOB);
    const [thought] = await errandThoughts();
    expect(JSON.parse(thought.sources)).toEqual([]);
    expect(thought).toMatchObject({ searches: 2, reply_text: 'I looked, but nothing here settles it.' });
    const lines = (await conversation(tk)).lines;
    expect(lines[1].report).toMatchObject({ searches: 2, sources: [] });
    expect(h.events().find((e) => e.name === 'errand_reported')!.props).toMatchObject({ form: 'find', searches: 2, sources: 0 });
  });
});

describe('Is it true flow', () => {
  const claim = async (verdictLine: string, cites: string) => {
    richPet(h);
    const tk = await owner();
    h.net().ai.push({ stream: { searches: 2 } }, { content: `${verdictLine}${verdictLine === '' ? '' : '\n'}Octopuses really have three hearts ${cites}.` });
    await errand(tk, 'check', CLAIM);
    const [thought] = await errandThoughts();
    return { thought, tk };
  };

  // spec: add-pet-errands › Is it true flow › verdict
  it('adds a verdict of True or False when the sources settle the claim, and strips the marker', async () => {
    const t = await claim('VERDICT: TRUE', '[2][4]');
    expect(t.thought).toMatchObject({ form: 'check', verdict: 'true', reply_text: 'Octopuses really have three hearts.' });
    expect(JSON.parse(t.thought.sources).map((s: any) => s.label)).toEqual(['site12.example.com', 'site21.example.com']);
    expect((await conversation(t.tk)).lines[1].report).toMatchObject({ form: 'check', verdict: 'true', searches: 2 });
  });

  // spec: add-pet-errands › Is it true flow › verdict
  it('reads False the same way', async () => {
    const t = await claim('VERDICT: FALSE', '[1]');
    expect(t.thought.verdict).toBe('false');
    expect(t.thought.reply_text).not.toMatch(/VERDICT/i);
  });

  // spec: add-pet-errands › Is it true flow › unclear
  it('is unclear when the pet says so, when the marker is missing, and when no source is cited', async () => {
    expect((await claim('VERDICT: UNCLEAR', '[1]')).thought.verdict).toBe('unclear');
  });

  // spec: add-pet-errands › Is it true flow › unclear
  it('is unclear without a marker', async () => {
    expect((await claim('', '[1]')).thought.verdict).toBe('unclear');
  });

  // spec: add-pet-errands › Is it true flow › unclear
  it('is always unclear when the report cites no source, whatever it says', async () => {
    const t = await claim('VERDICT: TRUE', '');
    expect(t.thought).toMatchObject({ verdict: 'unclear' });
    expect(JSON.parse(t.thought.sources)).toEqual([]);
  });
});

describe('Errand price data', () => {
  // spec: add-pet-errands › Errand price data › a search past the allowance
  it('cuts the search call at a search the food does not pay: unsigned, no tokens, marked cut, nothing of it in the report', async () => {
    foodForSearches(h, 1);
    const tk = await owner();
    h.net().ai.push({ stream: { searches: 2 } }, { content: 'One result says so [1].', tokensIn: 700, tokensOut: 80 });
    await errand(tk, 'find', JOB);
    // the Worker hung up on the stream before it ended
    const record = h.net().ai.streams[0]!;
    expect(record.cancelled).toBe(true);
    expect(record.delivered).toBeLessThan(record.total);
    // the report holds the first search's results and none of the cut search's
    const user = h.net().ai.calls[1]!.body.messages.at(-1)!.content;
    expect(user).toContain('Title 1.1');
    expect(user).not.toContain('Title 2.1');
    const [thought] = await errandThoughts();
    const calls = await callsOf(thought.id);
    expect(calls[0]).toMatchObject({ label: 'search', signature: '', sig_kind: 'gateway', signer: '', tokens_in: 0, tokens_out: 0, cut: 1 });
    // its hashes are of the bytes received, kept like any call's
    expect(await hash(bytesOf(calls[0].res_bytes))).toBe(calls[0].res_sha256);
    expect(calls[0].req_sha256).toBe(await hash(h.net().ai.calls[0]!.reqBytes));
    expect(h.net().ai.signatureRequests).toHaveLength(1);
    // the pet pays the one search that ran and the report, not the cut call
    expect(thought.searches).toBe(1);
    expect(BigInt(thought.price_yocto)).toBe(errandPrice(env, [{ tokensIn: 700, tokensOut: 80 }], 1));
    // the project pays the cut call (an upper bound) and the events say so
    expect((await spendKinds()).map((k) => k.kind)).toEqual(['errand_cut']);
    expect(h.events().find((e) => e.name === 'errand_reported')!.props).toMatchObject({ cut: true, searches: 1 });
    expect((h.events().find((e) => e.name === 'errand_reported')!.props.project_usd as number)).toBeGreaterThan(0);
    const reported = h.events().find((e) => e.name === 'thought_delivered')!.props;
    expect(reported.price_usd as number).toBeGreaterThan(0);
    expect(h.logs().join('\n')).toContain('search_over:2');
  });

  // spec: add-pet-errands › Errand price data › a search past the allowance
  it('lets a stream of exactly the allowance finish and be signed', async () => {
    foodForSearches(h, 2);
    const tk = await owner();
    h.net().ai.push({ stream: { searches: 2 } }, { content: 'Two sites agree [1][4].' });
    await errand(tk, 'find', JOB);
    expect(h.net().ai.streams[0]!.cancelled).toBe(false);
    const [thought] = await errandThoughts();
    expect((await callsOf(thought.id))[0]).toMatchObject({ signature: expect.stringMatching(/^0xsig-/), cut: 0 });
    expect(await spendKinds()).toEqual([]);
  });

  // spec: add-pet-errands › Errand price data › a search past the allowance
  it('ends as an unreachable search, nothing spent, when the cut comes before any result came back', async () => {
    foodForSearches(h, 1);
    const tk = await owner();
    // two searches start at once: the second shows before the first has a result
    h.net().ai.push({ stream: { parallel: 2 } });
    const out = await errand(tk, 'find', JOB);
    expect(out.code).toBe('errand_failed');
    expect(h.net().ai.streams[0]!.cancelled).toBe(true);
    expect((await stateOf(tk)).errand).toEqual({ state: 'failed', form: 'find', job: JOB, reason: 'search_down', cause: 'unreachable' });
    expect(await errandThoughts()).toEqual([]);
    expect((await spendKinds()).map((k) => k.kind)).toEqual(['errand_cut']);
    expect(h.events().find((e) => e.name === 'errand_failed')!.props).toMatchObject({ reason: 'search_down', cause: 'unreachable', searches: 0, price_usd: 0, cut: true });
  });

  // spec: add-pet-errands › Errand price data › no search ran
  it('sends the same search call once more, unseen, when the first ran no search; the first call\'s tokens are the project\'s', async () => {
    richPet(h);
    const tk = await owner();
    h.net().ai.push({ stream: { searches: 0 }, tokensIn: 200, tokensOut: 30 }, { stream: { searches: 1 } }, { content: 'Found [1].' });
    const out = await errand(tk, 'find', JOB);
    expect(out.thought).toBeDefined();
    const [first, second] = h.net().ai.calls;
    expect(first!.body.stream).toBe(true);
    expect(Array.from(second!.reqBytes)).toEqual(Array.from(first!.reqBytes));
    // the receipt holds the call that searched, then the report; the first call is nowhere on it
    const [thought] = await errandThoughts();
    expect((await callsOf(thought.id)).map((c: any) => c.label)).toEqual(['search', 'report']);
    expect(thought.searches).toBe(1);
    const kinds = await spendKinds();
    expect(kinds.map((k) => k.kind)).toEqual(['errand_no_search']);
    expect(kinds[0]!.usd_micros).toBeGreaterThan(0);
    expect(h.events().find((e) => e.name === 'errand_reported')!.props.project_usd as number).toBeGreaterThan(0);
    // not one of the three: no empty answer counted
    expect(await env.DB.prepare('SELECT 1 FROM empty_answers').first()).toBeNull();
  });

  // spec: add-pet-errands › Errand price data › no search ran twice
  it('counts a search call that ran no search twice as one of the three failed calls: nothing spent, search_down', async () => {
    richPet(h);
    const tk = await owner();
    h.net().ai.push({ stream: { searches: 0 }, tokensIn: 200, tokensOut: 30 }, { stream: { searches: 0 }, tokensIn: 210, tokensOut: 25 });
    const out = await errand(tk, 'find', JOB);
    expect(out.code).toBe('errand_failed');
    expect((await stateOf(tk)).errand).toEqual({ state: 'failed', form: 'find', job: JOB, reason: 'search_down', cause: 'no_search' });
    expect(await thoughtsOf()).toEqual([]);
    expect(await env.DB.prepare('SELECT 1 FROM pet_spend').first()).toBeNull();
    // both calls' tokens are the project's, once
    const kinds = await spendKinds();
    expect(kinds.map((k) => k.kind)).toEqual(['errand_no_search']);
    expect((await env.DB.prepare('SELECT n FROM empty_answers WHERE token_id = ?').bind(PET).first<{ n: number }>())?.n).toBe(1);
    expect(h.net().ai.signatureRequests).toEqual([]);
    expect(h.events().find((e) => e.name === 'errand_failed')!.props).toMatchObject({ form: 'find', reason: 'search_down', cause: 'no_search', searches: 0, price_usd: 0, cost_usd: 0 });
    expect(h.events().find((e) => e.name === 'errand_failed')!.props.project_usd as number).toBeGreaterThan(0);
  });

  // spec: add-pet-errands › Find out flow › web search down
  it('is web search down, nothing spent, when NEAR AI cannot be reached', async () => {
    richPet(h);
    const tk = await owner();
    const before = (await stateOf(tk)).fullness.level;
    h.net().ai.push({ status: 503 });
    const out = await errand(tk, 'find', JOB);
    expect(out.code).toBe('errand_failed');
    expect((await stateOf(tk)).errand).toEqual({ state: 'failed', form: 'find', job: JOB, reason: 'search_down', cause: 'unreachable' });
    expect(await thoughtsOf()).toEqual([]);
    expect((await stateOf(tk)).fullness.level).toBe(before);
    expect(await spendKinds()).toEqual([]);
    expect(await env.DB.prepare('SELECT 1 FROM pet_spend').first()).toBeNull();
    expect(h.events().find((e) => e.name === 'errand_failed')!.props).toMatchObject({ reason: 'search_down', cause: 'unreachable', searches: 0, price_usd: 0 });
  });

  // spec: add-pet-errands › Find out flow › web search down
  it('is web search down when the stream ends without its usage, or the call never answers', async () => {
    richPet(h);
    const tk = await owner();
    h.net().ai.push({ stream: { searches: 1, noUsage: true } });
    expect((await errand(tk, 'find', JOB)).code).toBe('errand_failed');
    expect((await stateOf(tk)).errand).toMatchObject({ reason: 'search_down', cause: 'unreachable' });
    expect(await thoughtsOf()).toEqual([]);
    h.net().ai.push({ hang: true });
    await errand(tk, 'find', JOB);
    expect((await stateOf(tk)).errand).toMatchObject({ reason: 'search_down', cause: 'unreachable' });
    expect(await thoughtsOf()).toEqual([]);
  });

  // spec: add-pet-errands › Errand price data › report failed after searches
  it('records the search fee as project spend when the stream breaks after a search ran', async () => {
    richPet(h);
    const tk = await owner();
    h.net().ai.push({ stream: { searches: 1, breakAfter: 5 } });
    expect((await errand(tk, 'find', JOB)).code).toBe('errand_failed');
    const fee = BigInt(Math.round(Number(env.SEARCH_USD_PER_CALL) * 1e12));
    expect(await spendKinds()).toEqual([{ kind: 'no_thought', usd_micros: usd12ToMicros(costUsd12(env, SEARCH_IN[0], SEARCH_OUT_BOUND) + fee) }]);
  });

  // spec: add-pet-errands › Errand price data › report failed after searches
  it('does not count a search id as a fee before its result arrives', async () => {
    richPet(h);
    const tk = await owner();
    h.net().ai.push({ stream: { searches: 1, breakAfter: 2 } });
    expect((await errand(tk, 'find', JOB)).code).toBe('errand_failed');
    expect(await spendKinds()).toEqual([{ kind: 'no_thought', usd_micros: usd12ToMicros(costUsd12(env, SEARCH_IN[0], SEARCH_OUT_BOUND)) }]);
  });

  // spec: add-pet-errands › Find out flow › web search down
  it('pauses the services on a spent key: the errand is blocked and kept, nothing is spent', async () => {
    richPet(h);
    const tk = await owner();
    h.net().ai.push({ status: 402 });
    await errand(tk, 'find', JOB);
    expect((await stateOf(tk)).errand).toMatchObject({ state: 'failed', reason: 'blocked' });
    expect(await thoughtsOf()).toEqual([]);
  });
});

describe('Errand price data › the upper bounds', () => {
  // spec: add-pet-errands › Errand flow › report
  it('prices an errand within the «up to» it showed', async () => {
    richPet(h);
    const tk = await owner();
    h.net().ai.push({ stream: { searches: 1 }, tokensIn: 8_900, tokensOut: 100 }, { content: 'Found [1].', tokensIn: 4_000, tokensOut: 1_600 });
    await errand(tk, 'find', JOB);
    const [thought] = await errandThoughts();
    expect(BigInt(thought.price_yocto)).toBeLessThanOrEqual(upToFor(env, 1).yocto);
  });
});
