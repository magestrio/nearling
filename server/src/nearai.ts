// NEAR AI Cloud, the only caller (near-ai › For the build): one non-streamed chat completion, the
// request serialized once and its bytes hashed as sent, the response bytes hashed as received
// before they are parsed, and the model's signature fetched before the answer may be shown.
// Nothing here logs a prompt, a memory, a reply or a key.
const BASE = 'https://cloud-api.near.ai/v1';

export type Message = { role: 'system' | 'user' | 'assistant'; content: string };

export interface CallSpec {
  messages: Message[];
  maxTokens: number;
  thinking: boolean;
  /** The wait for the answer, ms: 60 s up to 2,000 tokens, 90 s for «Think hard» (design.md). */
  timeoutMs: number;
  /** Fields of the request body beside the standard ones, merged before the one serialization: a skilled
   * worker's random `nonce` (`Skilled answer data`, ADR-023). */
  extra?: Record<string, unknown>;
}

export interface Signed {
  signature: string;
  sigKind: string;
  signer: string;
}

/** One `tool_calls` entry of an answer: `arguments` is the raw JSON text the model wrote. */
export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export type CallResult =
  | {
      kind: 'answer';
      id: string;
      reqBytes: Uint8Array;
      resBytes: Uint8Array;
      reqSha: string;
      resSha: string;
      content: string;
      finishReason: string;
      tokensIn: number;
      tokensOut: number;
      tokensReasoning: number;
      /** The functions the model asked to call (`tools` in the request), in the order it asked; none otherwise. */
      toolCalls: ToolCall[];
    }
  // 402: the key's spend limit or the prepaid balance (the same pause, Service pause data).
  | { kind: 'paused' }
  // The wait ran out; the call may still be billed, nobody saw its answer.
  | { kind: 'timeout' }
  // Any other refusal or a broken answer (429, 5xx, a body that is not a completion): no tokens known.
  | { kind: 'failed'; status: number };

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The reply of a completion: the content after the last `</think>` (all of it if there is none).
 * A reasoning cut before its `</think>` is no reply: the player never reads the pet's reasoning. */
export function replyOf(content: string): string {
  const end = content.lastIndexOf('</think>');
  if (end === -1) return content.trimStart().startsWith('<think>') ? '' : content;
  return content.slice(end + '</think>'.length);
}

function toolCallsOf(raw: unknown): ToolCall[] {
  if (!Array.isArray(raw)) return [];
  const calls: ToolCall[] = [];
  for (const entry of raw) {
    const fn = entry?.function;
    if (typeof entry?.id === 'string' && typeof fn?.name === 'string') calls.push({ id: entry.id, name: fn.name, arguments: typeof fn.arguments === 'string' ? fn.arguments : '' });
  }
  return calls;
}

