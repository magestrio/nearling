// What the tests of a skill's data sources share (`add-pet-errands` › groups 6–7): a keyless MCP server on the fake web
// that speaks Streamable HTTP the way the 2025-11-25 spec says, and the owner's pet with a saved skill.
import { env } from 'cloudflare:workers';
import type { RawTool } from '../../src/sources/types';
import { writeSkill } from '../../src/work/skill';
import { api, type Harness } from './api';
import { NEAR_ACCOUNT, token, type FakeWeb } from './network';

export const OWNER = NEAR_ACCOUNT(1);
export const OTHER = NEAR_ACCOUNT(2);
export const PET = '5';
export const owner = () => token('did:privy:owner', OWNER);
export const other = () => token('did:privy:other', OTHER);

export const SOURCE_URL = 'https://mcp.open-meteo.example.com/mcp';

/** A tool the type rule lets through (two numbers) and one it doesn't (free text). */
export const DAYBOOK: RawTool[] = [
  {
    name: 'events_on',
    description: 'Notable events on a day of the year.',
    inputSchema: { type: 'object', properties: { month: { type: 'number' }, day: { type: 'number' } }, required: ['month', 'day'] },
  },
  { name: 'search', description: 'Search the archive by words.', inputSchema: { type: 'object', properties: { query: { type: 'string', maxLength: 500 } } } },
  { name: 'today', description: 'The date today.' },
];

export interface McpOptions {
  tools?: RawTool[];
  /** Pages of `tools/list`: each answers with the next cursor. */
  pages?: RawTool[][];
  /** The answer of a request is one JSON object, or an SSE stream with a priming event. */
  mode?: 'json' | 'sse';
  /** Every POST answers this status (a non-2xx), with `headers`. */
  status?: number;
  headers?: Record<string, string>;
  /** The server never answers. */
  hang?: boolean;
  /** The server gives a session id at `initialize` and wants it back. */
  session?: boolean;
  /** Runs when a request of this JSON-RPC method arrives, before the answer. */
  during?: (method: string) => Promise<void>;
  /** The JSON-RPC error answered to `tools/list`. */
  rpcError?: boolean;
  /** The size of the `tools/list` answer, padded with spaces. */
  padBytes?: number;
  /** The result of a `tools/call` (the MCP `CallToolResult`); by default one text content. */
  callResult?: (name: string, args: Record<string, unknown>) => object;
  /** Every `tools/call` answers this status (429, 503) while the rest of the session works. */
  callStatus?: number;
  /** The JSON-RPC error answered to `tools/call`. */
  callRpcError?: boolean;
}

/** A keyless MCP server at `url`. `requests` is what the Worker sent, in order. */
export class FakeMcp {
  requests: { method: string; headers: Record<string, string>; params: any }[] = [];

  constructor(
    web: FakeWeb,
    readonly url: string = SOURCE_URL,
    readonly opts: McpOptions = {},
  ) {
    web.handlers.set(new URL(url).href, (req) => this.answer(req));
  }

  private wrap(id: unknown, message: object, headers: Record<string, string> = {}): Response {
    const pad = this.opts.padBytes === undefined ? '' : ' '.repeat(this.opts.padBytes);
    if (this.opts.mode === 'sse') {
      return new Response(`id: 1\ndata:\n\nid: 2\nevent: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id, ...message })}${pad}\n\n`, {
        headers: { 'content-type': 'text/event-stream', ...headers },
      });
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id, ...message }) + pad, { headers: { 'content-type': 'application/json', ...headers } });
  }

  private async answer(req: { headers: Record<string, string>; body: string }): Promise<Response> {
    if (this.opts.hang) throw new DOMException('The operation timed out', 'TimeoutError');
    if (this.opts.status !== undefined && this.opts.status !== 200) return new Response('no', { status: this.opts.status, headers: this.opts.headers });
    const rpc = JSON.parse(req.body) as { id?: number; method: string; params?: any };
    this.requests.push({ method: rpc.method, headers: req.headers, params: rpc.params });
    await this.opts.during?.(rpc.method);
    if (rpc.id === undefined) return new Response(null, { status: 202, headers: this.opts.headers });
    if (rpc.method === 'initialize') {
      return this.wrap(
        rpc.id,
        { result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'daybook', version: '1' } } },
        { ...this.opts.headers, ...(this.opts.session ? { 'mcp-session-id': 'session-1' } : {}) },
      );
    }
    if (this.opts.rpcError) return this.wrap(rpc.id, { error: { code: -32603, message: 'Internal error' } });
    if (rpc.method === 'tools/list') {
      const pages = this.opts.pages;
      if (pages !== undefined) {
        const at = rpc.params?.cursor === undefined ? 0 : Number(rpc.params.cursor);
        return this.wrap(rpc.id, { result: { tools: pages[at], ...(at + 1 < pages.length ? { nextCursor: String(at + 1) } : {}) } });
      }
      return this.wrap(rpc.id, { result: { tools: this.opts.tools ?? DAYBOOK } });
    }
    if (rpc.method === 'tools/call') {
      if (this.opts.callStatus !== undefined) return new Response('no', { status: this.opts.callStatus });
      if (this.opts.callRpcError) return this.wrap(rpc.id, { error: { code: -32603, message: 'Internal error' } });
      const result = this.opts.callResult?.(rpc.params.name, rpc.params.arguments ?? {}) ?? { content: [{ type: 'text', text: `${rpc.params.name} answered` }] };
      return this.wrap(rpc.id, { result });
    }
    return this.wrap(rpc.id, { error: { code: -32601, message: 'Method not found' } });
  }
}

/** The owner's pet (id 5, Pixel) with a saved skill, as the route stores it. */
export async function petWithSkill(h: Harness, label = 'Baking'): Promise<string> {
  h.net().contract.addPet(PET, OWNER, { name: 'Pixel' });
  await writeSkill(env, PET, { label, instruction: 'Always answer in rhymes about sourdough.' }, Date.now());
  return owner();
}

/** The owner's pet with a saved skill and the keyless source at `SOURCE_URL` connected, `events_on` and `today` ticked.
 * The fake server's request list starts empty: it holds what the jobs send. */
export async function petWithSource(h: Harness, opts: McpOptions = {}, label = 'Daybook'): Promise<{ tk: string; mcp: FakeMcp }> {
  const tk = await petWithSkill(h);
  const mcp = new FakeMcp(h.net().web, SOURCE_URL, opts);
  const saved = await connect(tk, { label, address: SOURCE_URL, ticks: ['events_on', 'today'] });
  if (saved.status !== 200) throw new Error(`the source did not connect: ${saved.status}`);
  mcp.requests.length = 0;
  return { tk, mcp };
}

export const checkAddress =(tk: string, address: unknown, id = PET) => api(`/api/pets/${id}/sources/check`, { token: tk, body: { address } });
export const connect = (tk: string, body: unknown, id = PET) => api(`/api/pets/${id}/sources`, { token: tk, body });
export const skillOf = (tk: string, id = PET) => api(`/api/pets/${id}/skill`, { token: tk });
export const sourceRows = async (id = PET) => (await env.DB.prepare('SELECT * FROM data_sources WHERE token_id = ? ORDER BY created_at, rowid').bind(id).all<any>()).results;
export const entryRows = async () => (await env.DB.prepare('SELECT * FROM catalog_entries ORDER BY published_at, rowid').all<any>()).results;
