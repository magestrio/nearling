import { afterEach, expect, it, vi } from 'vitest';
import { debatePath, debateVerifyPath, parseRoute } from '../route';
import { workerApi } from '../seams/worker';
import { debateOpen, readShared } from './share';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

// spec: add-debates › Debate transcript screen › signed-out
// spec: add-debates › Debate consent and access data › visitor reads published link
it('keeps the secret fragment out of request URLs and reads without a session', async () => {
  const code = 'b'.repeat(32);
  const read = { id: 'a'.repeat(64), analyticsId: 'c'.repeat(64), status: 'completed' };
  const fetchMock = vi.fn(async (_path: string, _init: RequestInit) => Response.json(read));
  vi.stubGlobal('fetch', fetchMock);
  expect(parseRoute(debatePath(code))).toEqual({ name: 'debate', code });
  expect(parseRoute(debateVerifyPath(code, 2))).toEqual({ name: 'debate-verify', code, order: 2 });
  expect(await readShared(code)).toEqual(read);
  expect(fetchMock.mock.calls[0]![0]).toBe('/api/debates/read');
  expect(fetchMock.mock.calls[0]![1].method).toBe('POST');
  expect(JSON.parse(fetchMock.mock.calls[0]![1].body as string)).toEqual({ code });
  expect(fetchMock.mock.calls[0]![1].headers).toEqual({ 'content-type': 'application/json' });
});

// spec: add-debates › Debate transcript screen › deleted shared link
it('rejects a cut code before any request', async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  await expect(readShared('short')).rejects.toThrow('invalid_share_code');
  expect(fetchMock).not.toHaveBeenCalled();
});

// spec: add-debates › Debate transcript and deletion data › clear during a line
it('checks the cleared reason with a session while keeping the revoked code in a POST body', async () => {
  const code = 'b'.repeat(32);
  const fetchMock = vi.fn(async (_path: string, _init: RequestInit) => Response.json({ status: 'cleared' }));
  vi.stubGlobal('fetch', fetchMock);
  await workerApi.debateCleared('owner-token', code);
  expect(fetchMock.mock.calls[0]![0]).toBe('/api/debates/read');
  expect(fetchMock.mock.calls[0]![1].headers).toEqual({ 'privy-id-token': 'owner-token', 'content-type': 'application/json' });
  expect(JSON.parse(fetchMock.mock.calls[0]![1].body as string)).toEqual({ code });
});

// spec: add-debates › Debate playtest data › link opened
// spec: add-debates › Debate playtest data › receipt opened
it('sends only an opaque debate id and generated event and tab ids', async () => {
  const fetchMock = vi.fn(async (_path: string, _init: RequestInit) => new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', fetchMock);
  const read = { id: 'a'.repeat(64), analyticsId: 'c'.repeat(64), status: 'completed' as const,
    topic: 'A private topic', code: 'b'.repeat(32) };
  debateOpen(read, 'debate_link_opened');
  debateOpen(read, 'debate_receipt_opened');
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  const bodies = fetchMock.mock.calls.map(([path, init]) => {
    expect(path).toBe('/api/debates/events');
    return JSON.parse(init.body as string);
  });
  expect(bodies.map((body) => body.name)).toEqual(['debate_link_opened', 'debate_receipt_opened']);
  expect(bodies[0].debateId).toBe(read.analyticsId);
  expect(bodies[0].tabId).toBe(bodies[1].tabId);
  expect(Object.keys(bodies[0]).sort()).toEqual(['debateId', 'eventId', 'name', 'tabId']);
  expect(JSON.stringify(bodies)).not.toContain(read.topic);
  expect(JSON.stringify(bodies)).not.toContain(read.code);
  expect(JSON.stringify(bodies)).not.toContain(read.id);
});
