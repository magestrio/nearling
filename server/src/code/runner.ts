// Running a skill's code (`Skill code flow`, `Skill code data`, ADR-025): one Cloudflare Dynamic Worker per code version,
// `LOADER.get("<token_id>:<sha-256 of the code>")`, with no network (`globalOutbound: null`), no binding and no secret.
// The one way out is the door below: an RPC target of ours that calls this skill's ticked data-source tools. Limits per
// run: ≤ 50 ms CPU (the platform's, on the deployed Worker only), ≤ 6 door calls, ≤ 5 s by our own timer, an output of
// ≤ 16,000 characters. Nothing here logs or returns the code, a value or an output beyond the caller's own result.
import { RpcTarget } from 'cloudflare:workers';
import { MAX_OUTPUT_CHARS } from '../sources/limits';

export const MAX_CODE_BYTES = 32 * 1024;
export const MAX_DOOR_CALLS = 6;
export const RUN_TIMEOUT_MS = 5_000;
export { MAX_OUTPUT_CHARS } from '../sources/limits';
const CPU_MS = 50;
const MAX_ERROR_CHARS = 2_000;

/** How a run ended. `limit`: CPU, the 7th door call or 5 s. `error`: a throw, a refused tool, `fetch`/`connect`, a module
 * that doesn't load. */
export type RunOutcome = 'ok' | 'limit' | 'error';

/** The door's job: a ticked tool of this skill's source, called with the code's values; its parsed output, or a throw. */
export type ToolCaller = (source: string, tool: string, values: Record<string, unknown>) => Promise<unknown>;

/** The source labels of the skill with the tools the owner ticked: all the code can reach. */
export type Shape = Record<string, string[]>;

export type Declared = { ok: true; declaration: unknown } | { ok: false; message: string };
export type RunResult = { outcome: 'ok'; output: string } | { outcome: 'limit' } | { outcome: 'error'; message: string };

class Door extends RpcTarget {
  calls = 0;
  limited = false;
  refused = false;

  constructor(
    private readonly shape: Shape,
    private readonly caller: ToolCaller,
  ) {
    super();
  }

  /** The code catching a refusal doesn't hide it: the run is still judged by what the door saw. */
  async call(source: string, tool: string, values: unknown): Promise<unknown> {
    if (this.calls >= MAX_DOOR_CALLS) {
      this.limited = true;
      throw new Error(`more than ${MAX_DOOR_CALLS} calls to data sources`);
    }
    this.calls += 1;
    if (!Object.hasOwn(this.shape, source) || !this.shape[source]!.includes(tool)) {
      this.refused = true;
      throw new Error('that tool is not ticked on this skill');
    }
    const object = typeof values === 'object' && values !== null && !Array.isArray(values) ? (values as Record<string, unknown>) : {};
    try {
      return await this.caller(source, tool, object);
    } catch (e) {
      // the code sees that the source didn't answer, never why or from where
      throw new Error(e instanceof Error && e.message !== '' ? `the data source did not answer (${e.message})` : 'the data source did not answer');
    }
  }
}

/** The module the isolate runs first: ours and public. It reads the owner's module, installs `sources` for the run (per
 * run, through AsyncLocalStorage: two runs of one version at once keep their own door) and calls the named export. */
const WRAPPER = `
import { WorkerEntrypoint } from "cloudflare:workers";
import { AsyncLocalStorage } from "node:async_hooks";
const store = new AsyncLocalStorage();
Object.defineProperty(globalThis, "sources", { get: () => store.getStore(), configurable: true });
let loaded;
const skill = () => (loaded ??= import("./skill.js"));
function fail(e) {
  const stack = String((e && e.stack) || "").split("\\n").filter((line) => line.includes("skill.js")).join("\\n");
  return { ok: false, name: String((e && e.name) || "Error"), message: String((e && e.message) || e), stack };
}
export class Run extends WorkerEntrypoint {
  async declared() {
    try {
      const m = await skill();
      return { ok: true, functions: JSON.stringify(m.functions === undefined ? {} : m.functions) };
    } catch (e) {
      return fail(e);
    }
  }
  async run(fn, args, shape, door) {
    try {
      const m = await skill();
      const f = m[fn];
      if (fn === "functions" || typeof f !== "function") throw new TypeError(fn + " is not a function");
      const sources = {};
      for (const [label, tools] of Object.entries(shape)) {
        const one = {};
        for (const tool of tools) one[tool] = (values) => door.call(label, tool, values === undefined ? {} : values);
        sources[label] = one;
      }
      const result = await store.run(sources, () => f(...args));
      return { ok: true, output: JSON.stringify(result === undefined ? null : result) };
    } catch (e) {
      return fail(e);
    }
  }
}
`;

