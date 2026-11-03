// The data call against what NEAR AI really sent: the recording of 2026-11-03 (`test/fixtures/nearai-tools.*`, made on dev
// with the user's yes; no key, no player's words). A non-streamed call with client `tools` comes back as `tool_calls` with
// `content: null`, signed `provider_tee` over the bytes of this request and this response (ADR-024 › Action item 3): no
// JSON fallback is needed.
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { complete, sha256Hex, signatureOf } from '../src/nearai';
import request from './fixtures/nearai-tools.request.json?raw';
import response from './fixtures/nearai-tools.response.json?raw';
import signature from './fixtures/nearai-tools.signature.json?raw';

const enc = new TextEncoder();
const recorded = JSON.parse(request) as { messages: { role: 'system' | 'user'; content: string }[]; max_tokens: number; tools: unknown[] };
let sent: Uint8Array | null = null;

beforeEach(() => {
  sent = null;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('/signature/')) return new Response(signature, { status: 200, headers: { 'content-type': 'application/json' } });
    sent = init?.body as Uint8Array;
    return new Response(response, { status: 200, headers: { 'content-type': 'application/json' } });
  });
});
afterEach(() => vi.restoreAllMocks());

describe('Errand request data', () => {
  // spec: add-pet-errands › Errand request data › a pet with a skill
  it('sends the tools in one serialization, reads the tool_calls with no content, and accepts the TEE signature of exactly those bytes', async () => {
    const result = await complete(env, {
      messages: recorded.messages,
      maxTokens: recorded.max_tokens,
      thinking: false,
      timeoutMs: 5_000,
      extra: { tools: recorded.tools },
    });
    // the request bytes are the recorded ones
    expect(new TextDecoder().decode(sent!)).toBe(request);
    expect(result.kind).toBe('answer');
    if (result.kind !== 'answer') return;
    expect(result.content).toBe('');
    expect(result.finishReason).toBe('tool_calls');
    expect(result.toolCalls).toEqual([{ id: 'call_26dd07baa03a42dc950909aa', name: 'account_balance', arguments: '{"account_id": "alice.near"}' }]);
    expect(result).toMatchObject({ id: 'a0ed6cd814874038ba4108dd27a97ab1', tokensIn: 333, tokensOut: 30, tokensReasoning: 0 });
    // the raw response bytes, hashed as they came
    expect(result.resSha).toBe(await sha256Hex(enc.encode(response)));
    const signed = await signatureOf(env, result);
    expect(signed).toMatchObject({ sigKind: 'provider_tee', signer: '0x835ab53d20294ef795906dff21ae4c045336aa26' });
  });
});
