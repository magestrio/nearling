// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DebatePage } from './DebatePage';

const mocks = vi.hoisted(() => ({
  auth: { ready: true, authenticated: false, sessionEnded: false, getIdentityToken: vi.fn(),
    needSession: vi.fn(), endSession: vi.fn() },
  api: { debateShared: vi.fn(), debateCleared: vi.fn(), debateRead: vi.fn(), debateStop: vi.fn(), debateOpen: vi.fn() },
  signIn: vi.fn(),
}));
vi.mock('../seams/auth', () => ({ useAuth: () => mocks.auth }));
vi.mock('../signin/signIn', () => ({ useSignIn: () => ({ begin: mocks.signIn }) }));
vi.mock('../seams/worker', () => ({ workerApi: mocks.api, WorkerError: class WorkerError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
} }));
vi.mock('../pet/PetFigure', async (original) => ({ ...await original<typeof import('../pet/PetFigure')>(),
  PetFigure: ({ name }: { name: string }) => <span data-pet={name} /> }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const code = 'b'.repeat(32);
const read = { id: 'a'.repeat(64), analyticsId: 'c'.repeat(64), status: 'completed', topic: 'Rain?',
  firstPet: { tokenId: '9', name: 'Pixel' }, secondPet: { tokenId: '5', name: 'Nori' }, openerPet: '9',
  lines: [1, 2, 3, 4].map((order) => ({ order, speakerPet: order % 2 ? '9' : '5', status: 'settled',
    text: `Exact line ${order}`, priceYocto: '180000000000000000000', nearUsdRate: '4.59', receiptTxHash: `tx${order}` })) };
let host: HTMLElement;
let root: Root;

beforeEach(() => {
  window.matchMedia = ((query: string) => ({ matches: true, media: query, addEventListener() {},
    removeEventListener() {} })) as unknown as typeof window.matchMedia;
  mocks.auth.authenticated = false;
  mocks.api.debateShared.mockResolvedValue(read);
  mocks.api.debateOpen.mockResolvedValue(undefined);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.clearAllMocks(); });
async function show() {
  await act(async () => root.render(<DebatePage code={code} />));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

// spec: add-debates › Debate transcript screen › signed-out
// spec: add-debates › Debate transcript screen › success
it('shows exact ordered paid lines and four usable receipt links to a visitor', async () => {
  await show();
  expect(host.textContent).toContain('Debate complete');
  expect(host.querySelector('.ds-debate-line__cost')?.textContent).toBe('0.08¢0.00018 NEAR');
  expect([...host.querySelectorAll('.ds-debate-line')].map((node) => node.textContent)).toEqual(
    expect.arrayContaining([expect.stringContaining('Exact line 1'), expect.stringContaining('Exact line 4')]));
  expect([...host.querySelectorAll('.ds-debate-line a')].map((link) => link.getAttribute('href')))
    .toEqual([1, 2, 3, 4].map((order) => `/debate/verify/${order}#${code}`));
  expect(host.textContent).toContain('Sign in');
  expect(host.textContent).not.toContain('Stop debate');
  expect(mocks.api.debateRead).not.toHaveBeenCalled();
  expect(mocks.api.debateOpen).toHaveBeenCalledWith(expect.objectContaining({ name: 'debate_link_opened', debateId: read.analyticsId }));
});

// spec: add-debates › Debate transcript and deletion data › clear during a line
it('shows the current owner the ended reason after a cleared link is reloaded', async () => {
  mocks.auth.authenticated = true;
  mocks.auth.getIdentityToken.mockResolvedValue('owner-token');
  mocks.api.debateShared.mockRejectedValueOnce(new (await import('../seams/worker')).WorkerError(404, 'no_debate'));
  mocks.api.debateCleared.mockResolvedValue({ id: read.id, status: 'cleared', endReason: 'memory_clear' });
  await show();
  expect(mocks.api.debateCleared).toHaveBeenCalledWith('owner-token', code);
  expect(host.textContent).toContain('Debate ended after memory was cleared.');
  expect(host.textContent).not.toContain('This debate is no longer available.');
});

// spec: add-debates › Debate transcript and deletion data › clear during a line
it('replaces a visible transcript with the owner ended reason after a refresh', async () => {
  mocks.auth.authenticated = true;
  mocks.auth.getIdentityToken.mockResolvedValue('owner-token');
  mocks.api.debateRead.mockResolvedValue(read);
  await show();
  expect(host.textContent).toContain('Debate complete');
  mocks.api.debateShared.mockRejectedValueOnce(new (await import('../seams/worker')).WorkerError(404, 'no_debate'));
  mocks.api.debateCleared.mockResolvedValue({ id: read.id, status: 'cleared', endReason: 'memory_clear' });
  await act(async () => { document.dispatchEvent(new Event('visibilitychange'));
    await new Promise((resolve) => setTimeout(resolve, 0)); });
  expect(host.textContent).toContain('Debate ended after memory was cleared.');
  expect(host.textContent).not.toContain('Exact line 1');
});

// spec: add-debates › Debate transcript and deletion data › clear during a line
it('does not reveal a stale public read when clear wins before the owner check', async () => {
  mocks.auth.authenticated = true;
  mocks.auth.getIdentityToken.mockResolvedValue('owner-token');
  mocks.api.debateRead.mockRejectedValueOnce(new (await import('../seams/worker')).WorkerError(404, 'no_debate'));
  mocks.api.debateCleared.mockResolvedValue({ id: read.id, status: 'cleared', endReason: 'memory_clear' });
  await show();
  expect(host.textContent).toContain('Debate ended after memory was cleared.');
  expect(host.textContent).not.toContain('Exact line 1');
});

// spec: add-debates › Debate transcript screen › deleted shared link
it('exits a revoked link without a retry or a receipt', async () => {
  mocks.api.debateShared.mockRejectedValueOnce(new Error('invalid_share_code'));
  await show();
  expect(host.textContent).toContain('This debate is no longer available.');
  expect([...host.querySelectorAll('a[href="/"]')].some((link) => link.textContent?.includes('Go home'))).toBe(true);
  expect(host.textContent).not.toContain('Try again');
  expect(host.textContent).not.toContain('Check this line');
  expect(mocks.api.debateOpen).not.toHaveBeenCalled();
});

// spec: add-debates › Debate transcript screen › success × tab hidden and back
it('refreshes the published record on return to a visible tab without a second open event', async () => {
  await show();
  expect(mocks.api.debateShared).toHaveBeenCalledTimes(1);
  await act(async () => { document.dispatchEvent(new Event('visibilitychange'));
    await new Promise((resolve) => setTimeout(resolve, 0)); });
  expect(mocks.api.debateShared).toHaveBeenCalledTimes(2);
  expect(mocks.api.debateOpen).toHaveBeenCalledTimes(1);
});
