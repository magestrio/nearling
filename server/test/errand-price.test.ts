import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { harness } from './helpers/api';
import type { AiBehavior } from './helpers/network';
import { callsOf, conversation, errand, errandRow, richPet, owner, PET, spendKinds, stateOf, thoughtsOf } from './helpers/errands';
import { MAX_THOUGHT_PRICE_YOCTO } from '../src/pricing';
import { yoctoMicros } from '../src/spend';
import { cutPrice, errandPrice, allowanceFor, fullRead, need, readCoefficients, readFor, searchQuote, typicalRead, typicalSearch, upToFor, view, yoctoToUsd12 } from '../src/errands/price';

const cents = (p: Parameters<typeof view>[0]) => view(p).cents;
/** The same env at another rate of NEAR (the var's type is the literal of the dev config). */
const at = (rate: string) => ({ ...env, NEAR_USD_RATE: rate as typeof env.NEAR_USD_RATE });

describe('Errand price data', () => {
  // spec: add-pet-errands › Errand flow › can't pay
  it('prices the starts of §4 at NEAR $4.59: a typical read, a typical one-search errand and what a start needs', () => {
    expect(env.NEAR_USD_RATE).toBe('4.59');
    expect(cents(typicalRead(env))).toBe(0.19);
    expect(cents(typicalSearch(env))).toBe(0.85);
    // «Find out» needs the typical one-search errand and one scale thought (STARTER_FOOD / 12): §4's ≈ 0.93¢ (the sum
    // of the two rounded figures; the exact sum is 0.92¢).
    expect(cents(need(env, 'find'))).toBeCloseTo(0.93, 1);
    expect(cents(need(env, 'check'))).toBe(cents(need(env, 'find')));
    // A read needs a full 8,000-token page with its worst report: §4's ≈ 0.50¢.
    expect(cents(need(env, 'read'))).toBe(0.5);
    expect(need(env, 'read').yocto).toBe(fullRead(env).yocto);
  });

  // spec: add-pet-errands › Errand sheet screen › a search form
  it('bounds one, two and three searches at §4\'s ≈ 1.1¢, ≈ 1.7¢ and the fixed ≈ 2.05¢', () => {
    expect(cents(upToFor(env, 1))).toBe(1.1);
    expect(cents(upToFor(env, 2))).toBe(1.7);
    // two significant digits: the sheet's «up to ≈ 2¢»
    expect(cents(upToFor(env, 3))).toBe(2);
    expect(upToFor(env, 3).usd12).toBe(20_500_000_000n);
    // three searches' ceiling passes the thought's limit only below NEAR ≈ $4.10; at $4.59 it fits with the room §4 names
    expect(upToFor(env, 3).yocto).toBeLessThanOrEqual(MAX_THOUGHT_PRICE_YOCTO);
  });

  // spec: add-pet-errands › Errand sheet screen › a search form
  it('drops the third search when ≈ 2.05¢ passes 0.005 NEAR at the rate, and never before', () => {
    expect(allowanceFor(env, false)).toBe(3);
    // 0.0205 USD at $4.10 is 0.005 NEAR to the digit: still fits at $4.10, passes at $4.09
    expect(allowanceFor(at('4.10'), false)).toBe(3);
    expect(allowanceFor(at('4.09'), false)).toBe(2);
    expect(allowanceFor(at('3.50'), false)).toBe(2);
  });

  // spec: add-pet-errands › Errand sheet screen › a skill with outside data
  it('allows a pet with sources or code two searches, its ceiling about 1.75¢', () => {
    expect(allowanceFor(env, true)).toBe(2);
    // the data takes the third search's place in the report's input: §4's ≈ 1.75¢ (the arithmetic gives 1.78)
    expect(cents(upToFor(env, 2, true))).toBeLessThanOrEqual(1.8);
    expect(cents(upToFor(env, 2, true))).toBeGreaterThan(cents(upToFor(env, 2, false)));
  });

  // spec: add-pet-errands › Errand sheet screen › food covers fewer searches
  it('lowers the «up to» to what the food covers and the searches to what that pays', () => {
    const rich = searchQuote(env, 10n ** 24n, false);
    expect(rich).toMatchObject({ full: true, searches: 3, allowance: 3 });
    expect(cents(rich.upTo)).toBe(2);
    // a room that pays two searches but not three
    const two = upToFor(env, 2).yocto;
    const mid = searchQuote(env, two + 1n, false);
    expect(mid).toMatchObject({ full: false, searches: 2 });
    expect(mid.upTo.yocto).toBe(two + 1n);
    // a room for one search only, and a room for less than one still shows at least one (the block comes first)
    const one = searchQuote(env, upToFor(env, 1).yocto, false);
    expect(one).toMatchObject({ full: false, searches: 1 });
    expect(searchQuote(env, 1n, false).searches).toBe(1);
    // a pet with sources: at most two, and «full» at the allowance's own ceiling
    const skilled = searchQuote(env, 10n ** 24n, true);
    expect(skilled).toMatchObject({ full: true, searches: 2, allowance: 2 });
    expect(skilled.upTo.yocto).toBe(upToFor(env, 2, true).yocto);
  });

  // spec: add-pet-errands › Errand sheet screen › success
  it('gives the client a base and a price a token, so a pasted text is priced with no request per keystroke', () => {
    const { base, perToken } = readCoefficients(env);
    for (const tokens of [0, 1_000, 3_000, 8_000]) {
      const server = readFor(env, tokens).yocto;
      const client = BigInt(base) + BigInt(perToken) * BigInt(tokens);
      // never below the server's price, and within a few percent of it
      expect(client).toBeGreaterThanOrEqual(server);
      expect(Number(client - server) / Number(server)).toBeLessThan(0.01);
    }
    expect(readFor(env, 3_000).yocto).toBe(typicalRead(env).yocto);
  });

  it('turns food into cents without rounding up', () => {
    expect(yoctoToUsd12(env, 10n ** 24n)).toBe(4_590_000_000_000n);
  });
});

