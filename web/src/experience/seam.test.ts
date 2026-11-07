import { afterEach, expect, it, vi } from 'vitest';
import { workerApi } from '../seams/worker';

afterEach(() => { vi.unstubAllGlobals(); });

// spec: add-pet-experience › Experience notes screen › success
// spec: add-pet-experience › Experience approval flow › approve note
// spec: add-pet-experience › Experience approval flow › publish field
it('sends owner note actions to the checked Worker routes with only id, approval and generation', async () => {
  const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => Response.json({ ok: true }));
  vi.stubGlobal('fetch', fetchMock);
  const note = 'a'.repeat(24);
  await workerApi.experience('identity', '9');
  await workerApi.approveExperience('identity', '9', note, true, 3);
  await workerApi.publishExperienceField('identity', '9', note, 3);
  const calls = fetchMock.mock.calls.map(([url, init]) => [url, init.method, (init as RequestInit).body ? JSON.parse((init as RequestInit).body as string) : null]);
  expect(calls).toEqual([
    ['/api/pets/9/experience', 'GET', null],
    [`/api/pets/9/experience/notes/${note}/approval`, 'PUT', { approved: true, generation: 3 }],
    ['/api/pets/9/experience/field', 'POST', { noteId: note, generation: 3 }],
  ]);
  for (const [, init] of fetchMock.mock.calls) expect((init as RequestInit).headers).toHaveProperty('privy-id-token', 'identity');
});

// spec: add-pet-experience › Experience events data › public record opened
it('sends only three opaque IDs for an opened checked record', async () => {
  const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', fetchMock);
  const ids = { tabId: crypto.randomUUID(), playerId: crypto.randomUUID(), petId: crypto.randomUUID() };
  await workerApi.experienceRecordOpened(ids);
  const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe('/api/experience/record-opened');
  expect(init.method).toBe('POST');
  expect(init.headers).not.toHaveProperty('privy-id-token');
  expect(JSON.parse(init.body as string)).toEqual(ids);
  for (const value of Object.values(ids)) expect(value).toMatch(/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i);
});
