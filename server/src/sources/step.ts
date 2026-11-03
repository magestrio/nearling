// The data step of a job (`Adapter call rule`, `Errand request data`, `Hire request data`, ADR-023, ADR-024, ADR-025): one
// non-streamed call of the pet's model (label `data`, `provider_tee`, no reasoning) with the skill's ticked tools and
// code functions as OpenAI `tools`; its `tool_calls`, at most three, are run by the server — a data source through
// `sources/call.ts`, a function of the code through `code/runner.ts` — and what they bring comes back as quoted data for
// the call that answers. The model sees the tools' names, descriptions and parameter types, never an address, a value
// the rule refuses or the code's text. Nothing here logs or tracks a value or an output.
import { claimAndBill } from '../code/caps';
import { runFunction } from '../code/runner';
import { utcDay } from '../http';
import { complete, signatureOf, type Message, type ToolCall } from '../nearai';
import { ceilingPrice, usd12ToMicros } from '../pricing';
import { callsUsd12, hex, projectPays, yoctoMicros, type SignedCall } from '../spend';
import { track } from '../track';
import { openText, SkillUnreadable } from '../work/skill';
import { callSourceTool, checkValues, doorCaller, loadSources, MAX_OUTPUT_CHARS, shapeOf, type CallJob, type LoadedSource } from './call';
import type { StoredTool } from './store';
import type { ToolParam } from './types';
import { MAX_DESCRIPTION } from './limits';

export const DATA_TIMEOUT_MS = 30_000;
/** The data call's own ceiling, in tokens: a few tool calls and nothing else. */
export const DATA_MAX_TOKENS = 200;
/** How many of the model's tool calls run (`Errand request data`); the rest are dropped. */
export const MAX_DATA_CALLS = 3;
/** What the outputs of a job weigh together before the model, in characters (≈ 4,000 tokens, `Errand price data`). */
export const MAX_DATA_CHARS = MAX_OUTPUT_CHARS;
/** A local bound on the tools in the data call's request, in bytes of their JSON: a source's tool list is stored as it
 * came (up to 3 × 256 KB), and a model request must not grow with it. A tool that does not fit is not offered. */
export const MAX_TOOLS_BYTES = 6_000;
const CUT_MARK = ' [cut]';

/** One tool or function the model may call: where it lives and how its values are checked. */
interface Offered {
  /** The name the model calls it by: server-made, so two sources' tools never meet and no label reaches a function name. */
  name: string;
  kind: 'source' | 'code';
  /** The source's label, or the skill's for a function of the code: what a failure is named by. */
  label: string;
  /** The tool's own name at the source, or the function's name in the code. */
  tool: string;
  params: ToolParam[];
  source?: LoadedSource;
}

export interface Offer {
  offered: Offered[];
  /** The OpenAI `tools` array, as sent. */
  tools: unknown[];
  /** Its size once serialized: what the data call's input bound adds to its messages. */
  toolsBytes: number;
  skillLabel: string;
}

function schemaOf(params: ToolParam[]): object {
  const properties: Record<string, object> = {};
  for (const p of params) {
    switch (p.type) {
      case 'number':
      case 'integer':
      case 'boolean':
        properties[p.name] = { type: p.type };
        break;
      case 'pick':
        properties[p.name] = { type: 'string', enum: p.options ?? [] };
        break;
      case 'text':
        properties[p.name] = { type: 'string', maxLength: p.maxLength ?? 64, pattern: '^[A-Za-z0-9._:-]+$' };
        break;
    }
  }
  return { type: 'object', properties, required: params.filter((p) => p.required).map((p) => p.name) };
}

const functionName = (prefix: string, tool: string): string => `${prefix}_${tool.replace(/[^A-Za-z0-9_-]/g, '_')}`.slice(0, 64);

/** The tools of the pet's skill the model may call: the ticked tools of each source (oldest first) and the ticked
 * functions of the code, as far as `MAX_TOOLS_BYTES` allows. `null` when nothing is ticked: no data call is made. */