const h = harness();
const JOB = 'When is the Leonids meteor shower?';
const SEARCH = { tokensIn: 13_000, tokensOut: 60 };
const errandThoughts = async () => (await thoughtsOf()).filter((t) => t.kind === 'errand');
const bytesOf = (blob: unknown) => new Uint8Array(blob as ArrayLike<number>);

describe('Errand price data › the report fails after searches', () => {
  /** The failures of a report: it comes unsigned, empty, not at all. */
  const failures: [string, AiBehavior][] = [
    ['unsigned', { content: 'A fine report [1].', signature: 'never' }],
    ['empty', { content: '' }],
    ['not at all', { status: 503 }],
  ];

  for (const [name, report] of failures) {
    // spec: add-pet-errands › Errand price data › report failed after searches
    // spec: add-pet-errands › Errand flow › came back empty
    it(`pays the searches that ran when the report comes ${name}: the receipt holds the search call, the line says what they cost`, async () => {
      richPet(h);
      const tk = await owner();
      h.net().ai.push({ stream: { searches: 2 }, ...SEARCH }, { tokensIn: 900, tokensOut: 5, ...report });
      const out = await errand(tk, 'find', JOB);
      expect(out.code).toBe('errand_failed');

      const [thought] = await errandThoughts();
      // the searches × 1.2 and the gas share and the search call's tokens; the report's tokens are not the pet's
      expect(BigInt(thought.price_yocto)).toBe(errandPrice(env, [SEARCH], 2));
      expect(thought).toMatchObject({ status: 'unbilled', reply_text: null, player_text: JOB, searches: 2, kind: 'errand' });
      expect((await callsOf(thought.id)).map((c: any) => c.label)).toEqual(['search']);
      // the errand is kept with its price, for «Its searches still cost {price}» and «Try again»
      expect(await errandRow()).toMatchObject({ state: 'failed', reason: 'empty', job: JOB, price_yocto: thought.price_yocto, thought_id: thought.id, searches_ran: 2 });
      expect((await stateOf(tk)).errand).toEqual({ state: 'failed', form: 'find', job: JOB, reason: 'empty', priceCents: Number((thought.price_usd_micros / 10_000).toPrecision(2)) });
      // the conversation: the job and the line of a paid errand with no report
      const lines = (await conversation(tk)).lines;
      expect(lines.map((l: any) => l.who)).toEqual(['player', 'error']);
      expect(lines[1]).toMatchObject({ code: 'errand_empty', priceCents: Number((thought.price_usd_micros / 10_000).toPrecision(2)) });
      // fullness lower by the price; no reserve left; no energy taken, no mood lift (nothing was shown)
      expect(await env.DB.prepare('SELECT 1 FROM pet_spend').first()).toBeNull();
      expect(await env.DB.prepare('SELECT energy_used FROM pet_life WHERE token_id = ?').bind(PET).first()).toBeNull();
      expect(h.events().find((e) => e.name === 'errand_failed')!.props).toMatchObject({ form: 'find', reason: 'empty', searches: 2 });
      expect(h.events().find((e) => e.name === 'errand_failed')!.props.price_usd as number).toBeGreaterThan(0);
    });
  }

  // spec: add-pet-errands › Errand price data › report failed after searches
  it('puts the report\'s tokens of an unsigned or empty report on the project, among the pet\'s three failed calls for an empty one', async () => {
    richPet(h);
    const tk = await owner();
    h.net().ai.push({ stream: { searches: 1 } }, { content: '', tokensIn: 800, tokensOut: 5 });
    await errand(tk, 'find', JOB);
    expect((await spendKinds()).map((k) => k.kind)).toEqual(['no_thought']);
    expect((await env.DB.prepare('SELECT n FROM empty_answers WHERE token_id = ?').bind(PET).first<{ n: number }>())?.n).toBe(1);
  });

  // spec: add-pet-errands › Errand price data › report failed after searches
  it('makes the pet pay the report\'s tokens of an empty report from the fourth failed call of the day, the receipt holding both calls', async () => {
    richPet(h);
    const tk = await owner();
    await env.DB.prepare('INSERT INTO empty_answers (token_id, day, n) VALUES (?, ?, 3)').bind(PET, Math.floor(Date.now() / 86_400_000)).run();
    h.net().ai.push({ stream: { searches: 1 }, ...SEARCH }, { content: '', tokensIn: 800, tokensOut: 5 });
    await errand(tk, 'find', JOB);
    const [thought] = await errandThoughts();
    expect(BigInt(thought.price_yocto)).toBe(errandPrice(env, [SEARCH, { tokensIn: 800, tokensOut: 5 }], 1));
    expect((await callsOf(thought.id)).map((c: any) => c.label)).toEqual(['search', 'report']);
    expect(await spendKinds()).toEqual([]);
  });
});

