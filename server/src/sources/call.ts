// A job calls a data source (`Data source call data`, `Adapter call rule`, ADR-024): only a ticked tool of this pet's own
// skill, with values that pass the value rule, from the server. The order is the rule, then the read cache, then the
// MCP `tools/call` within 5 s. The output is cut at 16,000 characters and marked; a failure keeps nothing. Nothing here
// logs or tracks an address, a value or an output: only the outcome and the job.
import { sha256Hex } from '../nearai';
import { track } from '../track';
import { addressOf, McpError, McpSession } from './mcp';
import { MAX_OUTPUT_CHARS } from './limits';
import { openAddress, type StoredTool } from './store';
import type { ToolParam } from './types';
import type { Shape } from '../code/runner';
import { SkillUnreadable } from '../work/skill';

/** How a call ended: `ok` it answered, `cached` the cache answered, `refused` the values broke the rule and nothing went. */
export type SourceOutcome = 'ok' | 'cached' | 'busy' | 'slow' | 'down' | 'refused';
export type Failure = Exclude<SourceOutcome, 'ok' | 'cached'>;
/** Whose job calls: a test run of the code logs no `adapter_called` (`Data source call data` › «data source called»). */
export type CallJob = 'hire' | 'advice' | 'errand' | 'chat' | 'test';

export const CALL_WAIT_MS = 5_000;
/** One output, in characters (≈ 4,000 tokens). */
export { MAX_OUTPUT_CHARS } from './limits';
const CUT_MARK = ' [cut]';
const VALUE = /^[A-Za-z0-9._:-]{1,64}$/;

export type Called = { ok: true; output: string; cached: boolean } | { ok: false; outcome: Failure };

export interface LoadedSource {
  id: string;
  label: string;
  tools: StoredTool[];
  /** The sealed address, opened only when a call goes out. */
  row: { token_id: string; id: string; addr_ct: ArrayLike<number> | ArrayBuffer; addr_iv: ArrayLike<number> | ArrayBuffer };
}

/** The pet's sources, oldest first, with the tools as tested and ticked. */
export async function loadSources(db: D1Database, tokenId: string): Promise<LoadedSource[]> {
  const rows = await db
    .prepare('SELECT id, token_id, label, addr_ct, addr_iv, tools FROM data_sources WHERE token_id = ? ORDER BY created_at, rowid')
    .bind(tokenId)
    .all<LoadedSource['row'] & { label: string; tools: string }>();
  return rows.results.map((r) => ({ id: r.id, label: r.label, tools: JSON.parse(r.tools) as StoredTool[], row: r }));
}

/** What the code may reach: each source's name with its ticked tools. */
export async function shapeOf(db: D1Database, tokenId: string): Promise<Shape> {
  const shape: Shape = {};
  for (const source of await loadSources(db, tokenId)) shape[source.label] = source.tools.filter((t) => t.ticked).map((t) => t.name);
  return shape;
}

/** The value rule, for a tool of a source and a function of the code alike: a number, a boolean, a pick from the list, or
 * 1–64 characters of letters, digits and `. _ - :`. The values come back as given, only when every one passes, every
 * declared one the tool requires is there, and none is a name the tool does not take. `null` is a refusal. */
export function checkValues(params: ToolParam[], given: unknown): Record<string, unknown> | null {
  if (typeof given !== 'object' || given === null || Array.isArray(given)) return null;
  const values = given as Record<string, unknown>;
  for (const name of Object.keys(values)) if (!params.some((p) => p.name === name)) return null;
  for (const param of params) {
    if (!Object.hasOwn(values, param.name)) {
      if (param.required) return null;
      continue;
    }
    if (!fits(param, values[param.name])) return null;
  }
  return values;
}

function fits(param: ToolParam, value: unknown): boolean {
  switch (param.type) {
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'pick':
      return (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') && (param.options ?? []).includes(String(value));
    case 'text':
      return typeof value === 'string' && VALUE.test(value) && (param.maxLength === undefined || value.length <= param.maxLength);
  }
}

/** The values as one string whatever the order the model wrote them in. */
const canonical = (values: Record<string, unknown>): string => JSON.stringify(Object.keys(values).sort().map((k) => [k, values[k]]));

const done = (job: CallJob, outcome: SourceOutcome): void => {
  console.log(`source_call:${outcome}`);
  if (job !== 'test') track('adapter_called', { outcome, job });
};

const fail = (job: CallJob, outcome: Failure): Called => {
  done(job, outcome);
  return { ok: false, outcome };
};

/** One call of `toolName` on `source` for a job. */
export async function callSourceTool(env: Env, source: LoadedSource, toolName: string, given: unknown, job: CallJob): Promise<Called> {
  const tool = source.tools.find((t) => t.name === toolName && t.ticked);
  const values = tool === undefined ? null : checkValues(tool.params, given);
  if (tool === undefined || values === null) return fail(job, 'refused');

  let address: URL | null;
  try {
    address = addressOf(await openAddress(env, source.row));
  } catch (e) {
    if (!(e instanceof SkillUnreadable)) throw e;
    console.log('skill_unreadable');
    return fail(job, 'down');
  }
  if (address === null) return fail(job, 'down');

  // Keyed by what was asked, never kept anywhere else: a read of the last minute answers again at no call.
  const key = await sha256Hex(new TextEncoder().encode(`${address.href}\n${toolName}\n${canonical(values)}`));
  const cache = env.SOURCE_CACHE.get(env.SOURCE_CACHE.idFromName('reads'));
  const hit = await cache.get(key).catch(() => null);
  if (hit !== null) {
    done(job, 'cached');
    return { ok: true, output: hit, cached: true };
  }

  const wait = AbortSignal.timeout(CALL_WAIT_MS);
  try {
    const session = new McpSession(address, wait);
    await session.open();
    const text = await session.callTool(toolName, values);
    const output = text.length > MAX_OUTPUT_CHARS ? text.slice(0, MAX_OUTPUT_CHARS) + CUT_MARK : text;
    await cache.put(key, output).catch(() => undefined);
    done(job, 'ok');
    return { ok: true, output, cached: false };
  } catch (e) {
    // a source that wants a key is, for a job, a source that is down
    const failure = e instanceof McpError ? e.failure : wait.aborted ? 'slow' : 'down';
    return fail(job, failure === 'key' ? 'down' : failure);
  }
}

/** The door of the skill's code in a job: finds the ticked tool of the named source and returns its output parsed (JSON
 * when it is, else the text). A failure throws the outcome, which the code sees as a source that did not answer. */
export function doorCaller(env: Env, tokenId: string, job: CallJob): (source: string, tool: string, values: Record<string, unknown>) => Promise<unknown> {
  let loaded: LoadedSource[] | undefined;
  return async (label, tool, values) => {
    loaded ??= await loadSources(env.DB, tokenId);
    const source = loaded.find((s) => s.label === label && s.tools.some((t) => t.name === tool && t.ticked));
    if (source === undefined) throw new Error('refused');
    const called = await callSourceTool(env, source, tool, values, job);
    if (!called.ok) throw new Error(called.outcome);
    try {
      return JSON.parse(called.output) as unknown;
    } catch {
      return called.output;
    }
  };
}