export async function loadOffer(env: Env, tokenId: string): Promise<Offer | null> {
  const [sources, codeRow, skillRow] = await Promise.all([
    loadSources(env.DB, tokenId),
    env.DB.prepare('SELECT functions FROM skill_code WHERE token_id = ?').bind(tokenId).first<{ functions: string }>(),
    env.DB.prepare('SELECT label FROM skills WHERE token_id = ?').bind(tokenId).first<{ label: string }>(),
  ]);
  const skillLabel = skillRow?.label ?? '';
  const candidates: { offered: Offered; description: string }[] = [];
  sources.forEach((source, i) => {
    for (const tool of source.tools.filter((t) => t.ticked)) {
      candidates.push({ offered: { name: functionName(`s${i + 1}`, tool.name), kind: 'source', label: source.label, tool: tool.name, params: tool.params, source }, description: `${source.label}: ${tool.description}` });
    }
  });
  if (codeRow !== null) {
    for (const fn of (JSON.parse(codeRow.functions) as StoredTool[]).filter((f) => f.ticked)) {
      candidates.push({ offered: { name: functionName('code', fn.name), kind: 'code', label: skillLabel, tool: fn.name, params: fn.params }, description: fn.description });
    }
  }
  const offered: Offered[] = [];
  const tools: unknown[] = [];
  let toolsBytes = 0;
  for (const { offered: o, description } of candidates) {
    const tool = { type: 'function', function: { name: o.name, description: description.slice(0, MAX_DESCRIPTION), parameters: schemaOf(o.params) } };
    const bytes = new TextEncoder().encode(JSON.stringify(tool)).length;
    if (toolsBytes + bytes > MAX_TOOLS_BYTES || offered.some((x) => x.name === o.name)) continue;
    offered.push(o);
    tools.push(tool);
    toolsBytes += bytes;
  }
  return offered.length === 0 ? null : { offered, tools, toolsBytes, skillLabel };
}

/** What one tool call brought. */
export interface Read {
  /** The source's label, or the skill's for a function of the code. */
  label: string;
  /** True for a data source: someone else runs it and sees what was looked up (`Adapter call rule` › «advice line»). */
  source: boolean;
  text: string;
}

export type Step =
  // The 402 of the services: the caller notes the pause.
  | { kind: 'paused' }
  // The data call did not come — a wait that ran out, a refusal, no signature: the project paid what it cost, the caller goes on without it.
  | { kind: 'lost' }
  | { kind: 'ran'; call: SignedCall; reads: Read[]; failed: string[]; failedSources: string[]; codeFailed: boolean };

export interface StepArgs {
  tokenId: string;
  job: Exclude<CallJob, 'test'>;
  /** The data call's messages: the pet's layers, its skill and the question; the tools ride beside them. */
  messages: Message[];
  /** The ceiling of the data call, ≤ 200 and under what the caller's budget allows. */
  maxTokens: number;
  /** The input bound of the whole request (messages and tools), for what a call that timed out may have cost. */
  bound: number;
}

/** The data call and the calls it asked for. A function that fails, a source that does not answer and a value the rule
 * refuses are `failed` by label; what answered is in `reads`, cut so that all of it together fits `MAX_DATA_CHARS`. */
export async function runDataStep(env: Env, offer: Offer, a: StepArgs): Promise<Step> {
  // The pet has a skill, so the request carries a one-time value and its bytes are kept nowhere (`Skilled answer data`).
  const result = await complete(env, {
    messages: a.messages,
    maxTokens: a.maxTokens,
    thinking: false,
    timeoutMs: DATA_TIMEOUT_MS,
    extra: { tools: offer.tools, tool_choice: 'auto', nonce: hex(crypto.getRandomValues(new Uint8Array(16))) },
  });
  if (result.kind === 'paused') return { kind: 'paused' };
  if (result.kind === 'timeout') {
    // the call may still be billed: the project pays it at its bound
    await projectPays(env, 'no_thought', yoctoMicros(env, ceilingPrice(env, a.bound, a.maxTokens)));
    console.log('ai_timeout');
    return { kind: 'lost' };
  }
  if (result.kind === 'failed') {
    console.log(`ai_failed:${result.status}`);
    return { kind: 'lost' };
  }
  const signed = await signatureOf(env, result);
  if (signed === null) {
    console.log('signature_missing');
    await projectPays(env, 'no_thought', usd12ToMicros(callsUsd12(env, [result])));
    return { kind: 'lost' };
  }

  const ran = await Promise.all(result.toolCalls.slice(0, MAX_DATA_CALLS).map((call) => runOne(env, offer, call, a)));
  const reads: Read[] = [];
  const failed: string[] = [];
  // an errand names a source that did not answer by its label and the skill's code by the pet (`Adapter call rule` › «data failed in an errand, code»)
  const failedSources: string[] = [];
  let codeFailed = false;
  for (const one of ran) {
    if (one === null) continue;
    if (one.ok) reads.push(one.read);
    else {
      if (!failed.includes(one.label)) failed.push(one.label);
      if (one.code) codeFailed = true;
      else if (!failedSources.includes(one.label)) failedSources.push(one.label);
    }
  }
  const share = reads.length === 0 ? MAX_DATA_CHARS : Math.floor(MAX_DATA_CHARS / reads.length);
  for (const read of reads) if (read.text.length > share) read.text = read.text.slice(0, share) + CUT_MARK;
  return { kind: 'ran', call: { answer: result, signed }, reads, failed, failedSources, codeFailed };
}