describe('Errand price data › a price over the cap', () => {
  // spec: add-pet-errands › Errand price data › report failed after searches
  it('records the part above the thought limit as project edge spend', async () => {
    const over = 10n ** 21n;
    const price = await cutPrice(env, { room: MAX_THOUGHT_PRICE_YOCTO + over, capLeft: MAX_THOUGHT_PRICE_YOCTO + over }, MAX_THOUGHT_PRICE_YOCTO + over);
    expect(price).toBe(MAX_THOUGHT_PRICE_YOCTO);
    expect(await spendKinds()).toEqual([{ kind: 'edge', usd_micros: yoctoMicros(env, over) }]);
  });
});

describe('Errand price data › the third search and the ceiling', () => {
  // spec: add-pet-errands › Errand flow › report
  it('writes the report of three searches with no reasoning and no re-ask, under the «up to» shown', async () => {
    richPet(h);
    const tk = await owner();
    // a report that ends at its ceiling with no reply would be re-asked after one or two searches
    h.net().ai.push({ stream: { searches: 3 }, tokensIn: 20_000, tokensOut: 100 }, { content: '', finish: 'length', tokensIn: 4_000 });
    await errand(tk, 'find', JOB);
    const calls = h.net().ai.calls;
    // search call, one report call: no second one
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(calls[1]!.body.messages[0]!.content).not.toContain('think carefully');
    // its ceiling is what the «up to» leaves after the searches: under the fuse, and the whole stays within ≈ 2.05¢
    expect(calls[1]!.body.max_tokens).toBeLessThan(1_600);
    expect(calls[1]!.body.max_tokens).toBeGreaterThan(0);
    // the report's input as the Worker bounds it (a token a byte, the quoted results a token per four bytes), at its whole ceiling
    const enc = new TextEncoder();
    const [system, user] = calls[1]!.body.messages.map((m) => m.content);
    const quoted = enc.encode(user!.slice(user!.indexOf('The search results: ') + 'The search results: '.length)).length;
    const bound = enc.encode(system!).length + enc.encode(user!).length - quoted + Math.ceil(quoted / 4);
    expect(errandPrice(env, [{ tokensIn: 20_000, tokensOut: 100 }, { tokensIn: bound, tokensOut: calls[1]!.body.max_tokens }], 3)).toBeLessThanOrEqual(upToFor(env, 3).yocto);
  });

  // spec: add-pet-errands › Errand flow › report
  it('prices a report of three searches at most at the fixed ≈ 2.05¢', async () => {
    richPet(h);
    const tk = await owner();
    h.net().ai.push({ stream: { searches: 3 }, tokensIn: 20_000, tokensOut: 100 }, { content: 'Three sites agree [1][4][7].', tokensIn: 4_000, tokensOut: 300 });
    await errand(tk, 'find', JOB);
    const [thought] = await errandThoughts();
    expect(thought.searches).toBe(3);
    expect(BigInt(thought.price_yocto)).toBeLessThanOrEqual(upToFor(env, 3).yocto);
    expect(Number(thought.price_usd_micros)).toBeLessThanOrEqual(20_500);
  });

  // spec: add-pet-errands › Errand price data › a search past the allowance
  it('reasons in the report of one or two searches and re-asks once without reasoning when the reasoning ate the ceiling', async () => {
    richPet(h);
    const tk = await owner();
    h.net().ai.push({ stream: { searches: 1 } }, { content: '<think>hmm', finish: 'length', tokensIn: 3_000, tokensOut: 1_600 }, { content: 'A short answer [1].' });
    await errand(tk, 'find', JOB);
    const [, first, second] = h.net().ai.calls;
    expect(first!.body.chat_template_kwargs).toEqual({ enable_thinking: true });
    expect(second!.body.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(second!.body.max_tokens).toBeLessThanOrEqual(600);
    const [thought] = await errandThoughts();
    expect(thought).toMatchObject({ reply_text: 'A short answer.', reasked: 1 });
    expect((await callsOf(thought.id)).map((c: any) => c.label)).toEqual(['search', 'report', 'reask']);
  });
});

describe('Find out flow › the search call ran no search twice, past three', () => {
  // spec: add-pet-errands › Errand price data › no search ran twice, past three
  // spec: add-pet-errands › Find out flow › web search down, past three
  it('makes the pet pay both calls by usage and the gas share, ≤ ≈ 0.16¢, the receipt holding two gateway calls', async () => {
    richPet(h);
    const tk = await owner();
    await env.DB.prepare('INSERT INTO empty_answers (token_id, day, n) VALUES (?, ?, 3)').bind(PET, Math.floor(Date.now() / 86_400_000)).run();
    h.net().ai.push({ stream: { searches: 0 }, tokensIn: 300, tokensOut: 40 }, { stream: { searches: 0 }, tokensIn: 310, tokensOut: 35 });
    const out = await errand(tk, 'find', JOB);
    expect(out.code).toBe('errand_failed');
    const [thought] = await errandThoughts();
    expect(BigInt(thought.price_yocto)).toBe(errandPrice(env, [{ tokensIn: 300, tokensOut: 40 }, { tokensIn: 310, tokensOut: 35 }], 0));
    expect(Number(thought.price_usd_micros)).toBeLessThanOrEqual(1_600);
    expect(thought).toMatchObject({ status: 'unbilled', reply_text: null, searches: 0, player_text: JOB });
    const calls = await callsOf(thought.id);
    expect(calls.map((c: any) => [c.label, c.sig_kind, c.cut])).toEqual([['search', 'gateway', 0], ['search', 'gateway', 0]]);
    expect(calls.every((c: any) => bytesOf(c.res_bytes).length > 0)).toBe(true);
    // the errand is kept as a web search down, with its price; the shared count went to four
    expect(await errandRow()).toMatchObject({ state: 'failed', reason: 'search_down', cause: 'no_search', price_yocto: thought.price_yocto });
    expect((await stateOf(tk)).errand).toMatchObject({ reason: 'search_down', cause: 'no_search', priceCents: expect.any(Number) });
    expect((await env.DB.prepare('SELECT n FROM empty_answers WHERE token_id = ?').bind(PET).first<{ n: number }>())?.n).toBe(4);
    // not the project's: no spend; no separate thought_failed past three
    expect(await spendKinds()).toEqual([]);
    expect(h.events().filter((e) => e.name === 'thought_failed')).toEqual([]);
    const failed = h.events().find((e) => e.name === 'errand_failed')!.props;
    expect(failed).toMatchObject({ reason: 'search_down', cause: 'no_search', searches: 0, project_usd: 0 });
    expect(failed.price_usd as number).toBeGreaterThan(0);
    expect(await env.DB.prepare('SELECT 1 FROM pet_spend').first()).toBeNull();
  });
});
