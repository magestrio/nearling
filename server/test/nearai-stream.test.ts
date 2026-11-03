// The streamed search call against what NEAR AI really sent: the recordings of 2026-11-03 (`test/fixtures/nearai-search*`,
// made on dev with the user's yes; no key, no player's words). The request is rebuilt byte for byte, the stream is read
// as it came, and the gateway's signature over `<sha256(req)>:<sha256(res)>` is accepted only for those bytes.
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { signatureOf, streamCall } from '../src/nearai';
import request from './fixtures/nearai-search.request.json?raw';
import sse from './fixtures/nearai-search.sse?raw';
import signature from './fixtures/nearai-search.signature.json?raw';
import noUsage from './fixtures/nearai-search-nousage.sse?raw';

const enc = new TextEncoder();
const recorded = enc.encode(sse);
const recordedRequest = JSON.parse(request) as { messages: { role: 'user'; content: string }[]; max_tokens: number };
const sent = { messages: recordedRequest.messages, maxTokens: recordedRequest.max_tokens, timeoutMs: 5_000 };

/** The recorded bytes as a stream, in pieces that cut events in the middle, as a network does. */
function streamOf(bytes: Uint8Array, piece = 997): Response {
  let at = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (at >= bytes.length) return controller.close();
        controller.enqueue(bytes.slice(at, at + piece));
        at += piece;
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
}

let requests: { url: string; body: Uint8Array }[] = [];
let respond: () => Response = () => streamOf(recorded);

beforeEach(() => {
  requests = [];
  respond = () => streamOf(recorded);
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('/signature/')) return new Response(signature, { status: 200, headers: { 'content-type': 'application/json' } });
    requests.push({ url, body: init?.body as Uint8Array });
    return respond();
  });
});
afterEach(() => vi.restoreAllMocks());

describe('Errand request data', () => {
  // spec: add-pet-errands › Errand request data › a search errand
  it('serializes the request once, as recorded, and reads the stream as it came', async () => {
    const result = await streamCall(env, { ...sent, allowance: 3 });
    // the exact bytes NEAR AI signed the request of
    expect(new TextDecoder().decode(requests[0]!.body)).toBe(request);
    expect(result.kind).toBe('finished');
    if (result.kind !== 'finished') return;
    // the raw bytes that arrived, never rebuilt from the events
    expect(Array.from(result.resBytes)).toEqual(Array.from(recorded));
    // one search, counted by its tool-call id; the usage of the whole call from the last chunk
    expect(result.searches.map((s) => s.id)).toEqual(['call_f9521bb3527840cda0eb5a6c']);
    expect(result.searches[0]!.output).toMatch(/^\[1\] NEAR Protocol Price: NEAR\/USD Live Price Chart/);
    expect(result).toMatchObject({ id: '98234e1bb210411fa32d1634fe55a1f8', tokensIn: 7937, tokensOut: 45, tokensReasoning: 0 });
    // the gateway's signature over the two hashes: accepted for these bytes
    const doc = JSON.parse(signature) as { text: string; signature: string; signing_address: string };
    expect(`${result.reqSha}:${result.resSha}`).toBe(doc.text);
    expect(await signatureOf(env, result, 'gateway')).toEqual({ signature: doc.signature, sigKind: 'gateway', signer: doc.signing_address });
    // ...and never as the model's signature, which has the model in its text and another kind
    expect(await signatureOf(env, result)).toBeNull();
  });

  // spec: add-pet-errands › Errand request data › a search errand
  it('refuses a signature of other bytes', async () => {
    const result = await streamCall(env, { ...sent, allowance: 3 });
    if (result.kind !== 'finished') throw new Error('the recorded stream finishes');
    expect(await signatureOf(env, { ...result, resSha: '0'.repeat(64) }, 'gateway')).toBeNull();
  });
});

describe('Errand price data', () => {
  // spec: add-pet-errands › Errand price data › a search past the allowance
  it('cuts the recorded stream where its first search shows when the allowance is none', async () => {
    const cancelled = vi.fn();
    respond = () => {
      let at = 0;
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.enqueue(recorded.slice(at, at + 400));
            at += 400;
          },
          cancel: cancelled,
        }),
        { status: 200 },
      );
    };
    const result = await streamCall(env, { ...sent, allowance: 0 });
    expect(result.kind).toBe('cut');
    if (result.kind !== 'cut') return;
    // the bytes received are a prefix of the stream, and the Worker hung up
    expect(result.resBytes.length).toBeLessThan(recorded.length);
    expect(Array.from(result.resBytes)).toEqual(Array.from(recorded.slice(0, result.resBytes.length)));
    expect(cancelled).toHaveBeenCalled();
    // the search shows before its result: the cut call has the id and no output
    expect(result.searches).toEqual([{ id: 'call_f9521bb3527840cda0eb5a6c', output: null }]);
    // hashes of what came, nothing to sign
    expect(result.resSha).toMatch(/^[0-9a-f]{64}$/);
  });

  // spec: add-pet-errands › Find out flow › web search down
  it('is not a call anybody can bill or sign when its usage never came', async () => {
    respond = () => streamOf(enc.encode(noUsage));
    expect((await streamCall(env, { ...sent, allowance: 3 })).kind).toBe('failed');
  });

  // spec: add-pet-errands › Find out flow › web search down
  it('is not a call when the connection drops half way', async () => {
    respond = () => {
      let n = 0;
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            n += 1;
            if (n === 1) controller.enqueue(recorded.slice(0, 700));
            else controller.error(new TypeError('network connection lost'));
          },
        }),
        { status: 200 },
      );
    };
    expect((await streamCall(env, { ...sent, allowance: 3 })).kind).toBe('timeout');
  });

  // spec: add-pet-errands › Find out flow › web search down
  it('tells a spent key and a refusal apart', async () => {
    respond = () => new Response('{}', { status: 402 });
    expect((await streamCall(env, { ...sent, allowance: 3 })).kind).toBe('paused');
    respond = () => new Response('{}', { status: 429 });
    expect(await streamCall(env, { ...sent, allowance: 3 })).toEqual({ kind: 'failed', status: 429 });
  });
});