type One = { ok: true; read: Read } | { ok: false; label: string; code: boolean };

/** One tool call of the model. `null` for a name nobody offered: there is nothing to call and nothing to blame. */
async function runOne(env: Env, offer: Offer, call: ToolCall, a: StepArgs): Promise<One | null> {
  const offered = offer.offered.find((o) => o.name === call.name);
  if (offered === undefined) {
    // A function the saved code's declaration does not hold (`Skill code data` › «an undeclared function in a job»): nothing
    // loads, the job fails like any data failure. Any other name nobody offered is noise, dropped with no blame.
    if (call.name.startsWith('code_')) {
      console.log('code_undeclared');
      return { ok: false, label: offer.skillLabel, code: true };
    }
    console.log('data_tool_unknown');
    return null;
  }
  let given: unknown;
  try {
    given = call.arguments.trim() === '' ? {} : JSON.parse(call.arguments);
  } catch {
    given = null;
  }
  if (offered.kind === 'source') {
    const called = await callSourceTool(env, offered.source!, offered.tool, given, a.job);
    return called.ok ? { ok: true, read: { label: offered.label, source: true, text: called.output } } : { ok: false, label: offered.label, code: false };
  }
  const text = await runCode(env, a.tokenId, offered, given, a.job);
  return text === null ? { ok: false, label: offered.label, code: true } : { ok: true, read: { label: offered.label, source: false, text } };
}

/** A function of the skill's code run for a job (`Skill code data`): the version is claimed first — past the game's daily
 * cap it fails like a busy source — then run with positional arguments in the declared order. `null` is a failure. */
async function runCode(env: Env, tokenId: string, fn: Offered, given: unknown, job: Exclude<CallJob, 'test'>): Promise<string | null> {
  const values = checkValues(fn.params, given);
  if (values === null) return null;
  const row = await env.DB.prepare('SELECT ct, iv, hash FROM skill_code WHERE token_id = ?').bind(tokenId).first<{ ct: ArrayLike<number>; iv: ArrayLike<number>; hash: string }>();
  if (row === null) return null;
  let code: string;
  try {
    code = await openText(env, `${tokenId}:code`, row);
  } catch (e) {
    if (!(e instanceof SkillUnreadable)) throw e;
    console.log('skill_unreadable');
    return null;
  }
  const version = `${tokenId}:${row.hash}`;
  if ((await claimAndBill(env, utcDay(Date.now()), version)) === 'capped') {
    console.log('code_capped');
    track('skill_code_ran', { outcome: 'capped', job });
    return null;
  }
  const result = await runFunction(env, version, code, fn.tool, fn.params.map((p) => values[p.name] ?? null), await shapeOf(env.DB, tokenId), doorCaller(env, tokenId, job));
  console.log(`code_run:${result.outcome}`);
  track('skill_code_ran', { outcome: result.outcome, job });
  if (result.outcome !== 'ok') return null;
  return result.output.length >= MAX_OUTPUT_CHARS ? result.output + CUT_MARK : result.output;
}

/** The labels of the data sources among what was read, once each, for the thought's `data_labels` and the line under an
 * answer (a function of the code runs on Cloudflare and has no host to name). */
export const sourceLabelsOf = (reads: Read[]): string[] => [...new Set(reads.filter((r) => r.source).map((r) => r.label))];

/** The reads as numbered data for the request that answers, from `first`. */
export const numbered = (reads: Read[], first = 1): { n: number; from: string; text: string }[] => reads.map((r, i) => ({ n: first + i, from: r.label, text: r.text }));
