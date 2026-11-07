// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AuthContext, type AuthApi } from '../seams/auth-context';
import { announceFed } from '../feeding/feedRequest';
import type { PetView, RelationshipSummary } from '../seams/worker-types';
import { SocietyPage } from './SocietyPage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mocks = vi.hoisted(() => ({ pet: vi.fn(), relationships: vi.fn() }));
vi.mock('../seams/worker', async (original) => ({
  ...(await original<typeof import('../seams/worker')>()),
  workerApi: { pet: mocks.pet, relationships: mocks.relationships },
}));
vi.mock('../pet/PetFigure', async (original) => ({ ...(await original<typeof import('../pet/PetFigure')>()), PetFigure: () => null }));
vi.mock('../account/AccountControl', () => ({ AccountControl: () => null }));
vi.mock('../feeding/FeedLayer', () => ({ FeedLayer: () => <div data-feed-layer /> }));
vi.mock('../signin/signIn', () => ({ useSignIn: () => ({ begin() {} }) }));

const pet = { viewer: 'owner', tokenId: '9', name: 'Pixel', stage: 'adult', fullness: { state: 'full', level: 1 }, mood: 'happy', worn: null } as PetView;
const summary: RelationshipSummary = { tokenId: '9', name: 'Pixel', relationships: [{ tokenId: '2', name: 'Biscuit', stance: 'liked', breakUntil: null }] };
const getIdentityToken = async () => 'token';
const auth = (accountId: string | null, authenticated = true) => ({ ready: true, authenticated, sessionEnded: false,
  nearAccountId: accountId, getIdentityToken, endSession() {} }) as AuthApi;
let root: Root | null = null;
let host: HTMLDivElement;
const render = async (identity: AuthApi) => act(async () => {
  root!.render(<AuthContext.Provider value={identity}><SocietyPage tokenId="9" /></AuthContext.Provider>);
});

beforeEach(() => {
  window.matchMedia = vi.fn().mockReturnValue({ matches: true, addEventListener() {}, removeEventListener() {} });
  mocks.pet.mockReset().mockResolvedValue(pet);
  mocks.relationships.mockReset().mockResolvedValue(summary);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root?.unmount());
  host.remove();
  root = null;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// spec: add-pet-society › Society summary screen › success × sign-out or session expiry
it('drops private rows as soon as the session disappears', async () => {
  await render(auth('a'.repeat(64)));
  expect(host.textContent).toContain('Biscuit');
  await render(auth(null, false));
  expect(host.textContent).not.toContain('Biscuit');
});

// spec: add-pet-society › Society summary screen › success × owner changes
it('does not show the former account rows while a new owner read is pending', async () => {
  await render(auth('a'.repeat(64)));
  expect(host.textContent).toContain('Biscuit');
  mocks.relationships.mockReturnValue(new Promise(() => undefined));
  await render(auth('b'.repeat(64)));
  expect(host.textContent).not.toContain('Biscuit');
});

// spec: add-pet-society › Society summary screen › success × tab hidden and back
it('drops rows when the tab hides and ignores a stale in-flight read', async () => {
  let resolve!: (value: RelationshipSummary) => void;
  mocks.relationships.mockReturnValue(new Promise<RelationshipSummary>((done) => { resolve = done; }));
  await render(auth('a'.repeat(64)));
  expect(host.textContent).toContain("Getting Pixel's relationships…");
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  await act(async () => document.dispatchEvent(new Event('visibilitychange')));
  await act(async () => resolve(summary));
  expect(host.textContent).not.toContain('Biscuit');
  expect(mocks.relationships).toHaveBeenCalledTimes(1);
});

// spec: add-pet-society › Society summary screen › asleep × confirmed feed
it('rereads the pet after a confirmed feed and removes the asleep action', async () => {
  mocks.pet.mockResolvedValueOnce({ ...pet, fullness: { state: 'asleep', level: 0 } }).mockResolvedValueOnce(pet);
  await render(auth('a'.repeat(64)));
  expect(host.textContent).toContain('Pixel is asleep. Feed Pixel to ask a friend for help.');
  const sheet = host.querySelector('[data-feed-layer]');
  await act(async () => announceFed({ kind: 'fed', tokenId: '9', source: 'near' }));
  expect(mocks.pet).toHaveBeenCalledTimes(2);
  expect(mocks.relationships).toHaveBeenCalledTimes(1);
  expect(host.querySelector('[data-feed-layer]')).toBe(sheet);
  expect(host.textContent).not.toContain('Pixel is asleep.');
  expect(host.textContent).toContain('Biscuit');
});

// spec: add-pet-society › Society bounds rule › two rude days × refusal expiry
it('rereads owner rows when a displayed break expires', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-07T12:00:00Z'));
  const until = Date.now() + 1_000;
  let resolve!: (value: RelationshipSummary) => void;
  mocks.relationships.mockResolvedValueOnce({ ...summary, relationships: [{ ...summary.relationships[0], stance: 'strained', breakUntil: until }] })
    .mockReturnValueOnce(new Promise<RelationshipSummary>((done) => { resolve = done; }));
  await render(auth('a'.repeat(64)));
  expect(host.textContent).toContain('Taking a break until');
  await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
  expect(mocks.relationships).toHaveBeenCalledTimes(2);
  expect(host.textContent).not.toContain('Biscuit');
  await act(async () => resolve({ ...summary, relationships: [{ ...summary.relationships[0]!, stance: 'strained', breakUntil: null }] }));
  expect(host.textContent).toContain('Strained');
  expect(host.textContent).not.toContain('Taking a break until');
});
