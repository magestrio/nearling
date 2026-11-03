// The Worker as an MCP client for a data source (`Adapter connect flow`, `Data source call data`, ADR-024): JSON-RPC 2.0
// over Streamable HTTP, protocol 2025-11-25, written by hand (no SDK: four calls cover it). One session lives for one
// job: `initialize`, `notifications/initialized`, then the call. Every POST waits ≤ 5 s and reads ≤ 256 KB; the host
// is checked before the first request and before each of ≤ 3 redirects, and a redirect to another host is refused.
// Nothing here logs or returns an address, a value or an output.
import { publicHost } from '../errands/reader';
import type { RawTool } from './types';

/** How a call to a source ended without an answer. `key`: the source asks for a key or a login (never saved). */
export type McpFailure = 'busy' | 'slow' | 'down' | 'key';

export class McpError extends Error {
  constructor(readonly failure: McpFailure) {
    super(failure);
  }
}

const PROTOCOL = '2025-11-25';
const TIMEOUT_MS = 5_000;
const MAX_BYTES = 256 * 1024;
const MAX_REDIRECTS = 3;
const MAX_PAGES = 3;

/** The address as the game takes it (`Adapter connect flow` › «address didn't answer»): `https://host/path`, no
 * userinfo, no query, no fragment. A bare `https://host` is its root path. */
export function addressOf(text: string): URL | null {
  if (text !== text.trim() || /\s/.test(text)) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '' || url.hostname === '') return null;
  // a trailing `?` or `#` with nothing after it still counts as a query or a fragment
  if (text.includes('?') || text.includes('#')) return null;
  return url;
}

const isTimeout = (e: unknown): boolean => e instanceof DOMException && (e.name === 'TimeoutError' || e.name === 'AbortError');

/** The body up to `MAX_BYTES`; over that the call is a failure. */
async function readBody(res: Response, until?: (text: string) => boolean): Promise<string> {
  const reader = res.body?.getReader();
  if (reader === undefined) return '';
  const decoder = new TextDecoder();
  let text = '';
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_BYTES) {
      await reader.cancel();
      throw new McpError('down');
    }
    text += decoder.decode(value, { stream: true });
    // an SSE stream may stay open after its answer: stop when the answer is in
    if (until?.(text) === true) {
      await reader.cancel();
      break;
    }
  }
  return text;
}

type RpcMessage = { jsonrpc?: string; id?: unknown; result?: unknown; error?: unknown };

/** The JSON-RPC messages of an SSE body: the `data` lines of each event, joined, parsed. */
function sseMessages(text: string): RpcMessage[] {
  const out: RpcMessage[] = [];
  for (const event of text.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n');
    if (data === '') continue;
    try {
      const parsed = JSON.parse(data) as RpcMessage | RpcMessage[];
      out.push(...(Array.isArray(parsed) ? parsed : [parsed]));
    } catch {
      // a partial event at the end of what was read so far
    }
  }
  return out;
}

const isAnswer = (m: RpcMessage, id: number): boolean => m.id === id && (m.result !== undefined || m.error !== undefined);

/** One MCP session with one source. */
export class McpSession {
  private nextId = 1;
  private sessionId: string | null = null;
  private version = PROTOCOL;

  /** `deadline`: one signal for the whole session, so a call in a job (`initialize`, the notice and `tools/call`) waits
   * 5 s in all, not 5 s a request (`Data source call data`). */
  constructor(
    private readonly address: URL,
    private readonly deadline?: AbortSignal,
  ) {}

