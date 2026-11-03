// A skill's code, run (`add-pet-errands` › `Skill code flow`, `Skill code data`, ADR-025): the declaration it exports, the
// test run's outcomes, and the wall around it — no network, one door, six calls, five seconds. The isolate is the real
// Dynamic Worker of the Workers pool; the CPU cap of the platform is enforced only on a deployed Worker, so what the pool
// proves of it is how its error is read.
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { declaredTools, typedValues } from '../src/code/declare';
import { readDeclaration, runFunction } from '../src/code/runner';
import { harness } from './helpers/api';
import { CODE, testRun, testsToday, versionId } from './helpers/code';
import { petWithSkill } from './helpers/sources';

const h = harness();
const never = async () => {
  throw new Error('no tool is called here');
};

describe('Skill code flow', () => {
  // spec: add-pet-errands › Skill code flow › test passed
  // spec: add-pet-errands › Errand events data › code ran
  it('runs the function with the sample values typed by the declaration, shows the output and the functions, and logs skill_code_ran ok', async () => {
    const tk = await petWithSkill(h);
    const out = await testRun(tk, { code: CODE, fn: 'add', values: '2, 3.5' });
    expect(out.status).toBe(200);
    expect(out.body.outcome).toBe('ok');
    expect(JSON.parse(out.body.output)).toEqual({ sum: 5.5 });
    // every declared function, ticked unless it takes free text; `ghost` is exported but not declared, so it is not listed
    expect(out.body.functions.map((f: { name: string; ticked: boolean; tickable: boolean }) => [f.name, f.ticked, f.tickable])).toEqual([
      ['add', true, true],
      ['whole', true, true],
      ['signFor', true, true],
      ['rawFeed', false, false],
    ]);
    expect(h.events().filter((e) => e.name === 'skill_code_ran')).toEqual([{ name: 'skill_code_ran', props: { outcome: 'ok', job: 'test' } }]);
    expect(h.logs()).toContain('code_run:ok');
    // one of the pet's 20, and the code text is in no log
    expect((await testsToday()).runs).toBe(1);
    expect(h.logs().join('\n')).not.toContain('the stars');
    expect(h.logs().join('\n')).not.toContain('Adds two numbers');
  });

  // spec: add-pet-errands › Skill code flow › test passed
  it('types an integer and a text by their declaration, and hands a piece that does not fit over as text', async () => {
    const tk = await petWithSkill(h);
    const whole = await testRun(tk, { code: CODE, fn: 'whole', values: '7' });
    expect(JSON.parse(whole.body.output)).toEqual({ n: 7, kind: 'number' });
    const odd = await testRun(tk, { code: CODE, fn: 'whole', values: 'seven' });
    expect(JSON.parse(odd.body.output)).toEqual({ n: 'seven', kind: 'string' });
    const sign = await testRun(tk, { code: CODE, fn: 'signFor', values: 'Leo, Ada, yes' });
    expect(JSON.parse(sign.body.output)).toEqual({ sign: 'Leo', who: 'Ada', on: true });
  });

  // spec: add-pet-errands › Skill code flow › limit hit
  // spec: add-pet-errands › Errand events data › code ran
  it('a run that waits past five seconds ends as «limit», is not waited for, and logs skill_code_ran limit', async () => {
    const tk = await petWithSkill(h);
    const code = `export const functions = { slow: { description: "Waits", params: {} } };\nexport async function slow() { await new Promise((r) => setTimeout(r, 7000)); return "late"; }`;
    const started = performance.now();
    const out = await testRun(tk, { code, fn: 'slow' });
    const waited = performance.now() - started;
    expect(out.body).toEqual({ outcome: 'limit' });
    expect(waited).toBeGreaterThanOrEqual(4_900);
    expect(waited).toBeLessThan(6_500);
    expect(h.events().filter((e) => e.name === 'skill_code_ran')).toEqual([{ name: 'skill_code_ran', props: { outcome: 'limit', job: 'test' } }]);
    // «Save code» stays off: no passing hash
    expect((await testsToday()).passed_hash).toBeNull();
  }, 20_000);

  // spec: add-pet-errands › Skill code flow › limit hit
  it('a seventh call through the door is a limit even when the code catches what it was told; six calls went', async () => {
    const calls: string[] = [];
    const code = `export const functions = { many: { description: "Asks eight times", params: {} } };
export async function many() {
  const got = [];
  for (let i = 0; i < 8; i += 1) {
    try { got.push(await sources["Daybook"].events_on({ month: i })); } catch (e) { got.push("refused"); }
  }
  return got;
}`;
    const result = await runFunction(env, versionId(), code, 'many', [], { Daybook: ['events_on'] }, async (source, tool, values) => {
      calls.push(`${source}.${tool}.${values.month}`);
      return { ok: true };
    });
    expect(result).toEqual({ outcome: 'limit' });
    expect(calls).toEqual(['Daybook.events_on.0', 'Daybook.events_on.1', 'Daybook.events_on.2', 'Daybook.events_on.3', 'Daybook.events_on.4', 'Daybook.events_on.5']);
  });

  // spec: add-pet-errands › Skill code flow › limit hit
  it('the platform stopping a run past its CPU is read as «limit»', async () => {
    const stub = (message: string) => ({ LOADER: { get: () => ({ getEntrypoint: () => ({ run: async () => Promise.reject(new Error(message)), declared: async () => Promise.reject(new Error(message)) }) }) } }) as unknown as Pick<Env, 'LOADER'>;
    expect(await runFunction(stub('Worker exceeded CPU time limit.'), 'v', 'x', 'f', [], {}, never)).toEqual({ outcome: 'limit' });
    expect(await readDeclaration(stub('Worker exceeded CPU time limit.'), 'v', 'x')).toEqual({ outcome: 'limit' });
    // any other fault of the platform is the code's error, not a limit
    expect(await runFunction(stub('Network connection lost.'), 'v', 'x', 'f', [], {}, never)).toMatchObject({ outcome: 'error' });
  });

  // spec: add-pet-errands › Skill code flow › code error
  // spec: add-pet-errands › Errand events data › code ran
  it('a throw shows «name: message» and the lines of the owner\'s module, and logs skill_code_ran error; Save code stays off', async () => {
    const tk = await petWithSkill(h);
    const code = CODE.replace('export const functions = {', 'export const functions = {\n  boom: { description: "Throws", params: {} },');
    const out = await testRun(tk, { code, fn: 'boom' });
    expect(out.body.outcome).toBe('error');
    expect(out.body.error).toContain('Error: the stars fell');
    expect(out.body.error).toContain('skill.js');
    expect(out.body.error.length).toBeLessThanOrEqual(2_000);
    expect(h.events().filter((e) => e.name === 'skill_code_ran')).toEqual([{ name: 'skill_code_ran', props: { outcome: 'error', job: 'test' } }]);
    expect((await testsToday()).passed_hash).toBeNull();
  });

  // spec: add-pet-errands › Skill code flow › code error
  it('a module that does not load is the code\'s error and one of the pet\'s runs', async () => {
    const tk = await petWithSkill(h);
    const out = await testRun(tk, { code: 'export const functions = { f: ', fn: 'f' });
    expect(out.body.outcome).toBe('error');
    expect(out.body.error).toMatch(/SyntaxError|Unexpected/);
    expect((await testsToday()).runs).toBe(1);
  });

  // spec: add-pet-errands › Skill code flow › function not declared
  // spec: add-pet-errands › Skill code data › an undeclared function
  // spec: add-pet-errands › Errand events data › code ran
  it('a function the export does not declare ran nothing and used one of the pet\'s test runs of the day', async () => {
    const tk = await petWithSkill(h);
    const first = await testRun(tk, { code: CODE, fn: 'add', values: '1,1' });
    expect(first.body.outcome).toBe('ok');
    const used = (await testsToday()).runs;
    // `ghost` is exported (so it would run) but `functions` does not declare it
    const out = await testRun(tk, { code: CODE, fn: 'ghost' });
    expect(out.body).toEqual({ outcome: 'undeclared', fn: 'ghost' });
    expect((await testsToday()).runs).toBe(used + 1);
    expect(h.events().filter((e) => e.name === 'skill_code_ran').map((e) => e.props)).toEqual([
      { outcome: 'ok', job: 'test' },
      { outcome: 'error', job: 'test' },
    ]);
    // no `functions` export at all: nothing is declared
    const bare = await testRun(tk, { code: 'export function f() { return 1 }', fn: 'f' });
    expect(bare.body).toEqual({ outcome: 'undeclared', fn: 'f' });
    expect((await testsToday()).runs).toBe(used + 2);
  });
});

