// The test call of a data source's address (`Adapter connect flow` › «address answered», «address didn't answer»,
// ADR-024): the Worker is the MCP client, keyless, nothing saved.
import { describe, expect, it } from 'vitest';
import { api, harness } from './helpers/api';
import { checkAddress, DAYBOOK, FakeMcp, other, owner, petWithSkill, SOURCE_URL, sourceRows } from './helpers/sources';

const h = harness();

/** Requests that reached a source's host. */
const toSource = () => h.net().fetched.filter((u) => u.includes('example.com') && !u.includes('cloudflare-dns'));

const FAILED = { status: 422, body: { code: 'address_failed' } };

describe('Adapter connect flow', () => {
  // spec: add-pet-errands › Adapter connect flow › address answered
  it('lists the tools of an address that answers, each with its parameters and whether it can be ticked', async () => {
    const tk = await petWithSkill(h);
    const mcp = new FakeMcp(h.net().web);
    const out = await checkAddress(tk, SOURCE_URL);
    expect(out.status).toBe(200);
    expect(out.body.tools).toEqual([
      {
        name: 'events_on',
        description: 'Notable events on a day of the year.',
        params: [
          { name: 'month', type: 'number', required: true },
          { name: 'day', type: 'number', required: true },
        ],
        tickable: true,
      },
      { name: 'search', description: 'Search the archive by words.', params: [], tickable: false, reason: 'free_text' },
      { name: 'today', description: 'The date today.', params: [], tickable: true },
    ]);
    // the handshake, then the list; the server saw no cookie, no token, no player and no asker
    expect(mcp.requests.map((r) => r.method)).toEqual(['initialize', 'notifications/initialized', 'tools/list']);
    for (const r of mcp.requests) {
      expect(r.headers.accept).toBe('application/json, text/event-stream');
      expect(Object.keys(r.headers).filter((k) => ['cookie', 'authorization', 'privy-id-token', 'origin', 'referer'].includes(k))).toEqual([]);
    }
    expect(mcp.requests[0]!.params).toEqual({ protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'nearling', version: '1' } });
    expect(mcp.requests[2]!.headers['mcp-protocol-version']).toBe('2025-11-25');
    // nothing is saved by a test, and no log line holds the address
    expect(await sourceRows()).toEqual([]);
    expect(h.logs().join('\n')).not.toContain('open-meteo');
  });

  // spec: add-pet-errands › Adapter connect flow › address answered
  it('reads an SSE answer, keeps the session id for the job and follows the pages of the list', async () => {
    const tk = await petWithSkill(h);
    const pages = [[DAYBOOK[0]!], [DAYBOOK[2]!]];
    const mcp = new FakeMcp(h.net().web, SOURCE_URL, { mode: 'sse', session: true, pages });
    const out = await checkAddress(tk, SOURCE_URL);
    expect(out.body.tools.map((t: { name: string }) => t.name)).toEqual(['events_on', 'today']);
    expect(mcp.requests.map((r) => r.method)).toEqual(['initialize', 'notifications/initialized', 'tools/list', 'tools/list']);
    expect(mcp.requests[0]!.headers['mcp-session-id']).toBeUndefined();
    for (const r of mcp.requests.slice(1)) expect(r.headers['mcp-session-id']).toBe('session-1');
    expect(mcp.requests[3]!.params).toEqual({ cursor: '1' });
  });

  // spec: add-pet-errands › Adapter connect flow › address answered
  it('answers a bare host as its root path', async () => {
    const tk = await petWithSkill(h);
    new FakeMcp(h.net().web, 'https://mcp.open-meteo.example.com');
    expect((await checkAddress(tk, 'https://mcp.open-meteo.example.com')).status).toBe(200);
  });

  // spec: add-pet-errands › Adapter connect flow › address didn't answer
  it('does not call an address that is not a plain https address: http, a query, a fragment, a sign-in part', async () => {
    const tk = await petWithSkill(h);
    new FakeMcp(h.net().web);
    for (const address of [
      'http://mcp.open-meteo.example.com/mcp',
      `${SOURCE_URL}?key=abc`,
      `${SOURCE_URL}?`,
      `${SOURCE_URL}#top`,
      'https://user:secret@mcp.open-meteo.example.com/mcp',
      'https://user@mcp.open-meteo.example.com/mcp',
      'ftp://mcp.open-meteo.example.com/mcp',
      'mcp.open-meteo.example.com/mcp',
      ` ${SOURCE_URL}`,
      '',
    ]) {
      expect(await checkAddress(tk, address), address).toMatchObject(FAILED);
    }
    expect(toSource()).toEqual([]);
    expect(await sourceRows()).toEqual([]);
  });

  // spec: add-pet-errands › Adapter connect flow › address didn't answer
  it('fails on a timeout, a 500, a JSON-RPC error, no tools and an answer over 256 KB; nothing is saved', async () => {
    const tk = await petWithSkill(h);
    for (const opts of [{ hang: true }, { status: 500 }, { status: 404 }, { rpcError: true }, { tools: [] }, { padBytes: 300_000 }]) {
      h.net().web.handlers.clear();
      new FakeMcp(h.net().web, SOURCE_URL, opts);
      expect(await checkAddress(tk, SOURCE_URL), JSON.stringify(opts)).toMatchObject(FAILED);
    }
    // a host nobody answers at
    h.net().web.handlers.clear();
    expect(await checkAddress(tk, 'https://nobody.example.com/mcp')).toMatchObject(FAILED);
    expect(await sourceRows()).toEqual([]);
  });

  // spec: add-pet-errands › Adapter connect flow › address didn't answer
  it('never saves a source that asks for a key: 401, 403 or a WWW-Authenticate header', async () => {
    const tk = await petWithSkill(h);
    for (const opts of [{ status: 401 }, { status: 403 }, { status: 401, headers: { 'www-authenticate': 'Bearer resource_metadata="https://x.example.com/.well-known"' } }, { headers: { 'www-authenticate': 'Bearer' } }]) {
      h.net().web.handlers.clear();
      new FakeMcp(h.net().web, SOURCE_URL, opts);
      expect(await checkAddress(tk, SOURCE_URL), JSON.stringify(opts)).toMatchObject(FAILED);
    }
    expect(await sourceRows()).toEqual([]);
    expect(h.logs()).toContain('source_check:key');
  });

  // spec: add-pet-errands › Data source call data › an address inside a network
  it('does not call an address that resolves inside a network, or one that redirects to another host', async () => {
    const tk = await petWithSkill(h);
    const mcp = new FakeMcp(h.net().web);
    h.net().web.dns.set('mcp.open-meteo.example.com', { a: ['10.0.0.5'] });
    expect(await checkAddress(tk, SOURCE_URL)).toMatchObject(FAILED);
    h.net().web.dns.set('mcp.open-meteo.example.com', { a: ['93.184.216.34'], aaaa: ['fe80::1'] });
    expect(await checkAddress(tk, SOURCE_URL)).toMatchObject(FAILED);
    expect(mcp.requests).toEqual([]);
    for (const literal of ['https://127.0.0.1/mcp', 'https://169.254.169.254/latest', 'https://[::1]/mcp', 'https://localhost/mcp']) {
      expect(await checkAddress(tk, literal), literal).toMatchObject(FAILED);
    }

    h.net().web.dns.clear();
    h.net().web.handlers.set(new URL('https://moved.example.com/mcp').href, () => new Response(null, { status: 307, headers: { location: 'https://elsewhere.example.com/mcp' } }));
    new FakeMcp(h.net().web, 'https://elsewhere.example.com/mcp');
    expect(await checkAddress(tk, 'https://moved.example.com/mcp')).toMatchObject(FAILED);
    // a redirect inside the same host is followed
    h.net().web.handlers.set(
      new URL('https://same.example.com/old').href,
      () => new Response(null, { status: 307, headers: { location: 'https://same.example.com/mcp' } }),
    );
    new FakeMcp(h.net().web, 'https://same.example.com/mcp');
    expect((await checkAddress(tk, 'https://same.example.com/old')).status).toBe(200);
  });

  // spec: add-pet-errands › Data source call data › an address inside a network
  it('checks DNS again before following a same-host redirect', async () => {
    const tk = await petWithSkill(h);
    const host = 'rebinding.example.com';
    h.net().web.dns.set(host, { a: ['93.184.216.34'] });
    h.net().web.handlers.set(`https://${host}/old`, () => {
      h.net().web.dns.set(host, { a: ['10.0.0.5'] });
      return new Response(null, { status: 307, headers: { location: `https://${host}/mcp` } });
    });
    const mcp = new FakeMcp(h.net().web, `https://${host}/mcp`);
    expect(await checkAddress(tk, `https://${host}/old`)).toMatchObject(FAILED);
    expect(mcp.requests).toEqual([]);
  });

  // spec: add-pet-errands › Data source call data › an address inside a network
  it('checks DNS again for later requests in one MCP session', async () => {
    const tk = await petWithSkill(h);
    const host = 'rebinding.example.com';
    h.net().web.dns.set(host, { a: ['93.184.216.34'] });
    const mcp = new FakeMcp(h.net().web, `https://${host}/mcp`, {
      during: async (method) => { if (method === 'initialize') h.net().web.dns.set(host, { a: ['10.0.0.5'] }); },
    });
    expect(await checkAddress(tk, `https://${host}/mcp`)).toMatchObject(FAILED);
    expect(mcp.requests.map((r) => r.method)).toEqual(['initialize']);
  });

  // spec: add-pet-errands › Data source data › not the owner
  it('turns anyone but the owner away before any call goes out', async () => {
    await petWithSkill(h);
    const mcp = new FakeMcp(h.net().web);
    expect(await checkAddress(await other(), SOURCE_URL)).toMatchObject({ status: 403, body: { code: 'not_owner' } });
    expect((await api(`/api/pets/5/sources/check`, { body: { address: SOURCE_URL } })).status).toBe(401);
    expect((await checkAddress(await owner(), 42)).status).toBe(400);
    expect(mcp.requests).toEqual([]);
  });
});