  /** One POST with the manual redirects. The answer of a non-2xx is a failure; `WWW-Authenticate`, 401 and 403 are a key. */
  private async post(body: unknown): Promise<Response> {
    const each = AbortSignal.timeout(TIMEOUT_MS);
    const signal = this.deadline === undefined ? each : AbortSignal.any([each, this.deadline]);
    const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': this.version };
    if (this.sessionId !== null) headers['mcp-session-id'] = this.sessionId;
    const payload = JSON.stringify(body);
    let target = this.address;
    try {
      for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
        if (target.protocol !== 'https:' || target.hostname !== this.address.hostname) throw new McpError('down');
        if (!(await publicHost(target.hostname, signal))) throw new McpError('down');
        const res = await fetch(target.href, { method: 'POST', redirect: 'manual', headers, body: payload, signal });
        if (res.status >= 300 && res.status < 400) {
          const next = res.headers.get('location');
          await res.body?.cancel();
          if (next === null) throw new McpError('down');
          target = new URL(next, target);
          continue;
        }
        if (res.status === 401 || res.status === 403 || res.headers.has('www-authenticate')) {
          await res.body?.cancel();
          throw new McpError('key');
        }
        if (res.status === 429 || res.status === 503) {
          await res.body?.cancel();
          throw new McpError('busy');
        }
        if (!res.ok) {
          await res.body?.cancel();
          throw new McpError('down');
        }
        return res;
      }
      throw new McpError('down');
    } catch (e) {
      if (e instanceof McpError) throw e;
      throw new McpError(isTimeout(e) ? 'slow' : 'down');
    }
  }

  /** A request: the JSON-RPC result, or a failure. An answer that is a JSON-RPC error is `down` while the source is
   * tested (`busy` for a source that says it is overloaded is not a code MCP defines) and `busy` in a job, where
   * `rpcError` says so (`Data source call data`). */
  private async request(method: string, params: unknown, rpcError: McpFailure = 'down'): Promise<unknown> {
    const id = this.nextId++;
    const res = await this.post({ jsonrpc: '2.0', id, method, params });
    const session = res.headers.get('mcp-session-id');
    if (session !== null && this.sessionId === null && method === 'initialize') this.sessionId = session;
    try {
      const type = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
      let answer: RpcMessage | undefined;
      if (type === 'text/event-stream') {
        const text = await readBody(res, (so) => sseMessages(so).some((m) => isAnswer(m, id)));
        answer = sseMessages(text).find((m) => isAnswer(m, id));
      } else if (type === 'application/json') {
        const parsed = JSON.parse(await readBody(res)) as RpcMessage | RpcMessage[];
        answer = (Array.isArray(parsed) ? parsed : [parsed]).find((m) => isAnswer(m, id));
      } else {
        await res.body?.cancel();
        throw new McpError('down');
      }
      if (answer === undefined) throw new McpError('down');
      if (answer.error !== undefined) throw new McpError(rpcError);
      return answer.result;
    } catch (e) {
      if (e instanceof McpError) throw e;
      throw new McpError(isTimeout(e) ? 'slow' : 'down');
    }
  }

  private async notify(method: string): Promise<void> {
    const res = await this.post({ jsonrpc: '2.0', method });
    await res.body?.cancel();
  }

  /** `initialize` and `notifications/initialized`. */
  async open(): Promise<void> {
    const result = (await this.request('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'nearling', version: '1' } })) as {
      protocolVersion?: unknown;
    } | null;
    // the server answers the version it speaks; later requests carry it
    if (result !== null && typeof result === 'object' && typeof result.protocolVersion === 'string') this.version = result.protocolVersion;
    await this.notify('notifications/initialized');
  }

  /** The tools of the source, ≤ 3 pages by `cursor`. */
  async tools(): Promise<RawTool[]> {
    const tools: RawTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const result = (await this.request('tools/list', cursor === undefined ? {} : { cursor })) as { tools?: unknown; nextCursor?: unknown } | null;
      if (result === null || typeof result !== 'object' || !Array.isArray(result.tools)) throw new McpError('down');
      for (const tool of result.tools) if (typeof tool === 'object' && tool !== null) tools.push(tool as RawTool);
      if (typeof result.nextCursor !== 'string' || result.nextCursor === '') break;
      cursor = result.nextCursor;
    }
    return tools;
  }

  /** One `tools/call`: the output as text — `structuredContent` as JSON, else the `text` contents joined by a line break.
   * A JSON-RPC error and `isError` are `busy`: the source did not do what was asked. */
  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const result = (await this.request('tools/call', { name, arguments: args }, 'busy')) as { content?: unknown; structuredContent?: unknown; isError?: unknown } | null;
    if (result === null || typeof result !== 'object') throw new McpError('down');
    if (result.isError === true) throw new McpError('busy');
    if (result.structuredContent !== undefined && result.structuredContent !== null) return JSON.stringify(result.structuredContent);
    if (!Array.isArray(result.content)) throw new McpError('down');
    return result.content
      .filter((part): part is { type: string; text: string } => typeof part === 'object' && part !== null && (part as { type?: unknown }).type === 'text' && typeof (part as { text?: unknown }).text === 'string')
      .map((part) => part.text)
      .join('\n');
  }
}

/** The test call: `initialize` + `tools/list` on a source's address. Throws `McpError`; nothing is kept. */
export async function listTools(address: URL): Promise<RawTool[]> {
  const session = new McpSession(address);
  await session.open();
  return session.tools();
}
