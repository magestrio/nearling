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
    };
  } catch {
    // An abort, a dropped connection: no answer reached us in time.
    return { kind: 'timeout' };
  } finally {
    clearTimeout(timer);
  }
}

/** Every other call of NEAR AI (the signature, the probe) waits this long at most. */
const SHORT_TIMEOUT_MS = 10_000;
const SIGNATURE_TRIES = 4;
const SIGNATURE_WAIT_MS = 500;

/** The signature of an answer: `provider_tee` over `<model>:<sha256(req)>:<sha256(res)>` and nothing
 * else counts. A 404 or an `error_code` is retried up to three times, 500 ms apart; then the call
 * is «without the signature it needs» and null comes back. */
export async function signatureOf(
  env: Pick<Env, 'NEARAI_API_KEY' | 'MODEL_ID'>,
  answer: { id: string; reqSha: string; resSha: string },
): Promise<Signed | null> {
  const url = `${BASE}/signature/${encodeURIComponent(answer.id)}?model=${encodeURIComponent(env.MODEL_ID)}&signing_algo=ecdsa`;
  for (let attempt = 0; attempt < SIGNATURE_TRIES; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, SIGNATURE_WAIT_MS));
    try {
      const res = await fetch(url, { headers: { authorization: `Bearer ${env.NEARAI_API_KEY}`, 'x-no-aliasing': 'true' }, signal: AbortSignal.timeout(SHORT_TIMEOUT_MS) });
      if (!res.ok) continue;
      const doc: any = await res.json();
      if (doc?.error_code !== undefined || typeof doc?.signature !== 'string') continue;
      const expected = `${env.MODEL_ID}:${answer.reqSha}:${answer.resSha}`;
      if (doc.signature_kind !== 'provider_tee' || doc.text !== expected) return null;
      return { signature: doc.signature, sigKind: 'provider_tee', signer: String(doc.signing_address ?? '') };
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