interface RunEntrypoint {
  declared(): Promise<{ ok: true; functions: string } | { ok: false; name: string; message: string; stack: string }>;
  run(fn: string, args: unknown[], shape: Shape, door: Door): Promise<{ ok: true; output: string } | { ok: false; name: string; message: string; stack: string }>;
}

const entrypoint = (env: Pick<Env, 'LOADER'>, version: string, code: string): RunEntrypoint =>
  env.LOADER.get(version, () => ({
    compatibilityDate: '2026-10-01',
    compatibilityFlags: ['nodejs_compat'],
    mainModule: 'run.js',
    modules: { 'run.js': WRAPPER, 'skill.js': code },
    globalOutbound: null,
    limits: { cpuMs: CPU_MS },
  })).getEntrypoint('Run') as unknown as RunEntrypoint;

/** `name: message` and the stack lines of the owner's module, ≤ 2,000 characters (`Skill code flow` › «code error»). */
function errorText(e: { name: string; message: string; stack: string }): string {
  return [`${e.name}: ${e.message}`, ...(e.stack === '' ? [] : [e.stack])].join('\n').slice(0, MAX_ERROR_CHARS);
}

/** The platform stops a run past its CPU with an error of its own; the Worker's timer and the door say the rest. */
const isLimitError = (e: unknown): boolean => e instanceof Error && /exceeded (its )?(cpu|memory)|cpu time limit|too many subrequests/i.test(e.message);

async function within<T>(work: Promise<T>, ms: number): Promise<{ done: T } | 'late'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<'late'>((resolve) => {
    timer = setTimeout(() => resolve('late'), ms);
  });
  try {
    return await Promise.race([work.then((done) => ({ done })), late]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** The functions the module declares, as plain data. `limit` and `error` end the same way a run does. */
export async function readDeclaration(
  env: Pick<Env, 'LOADER'>,
  version: string,
  code: string,
  timeoutMs = RUN_TIMEOUT_MS,
): Promise<{ outcome: 'ok'; declaration: unknown } | { outcome: 'limit' } | { outcome: 'error'; message: string }> {
  try {
    const got = await within(entrypoint(env, version, code).declared(), timeoutMs);
    if (got === 'late') return { outcome: 'limit' };
    if (!got.done.ok) return { outcome: 'error', message: errorText(got.done) };
    return { outcome: 'ok', declaration: JSON.parse(got.done.functions) as unknown };
  } catch (e) {
    return isLimitError(e) ? { outcome: 'limit' } : { outcome: 'error', message: `Error: ${e instanceof Error ? e.message : 'the code did not load'}`.slice(0, MAX_ERROR_CHARS) };
  }
}

/** One run of an exported function with positional arguments. */
export async function runFunction(
  env: Pick<Env, 'LOADER'>,
  version: string,
  code: string,
  fn: string,
  args: unknown[],
  shape: Shape,
  caller: ToolCaller,
  timeoutMs = RUN_TIMEOUT_MS,
): Promise<RunResult> {
  const door = new Door(shape, caller);
  let result: RunResult;
  try {
    const got = await within(entrypoint(env, version, code).run(fn, args, shape, door), timeoutMs);
    if (got === 'late') result = { outcome: 'limit' };
    else if (!got.done.ok) result = { outcome: 'error', message: errorText(got.done) };
    else result = { outcome: 'ok', output: got.done.output.slice(0, MAX_OUTPUT_CHARS) };
  } catch (e) {
    result = isLimitError(e) ? { outcome: 'limit' } : { outcome: 'error', message: `Error: ${e instanceof Error ? e.message : 'the code stopped'}`.slice(0, MAX_ERROR_CHARS) };
  }
  // the door's own verdict wins over a code that caught what it was told
  if (door.limited) return { outcome: 'limit' };
  if (door.refused) return { outcome: 'error', message: result.outcome === 'error' ? result.message : 'Error: that tool is not ticked on this skill' };
  return result;
}