describe('Skill code data', () => {
  // spec: add-pet-errands › Skill code data › functions declared
  it('keeps each function\'s description and types — number, integer, boolean, symbol, a pick, text — and never ticks one that takes text', async () => {
    const declaration = {
      add: { description: 'Adds two numbers', params: { a: 'number', b: 'integer' } },
      signFor: { description: 'A sign', params: { sign: ['Aries', 'Leo'], who: 'symbol', on: 'boolean' } },
      rawFeed: { description: 'x'.repeat(400), params: { query: 'text' } },
      oddType: { description: 'An unknown type is text', params: { q: 'blob' } },
      none: { description: 'Takes nothing' },
    };
    const tools = declaredTools(declaration)!;
    expect(tools.find((t) => t.name === 'add')).toEqual({
      name: 'add',
      description: 'Adds two numbers',
      params: [
        { name: 'a', type: 'number', required: true },
        { name: 'b', type: 'integer', required: true },
      ],
      tickable: true,
    });
    expect(tools.find((t) => t.name === 'signFor')!.params).toEqual([
      { name: 'sign', type: 'pick', options: ['Aries', 'Leo'], required: true },
      { name: 'who', type: 'text', maxLength: 64, required: true },
      { name: 'on', type: 'boolean', required: true },
    ]);
    expect(tools.find((t) => t.name === 'signFor')!.tickable).toBe(true);
    const raw = tools.find((t) => t.name === 'rawFeed')!;
    expect(raw).toMatchObject({ tickable: false, reason: 'free_text', params: [{ name: 'query', type: 'text' }] });
    expect(raw.description).toHaveLength(300);
    expect(tools.find((t) => t.name === 'oddType')).toMatchObject({ tickable: false, reason: 'free_text' });
    expect(tools.find((t) => t.name === 'none')).toMatchObject({ params: [], tickable: true });
    expect(declaredTools([])).toBeNull();
    // the values of a test run follow the declared order
    expect(typedValues(tools.find((t) => t.name === 'add')!.params, '2, 3')).toEqual([2, 3]);
    expect(typedValues(tools.find((t) => t.name === 'add')!.params, '2')).toEqual([2]);
    expect(typedValues(tools.find((t) => t.name === 'add')!.params, '')).toEqual([]);
  });

  // spec: add-pet-errands › Skill code data › functions declared
  it('reads the declaration from the real module and keeps it as data, however the module builds it', async () => {
    const read = await readDeclaration(env, versionId(), CODE);
    expect(read.outcome).toBe('ok');
    if (read.outcome === 'ok') expect(Object.keys(read.declaration as object)).toEqual(['add', 'whole', 'signFor', 'rawFeed']);
    // a declaration that is not plain data (a function inside) loses what JSON cannot carry, and nothing runs
    const odd = await readDeclaration(env, versionId(), 'export const functions = { f: { description: "d", params: {}, run() { return 1 } } };');
    expect(odd).toEqual({ outcome: 'ok', declaration: { f: { description: 'd', params: {} } } });
  });

  // spec: add-pet-errands › Skill code flow › code error
  it('fetch, connect and a tool that is not ticked leave nothing: the run fails as the code\'s error and no call goes out', async () => {
    const outbound: string[] = [];
    const calls: string[] = [];
    h.net().web.handlers.set('https://example.com/', () => {
      outbound.push('fetch');
      return new Response('leaked');
    });
    const code = `import { connect } from "cloudflare:sockets";
export async function viaFetch() { return await (await fetch("https://example.com/")).text(); }
export async function viaConnect() { const s = connect("example.com:80"); await s.opened; return "open"; }
export async function viaSources() { return await sources["Daybook"].search({ query: "x" }); }
export async function otherSkill() { return await sources["Neighbour"].events_on({ month: 1 }); }
export async function bypass() { return await globalThis.fetch(new Request("https://example.com/")); }`;
    const caller = async (source: string, tool: string) => {
      calls.push(`${source}.${tool}`);
      return {};
    };
    for (const fn of ['viaFetch', 'viaConnect', 'viaSources', 'otherSkill', 'bypass']) {
      const result = await runFunction(env, versionId(), code, fn, [], { Daybook: ['events_on'] }, caller);
      expect(result.outcome, fn).toBe('error');
    }
    const net = await runFunction(env, versionId(), code, 'viaFetch', [], {}, caller);
    expect(net).toMatchObject({ outcome: 'error', message: expect.stringContaining('not permitted to access the internet') });
    expect(outbound).toEqual([]);
    expect(calls).toEqual([]);
  });

  // spec: add-pet-errands › Skill code flow › test passed
  it('a ticked tool of the skill is called through the door with the code\'s values and its answer comes back parsed', async () => {
    const seen: unknown[] = [];
    const code = `export async function ask() { const r = await sources["Daybook"].events_on({ month: 5, day: 4 }); return { got: r.events.length }; }`;
    const result = await runFunction(env, versionId(), code, 'ask', [], { Daybook: ['events_on', 'today'] }, async (source, tool, values) => {
      seen.push([source, tool, values]);
      return { events: [{ year: 1957 }] };
    });
    expect(result).toEqual({ outcome: 'ok', output: '{"got":1}' });
    expect(seen).toEqual([['Daybook', 'events_on', { month: 5, day: 4 }]]);
  });

  // spec: add-pet-errands › Skill code flow › code error
  it('a data source that does not answer is an error the code sees, with no reason or address in it', async () => {
    const code = `export async function ask() { return await sources["Daybook"].today({}); }`;
    const result = await runFunction(env, versionId(), code, 'ask', [], { Daybook: ['today'] }, async () => {
      throw new Error('busy');
    });
    expect(result).toMatchObject({ outcome: 'error' });
    expect((result as { message: string }).message).toContain('the data source did not answer');
  });

  // spec: add-pet-errands › Skill code flow › test passed
  it('the output is cut at 16,000 characters and two runs of one version at once keep their own door', async () => {
    const big = `export async function big() { return "x".repeat(20000); }
export async function who(label) { return await sources[label].me({}); }`;
    const cut = await runFunction(env, versionId(), big, 'big', [], {}, never);
    expect(cut.outcome).toBe('ok');
    expect(cut.outcome === 'ok' && cut.output.length).toBe(16_000);

    const version = versionId();
    const a = runFunction(env, version, big, 'who', ['A'], { A: ['me'] }, async () => {
      await new Promise((r) => setTimeout(r, 50));
      return 'door A';
    });
    const b = runFunction(env, version, big, 'who', ['B'], { B: ['me'] }, async () => 'door B');
    expect(await Promise.all([a, b])).toEqual([
      { outcome: 'ok', output: '"door A"' },
      { outcome: 'ok', output: '"door B"' },
    ]);
  });
});