export async function complete(env: Pick<Env, 'NEARAI_API_KEY' | 'MODEL_ID'>, spec: CallSpec): Promise<CallResult> {
  const body = {
    model: env.MODEL_ID,
    messages: spec.messages,
    max_tokens: spec.maxTokens,
    stream: false,
    chat_template_kwargs: { enable_thinking: spec.thinking },
    ...spec.extra,
  };
  // Serialized once: these exact bytes are sent and these exact bytes are hashed.
  const reqBytes = new TextEncoder().encode(JSON.stringify(body));
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), spec.timeoutMs);
  try {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.NEARAI_API_KEY}`,
        'content-type': 'application/json',
        'x-no-aliasing': 'true',
        'accept-encoding': 'identity',
      },
      body: reqBytes,
      signal: abort.signal,
    });
    if (res.status === 402) return { kind: 'paused' };
    if (!res.ok) return { kind: 'failed', status: res.status };
    // Hashed before it is parsed: never a re-serialized object.
    const resBytes = new Uint8Array(await res.arrayBuffer());
    let parsed: any;
    try {
      parsed = JSON.parse(new TextDecoder().decode(resBytes));
    } catch {
      return { kind: 'failed', status: res.status };
    }
    const choice = parsed?.choices?.[0];
    // `content: null` is an OpenAI-compatible answer with no reply (reasoning that ate the ceiling).
    const content: unknown = choice?.message?.content ?? '';
    if (typeof parsed?.id !== 'string' || choice === undefined || typeof content !== 'string' || typeof parsed?.usage?.prompt_tokens !== 'number') {
      return { kind: 'failed', status: res.status };
    }
    return {
      kind: 'answer',
      id: parsed.id,
      reqBytes,
      resBytes,
      reqSha: await sha256Hex(reqBytes),
      resSha: await sha256Hex(resBytes),
      content,
      finishReason: String(choice.finish_reason ?? ''),
      tokensIn: parsed.usage.prompt_tokens,
      tokensOut: Number(parsed.usage.completion_tokens ?? 0),
      tokensReasoning: Number(parsed.usage.completion_tokens_details?.reasoning_tokens ?? 0),
      toolCalls: toolCallsOf(choice.message?.tool_calls),
    };
  } catch (e) {
    // An abort, a dropped connection: no answer reached us in time. What was not our own abort is named in the log.
    if (!abort.signal.aborted) console.log(`ai_error:${e instanceof Error ? e.name : 'unknown'}`);
    return { kind: 'timeout' };
  } finally {
    clearTimeout(timer);
  }
}

/** One web search of a streamed call: NEAR AI's tool-call id and, once it arrived, the numbered results it found. */
export interface SearchRan {
  id: string;
  output: string | null;
}

/** The most a streamed answer may weigh: the recorded ones are 31 kB. */
const MAX_STREAM_BYTES = 2_000_000;

export interface StreamSpec {
  messages: Message[];
  maxTokens: number;
  timeoutMs: number;
  /** The most searches the stream may run: the stream is aborted at the first search past it (ADR-026). */
  allowance: number;
}

interface StreamBytes {
  id: string | null;
  reqBytes: Uint8Array;
  resBytes: Uint8Array;
  reqSha: string;
  resSha: string;
  searches: SearchRan[];
}

export type StreamResult =
  // A finished stream: the closing `usage` covers the whole call, the searches are the tool-call ids counted.
  | ({ kind: 'finished'; id: string; tokensIn: number; tokensOut: number; tokensReasoning: number } & StreamBytes)
  // A search past the allowance began: the stream was aborted there, so there is no `usage` and nothing to sign.
  | ({ kind: 'cut' } & StreamBytes)
  | { kind: 'paused' }
  | { kind: 'timeout'; searches: SearchRan[] }
  | { kind: 'failed'; status: number };

/** The search call of «Find out» and «Is it true?» (ADR-026, ADR-027): streamed, `web_context_search` offered and
 * never forced (a forced call loops), no reasoning, `stream_options.include_usage` so the closing chunk carries the
 * whole call's usage. Serialized once; the raw bytes that arrive are hashed as they came, never rebuilt from the
 * events. The searches are counted by their distinct tool-call ids: the id shows ≈ 2 s before the search runs. */
export async function streamCall(env: Pick<Env, 'NEARAI_API_KEY' | 'MODEL_ID'>, spec: StreamSpec): Promise<StreamResult> {
  const body = {
    model: env.MODEL_ID,
    messages: spec.messages,
    max_tokens: spec.maxTokens,
    stream: true,
    chat_template_kwargs: { enable_thinking: false },
    tools: [{ type: 'web_context_search' }],
    tool_choice: 'auto',
    stream_options: { include_usage: true },
  };
  const reqBytes = new TextEncoder().encode(JSON.stringify(body));
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), spec.timeoutMs);
  const searches: SearchRan[] = [];
  try {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.NEARAI_API_KEY}`,
        'content-type': 'application/json',
        'x-no-aliasing': 'true',
        'accept-encoding': 'identity',
      },
      body: reqBytes,
      signal: abort.signal,
    });
    if (res.status === 402) return { kind: 'paused' };
    if (!res.ok || res.body === null) return { kind: 'failed', status: res.status };

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const received: Uint8Array[] = [];
    let text = '';
    let id: string | null = null;
    let usage: { prompt_tokens: number; completion_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number } } | null = null;
    let done = false;
    let cut = false;
    // One event of the stream: a tool call's first chunk names its id, a tool result brings the search's output.
    const take = (event: string) => {
      for (const line of event.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') {
          done = true;
          continue;
        }
        let chunk: any;
        try {
          chunk = JSON.parse(data);
        } catch {
          continue;
        }
        if (id === null && typeof chunk?.id === 'string') id = chunk.id;
        if (chunk?.usage !== null && typeof chunk?.usage?.prompt_tokens === 'number') usage = chunk.usage;
        const delta = chunk?.choices?.[0]?.delta;
        for (const call of Array.isArray(delta?.tool_calls) ? delta.tool_calls : []) {
          if (typeof call?.id === 'string' && !searches.some((s) => s.id === call.id)) {
            searches.push({ id: call.id, output: null });
            // The search past the allowance is cut where its id first shows.
            if (searches.length > spec.allowance) cut = true;
          }
        }
        const result = delta?.nearai_tool_result;
        if (typeof result?.tool_call_id === 'string') {
          const search = searches.find((s) => s.id === result.tool_call_id);
          if (search !== undefined && typeof result.output === 'string') search.output = result.output;
        }
      }
    };
    let size = 0;
    while (!cut) {
      const { done: ended, value } = await reader.read();
      if (ended) break;
      size += value.length;
      // A stream is a few dozen kB; one that goes on past the bound is not a call anybody can bill or sign.
      if (size > MAX_STREAM_BYTES) {
        await reader.cancel().catch(() => undefined);
        return { kind: 'failed', status: res.status };
      }
      received.push(value);
      text += decoder.decode(value, { stream: true });
      let at: number;
      while (!cut && (at = text.indexOf('\n\n')) !== -1) {
        take(text.slice(0, at));
        text = text.slice(at + 2);
      }
    }
    if (cut) {
      await reader.cancel().catch(() => undefined);
    } else if (text.trim() !== '') {
      take(text);
    }
    const resBytes = concat(received);
    const common: StreamBytes = { id, reqBytes, resBytes, reqSha: await sha256Hex(reqBytes), resSha: await sha256Hex(resBytes), searches };
    if (cut) return { kind: 'cut', ...common };
    // A stream that did not end with its `usage` and `[DONE]` is not a call anybody can bill or sign.
    if (!done || usage === null || id === null) return { kind: 'failed', status: res.status };
    const u = usage as { prompt_tokens: number; completion_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number } };
    return {
      kind: 'finished',
      ...common,
      id,
      tokensIn: u.prompt_tokens,
      tokensOut: Number(u.completion_tokens ?? 0),
      tokensReasoning: Number(u.completion_tokens_details?.reasoning_tokens ?? 0),
    };
  } catch {
    // An abort of the wait, a dropped connection: nothing complete reached us.
    return { kind: 'timeout', searches };
  } finally {
    clearTimeout(timer);
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Every other call of NEAR AI (the signature, the probe) waits this long at most. */
const SHORT_TIMEOUT_MS = 10_000;
const SIGNATURE_TRIES = 4;
const SIGNATURE_WAIT_MS = 500;

/** The signature of an answer: `provider_tee` over `<model>:<sha256(req)>:<sha256(res)>` and nothing
 * else counts; the search call of an errand is streamed and gets `gateway` over `<sha256(req)>:<sha256(res)>`,
 * which only the caller who expects it accepts (`kind`). A 404 or an `error_code` is retried up to three times,
 * 500 ms apart; then the call is «without the signature it needs» and null comes back. */
export async function signatureOf(
  env: Pick<Env, 'NEARAI_API_KEY' | 'MODEL_ID'>,
  answer: { id: string; reqSha: string; resSha: string },
  kind: 'provider_tee' | 'gateway' = 'provider_tee',
): Promise<Signed | null> {
  const url = `${BASE}/signature/${encodeURIComponent(answer.id)}?model=${encodeURIComponent(env.MODEL_ID)}&signing_algo=ecdsa`;
  for (let attempt = 0; attempt < SIGNATURE_TRIES; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, SIGNATURE_WAIT_MS));
    try {
      const res = await fetch(url, { headers: { authorization: `Bearer ${env.NEARAI_API_KEY}`, 'x-no-aliasing': 'true' }, signal: AbortSignal.timeout(SHORT_TIMEOUT_MS) });
      if (!res.ok) continue;
      const doc: any = await res.json();
      if (doc?.error_code !== undefined || typeof doc?.signature !== 'string') continue;
      const expected = kind === 'gateway' ? `${answer.reqSha}:${answer.resSha}` : `${env.MODEL_ID}:${answer.reqSha}:${answer.resSha}`;
      if (doc.signature_kind !== kind || doc.text !== expected) return null;
      return { signature: doc.signature, sigKind: kind, signer: String(doc.signing_address ?? '') };
    } catch {
      continue;
    }
  }
  return null;
}

/** The probe of a paused key (`Service pause data`): `POST /v1/check_api_key` with the key as the
 * bearer and no body (docs.near.ai › check-api-key-validity); 2xx means the pause is over. It
 * spends no tokens. */
export async function keyIsValid(env: Pick<Env, 'NEARAI_API_KEY'>): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/check_api_key`, { method: 'POST', headers: { authorization: `Bearer ${env.NEARAI_API_KEY}` }, signal: AbortSignal.timeout(SHORT_TIMEOUT_MS) });
    return res.ok;
  } catch {
    return false;
  }
}
