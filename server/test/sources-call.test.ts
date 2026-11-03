// A job calls a data source (`Data source call data`, `Errand events data` › «data source called»): the value rule
// before anything goes out, the failures that keep nothing, the host check, the one-minute read cache, and what the
// events and logs may hold.
import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { callSourceTool, doorCaller, loadSources } from '../src/sources/call';
import { harness } from './helpers/api';
import { FakeMcp, PET, petWithSource, SOURCE_URL } from './helpers/sources';

const h = harness();

const sourceOf = async () => (await loadSources(env.DB, PET))[0]!;
const adapterEvents = () => h.events().filter((e) => e.name === 'adapter_called');
const toSource = () => h.net().fetched.filter((u) => u.includes('example.com') && !u.includes('cloudflare-dns'));

describe('Data source call data', () => {
  // spec: add-pet-errands › Data source call data › a value outside the rule
  it('does not send a value that is no number, boolean, pick or short plain text: refused, no request', async () => {
    const { mcp } = await petWithSource(h);
    const source = await sourceOf();
    h.net().fetched.length = 0;
    const bad: unknown[] = [
      { month: '5; drop', day: 3 },
      { month: 5 },
      { month: 5, day: 3, extra: 1 },
      { month: Number.NaN, day: 3 },
      { month: [5], day: 3 },
      { month: 5, day: 'x'.repeat(65) },
      'May 3',
      [5, 3],
    ];
    for (const values of bad) {
      expect(await callSourceTool(env, source, 'events_on', values, 'errand'), JSON.stringify(values)).toEqual({ ok: false, outcome: 'refused' });
    }
    // a tool that is not ticked, and one that is not there
    expect(await callSourceTool(env, source, 'search', { query: 'moon' }, 'errand')).toEqual({ ok: false, outcome: 'refused' });
    expect(await callSourceTool(env, source, 'nothing', {}, 'errand')).toEqual({ ok: false, outcome: 'refused' });
    expect(mcp.requests).toEqual([]);
    expect(toSource()).toEqual([]);
    expect(adapterEvents().every((e) => e.props.outcome === 'refused' && e.props.job === 'errand')).toBe(true);
    expect(adapterEvents()).toHaveLength(bad.length + 2);
  });

  // spec: add-pet-errands › Data source call data › a value outside the rule
  it('lets a plain value through: numbers, an integer-valued number, text of letters, digits and . _ - :', async () => {
    const { mcp } = await petWithSource(h);
    const source = await sourceOf();
    const out = await callSourceTool(env, source, 'events_on', { month: 11, day: 3 }, 'advice');
    expect(out).toEqual({ ok: true, output: 'events_on answered', cached: false });
    expect(mcp.requests.map((r) => r.method)).toEqual(['initialize', 'notifications/initialized', 'tools/call']);
    expect(mcp.requests[2]!.params).toEqual({ name: 'events_on', arguments: { month: 11, day: 3 } });
    expect(await callSourceTool(env, source, 'today', {}, 'advice')).toMatchObject({ ok: true });
  });

  // spec: add-pet-errands › Data source call data › busy, slow or down
  it('keeps nothing of a source that answers 429 or 503, hangs, errors or says isError: busy, slow or down', async () => {
    const cases: [object, string][] = [
      [{ callStatus: 429 }, 'busy'],
      [{ callStatus: 503 }, 'busy'],
      [{ callRpcError: true }, 'busy'],
      [{ callResult: () => ({ isError: true, content: [{ type: 'text', text: 'boom' }] }) }, 'busy'],
      [{ hang: true }, 'slow'],
      [{ callStatus: 500 }, 'down'],
      [{ callResult: () => ({ nothing: true }) }, 'down'],
    ];
    const { mcp } = await petWithSource(h);
    const source = await sourceOf();
    for (const [opts, outcome] of cases) {
      // the source connected while it worked; it fails from now on, one way at a time
      mcp.opts.callStatus = undefined;
      mcp.opts.callRpcError = undefined;
      mcp.opts.callResult = undefined;
      mcp.opts.hang = undefined;
      Object.assign(mcp.opts, opts);
      const called = await callSourceTool(env, source, 'events_on', { month: 1, day: 2 }, 'hire');
      expect(called, JSON.stringify(opts)).toEqual({ ok: false, outcome });
    }
    const outcomes = adapterEvents().map((e) => e.props.outcome);
    expect(outcomes).toEqual(['busy', 'busy', 'busy', 'busy', 'slow', 'down', 'down']);
    // nothing of an answer is kept: no D1 row, and a repeat after a failure goes out again
    expect(await env.DB.prepare('SELECT 1 FROM thoughts').first()).toBeNull();
  });

  // spec: add-pet-errands › Data source call data › busy, slow or down
  it('does not cache a failure', async () => {
    const { mcp } = await petWithSource(h, { callStatus: 503 });
    const source = await sourceOf();
    expect(await callSourceTool(env, source, 'today', {}, 'errand')).toEqual({ ok: false, outcome: 'busy' });
    mcp.opts.callStatus = undefined;
    expect(await callSourceTool(env, source, 'today', {}, 'errand')).toMatchObject({ ok: true, cached: false });
  });

  // spec: add-pet-errands › Data source call data › an address inside a network
  it('does not call a source whose address resolves inside a network or redirects to another host: down', async () => {
    const { mcp } = await petWithSource(h);
    const source = await sourceOf();
    h.net().web.dns.set('mcp.open-meteo.example.com', { a: ['10.0.0.5'] });
    expect(await callSourceTool(env, source, 'today', {}, 'errand')).toEqual({ ok: false, outcome: 'down' });
    h.net().web.dns.clear();
    h.net().web.handlers.set(new URL(SOURCE_URL).href, () => new Response(null, { status: 307, headers: { location: 'https://elsewhere.example.com/mcp' } }));
    new FakeMcp(h.net().web, 'https://elsewhere.example.com/mcp');
    expect(await callSourceTool(env, source, 'today', {}, 'errand')).toEqual({ ok: false, outcome: 'down' });
    expect(mcp.requests).toEqual([]);
    expect(adapterEvents().map((e) => e.props)).toEqual([
      { outcome: 'down', job: 'errand' },
      { outcome: 'down', job: 'errand' },
    ]);
  });

  // spec: add-pet-errands › Data source call data › busy, slow or down × the same call within 60 s
  it('answers the same call within 60 s from the cache, one outbound call', async () => {
    const { mcp } = await petWithSource(h);
    const source = await sourceOf();
    const first = await callSourceTool(env, source, 'events_on', { month: 4, day: 9 }, 'errand');
    const second = await callSourceTool(env, source, 'events_on', { day: 9, month: 4 }, 'advice');
    expect(first).toEqual({ ok: true, output: 'events_on answered', cached: false });
    expect(second).toEqual({ ok: true, output: 'events_on answered', cached: true });
    expect(mcp.requests.filter((r) => r.method === 'tools/call')).toHaveLength(1);
    // other values are another call
    await callSourceTool(env, source, 'events_on', { month: 4, day: 10 }, 'errand');
    expect(mcp.requests.filter((r) => r.method === 'tools/call')).toHaveLength(2);
    expect(adapterEvents().map((e) => e.props)).toEqual([
      { outcome: 'ok', job: 'errand' },
      { outcome: 'cached', job: 'advice' },
      { outcome: 'ok', job: 'errand' },
    ]);
  });

  // spec: add-pet-errands › Data source call data › busy, slow or down × the same call after 60 s
  it('calls again after 60 s', async () => {
    const { mcp } = await petWithSource(h);
    const source = await sourceOf();
    await callSourceTool(env, source, 'today', {}, 'errand');
    vi.setSystemTime(Date.now() + 59_000);
    expect(await callSourceTool(env, source, 'today', {}, 'errand')).toMatchObject({ cached: true });
    vi.setSystemTime(Date.now() + 1_000);
    expect(await callSourceTool(env, source, 'today', {}, 'errand')).toMatchObject({ cached: false });
    expect(mcp.requests.filter((r) => r.method === 'tools/call')).toHaveLength(2);
  });

  // spec: add-pet-errands › Data source call data › a value outside the rule
  it('reads structuredContent as JSON before the text, joins the text contents, and cuts at 16,000 characters', async () => {
    const results: object[] = [{ structuredContent: { events: ['a'] }, content: [{ type: 'text', text: 'ignored' }] }, { content: [{ type: 'text', text: 'one' }, { type: 'image', data: 'x' }, { type: 'text', text: 'two' }] }, { content: [{ type: 'text', text: 'y'.repeat(20_000) }] }];
    const { mcp } = await petWithSource(h);
    const source = await sourceOf();
    let n = 0;
    mcp.opts.callResult = () => results[n++]!;
    expect(await callSourceTool(env, source, 'events_on', { month: 1, day: 1 }, 'errand')).toMatchObject({ output: '{"events":["a"]}' });
    expect(await callSourceTool(env, source, 'events_on', { month: 1, day: 2 }, 'errand')).toMatchObject({ output: 'one\ntwo' });
    const cut = await callSourceTool(env, source, 'events_on', { month: 1, day: 3 }, 'errand');
    expect(cut).toMatchObject({ ok: true });
    if (cut.ok) {
      expect(cut.output.startsWith('y'.repeat(16_000))).toBe(true);
      expect(cut.output.endsWith('[cut]')).toBe(true);
      expect(cut.output.length).toBeLessThan(16_010);
    }
  });

  // spec: add-pet-errands › Errand events data › data source called
  it('logs the outcome and the job only: never the address, the values or the output, and nothing for a test run', async () => {
    const { mcp } = await petWithSource(h);
    mcp.opts.callResult = () => ({ content: [{ type: 'text', text: 'SECRET-OUTPUT-7' }] });
    const source = await sourceOf();
    await callSourceTool(env, source, 'events_on', { month: 7, day: 77 }, 'errand');
    await callSourceTool(env, source, 'events_on', { month: 7, day: 77 }, 'errand');
    await callSourceTool(env, source, 'events_on', { month: 'x y', day: 1 }, 'hire');
    await callSourceTool(env, source, 'today', {}, 'test');
    expect(adapterEvents().map((e) => e.props)).toEqual([
      { outcome: 'ok', job: 'errand' },
      { outcome: 'cached', job: 'errand' },
      { outcome: 'refused', job: 'hire' },
    ]);
    const everything = JSON.stringify([h.events(), h.logs()]);
    expect(everything).not.toMatch(/open-meteo|SECRET-OUTPUT|"day":77|77/);
  });

  // spec: add-pet-errands › Data source call data › busy, slow or down
  it('gives the door of the code the parsed output, and a failure as a thrown outcome', async () => {
    const { mcp } = await petWithSource(h);
    mcp.opts.callResult = (name) => (name === 'today' ? { content: [{ type: 'text', text: 'plain words' }] } : { structuredContent: { n: 3 } });
    const door = doorCaller(env, PET, 'errand');
    expect(await door('Daybook', 'events_on', { month: 1, day: 1 })).toEqual({ n: 3 });
    expect(await door('Daybook', 'today', {})).toBe('plain words');
    await expect(door('Daybook', 'search', { query: 'a' })).rejects.toThrow('refused');
    await expect(door('Elsewhere', 'today', {})).rejects.toThrow('refused');
    mcp.opts.callStatus = 503;
    await expect(door('Daybook', 'events_on', { month: 9, day: 9 })).rejects.toThrow('busy');
  });
});
