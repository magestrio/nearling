// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthContext, type AuthApi } from '../../seams/auth-context';
import { keepPendingName, pendingName } from './pendingBirth';
import { useHatch } from './useHatch';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const worker = vi.hoisted(() => ({ hatchStatus: vi.fn(), hatch: vi.fn(), pet: vi.fn() }));
vi.mock('../../seams/worker', async (original) => ({ ...(await original<typeof import('../../seams/worker')>()), workerApi: worker }));

const auth = {
  ready: true,
  authenticated: true,
  nearAccountId: 'alice.testnet',
  sessionEnded: false,
  getIdentityToken: vi.fn(async () => 'identity-token'),
  needSession: vi.fn(() => true),
  endSession: vi.fn(),
} as unknown as AuthApi;

let root: Root | null = null;
let seen: ReturnType<typeof useHatch>;

function Probe() {
  seen = useHatch(null);
  return null;
}

async function show(): Promise<void> {
  root = createRoot(document.createElement('div'));
  await act(async () => root!.render(createElement(AuthContext.Provider, { value: auth }, createElement(Probe))));
}

async function updateAuth(next: Partial<AuthApi>): Promise<void> {
  Object.assign(auth, next);
  await act(async () => root!.render(createElement(AuthContext.Provider, { value: { ...auth } }, createElement(Probe))));
}

beforeEach(() => {
  Object.assign(auth, { ready: true, authenticated: true, nearAccountId: 'alice.testnet' });
  auth.getIdentityToken = vi.fn(async () => 'identity-token');
  sessionStorage.clear();
  window.history.replaceState(null, '', '/hatch');
  worker.hatchStatus.mockReset().mockResolvedValue({ open: true, pending: true });
  worker.hatch.mockReset();
  worker.pet.mockReset();
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
});

describe('the pending Hatch state', () => {
  // spec: add-hatch-again › Hatch again screen › birth closed for the day × 00:00 UTC
  it('rechecks a daily closure against the Worker when the browser clock has passed its reset time', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-11T02:00:00.000Z'));
    try {
      worker.hatchStatus.mockResolvedValueOnce({ open: false, reason: 'daily', until: '2026-11-11T00:00:00.000Z', serverTime: '2026-11-10T23:59:55.000Z' })
        .mockResolvedValue({ open: true });
      await show();
      expect(seen.view.kind).toBe('closed');
      await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
      expect(worker.hatchStatus).toHaveBeenCalledTimes(1);
      expect(seen.view.kind).toBe('closed');
      await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
      expect(worker.hatchStatus).toHaveBeenCalledTimes(2);
      expect(seen.view.kind).toBe('form');
    } finally {
      vi.useRealTimers();
    }
  });

  // spec: add-pet › Hatch screen › рождения на сегодня закрыты
  it('does not poll the Worker before the reset time it reported', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-10T12:00:00.000Z'));
    try {
      worker.hatchStatus.mockResolvedValueOnce({ open: false, reason: 'daily', until: '2026-11-11T00:00:00.000Z', serverTime: '2026-11-10T23:59:50.000Z' })
        .mockResolvedValue({ open: true });
      await show();
      await act(async () => { await vi.advanceTimersByTimeAsync(9000); });
      expect(worker.hatchStatus).toHaveBeenCalledTimes(1);
      await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
      expect(worker.hatchStatus).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  // spec: add-hatch-again › Hatch again screen › birth closed for the day × 00:00 UTC
  it('retries a missed boundary only after the first reset read still says closed', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-10T12:00:00.000Z'));
    try {
      worker.hatchStatus.mockResolvedValueOnce({ open: false, reason: 'daily', until: '2026-11-11T00:00:00.000Z', serverTime: '2026-11-10T23:59:55.000Z' })
        .mockResolvedValueOnce({ open: false, reason: 'daily', until: '2026-11-11T00:00:00.000Z', serverTime: '2026-11-11T00:00:00.000Z' })
        .mockResolvedValue({ open: true });
      await show();
      await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
      expect(worker.hatchStatus).toHaveBeenCalledTimes(2);
      await act(async () => { await vi.advanceTimersByTimeAsync(4999); });
      expect(worker.hatchStatus).toHaveBeenCalledTimes(2);
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(worker.hatchStatus).toHaveBeenCalledTimes(3);
      expect(seen.view.kind).toBe('form');
    } finally {
      vi.useRealTimers();
    }
  });

  // spec: add-hatch-again › Hatch again screen › success
  // spec: add-hatch-again › Repeat ownership data › historical birth with no pet
  it('allows a repeat when only the historical birth pointer remains', async () => {
    worker.hatchStatus.mockResolvedValue({ open: true, ownedCount: 0, latestBirth: { tokenId: '9', name: 'Pixel' }, knownPets: [{ tokenId: '9', name: 'Pixel', asleep: false }] });
    await show();
    expect(seen.view.kind).toBe('form');
    expect(seen.known).toEqual([{ tokenId: '9', name: 'Pixel', asleep: false }]);
    await act(async () => seen.setName('Nova'));
    worker.hatch.mockResolvedValue({ pending: true });
    await act(async () => seen.submit());
    expect(worker.hatch).toHaveBeenCalledWith('identity-token', 'Nova');
    expect(seen.birth).toBe('hatching');
  });

  // spec: add-hatch-again › Hatch again screen › already owns a pet
  // spec: add-hatch-again › Repeat eligibility rule › gift after opening Hatch
  it('shows a gifted-in current pet even when an old birth is in history', async () => {
    worker.hatchStatus.mockResolvedValue({ open: true, ownedCount: 1, currentPet: { tokenId: '12', name: 'Biscuit' }, already: { tokenId: '12', name: 'Biscuit' }, latestBirth: { tokenId: '9', name: 'Pixel' } });
    await show();
    expect(seen.view).toEqual({ kind: 'already', tokenId: '12', name: 'Biscuit' });
    await act(async () => seen.setName('Nova'));
    await act(async () => seen.submit());
    expect(worker.hatch).not.toHaveBeenCalled();
  });

  // spec: add-hatch-again › Repeat eligibility rule › gift after opening Hatch
  it('shows the received pet when the original mint fails because a gift landed', async () => {
    keepPendingName('alice.testnet', 'Nova');
    worker.hatchStatus.mockResolvedValue({ open: true, failed: true, ownedCount: 1, currentPet: { tokenId: '12', name: 'Biscuit' }, latestBirth: { tokenId: '9', name: 'Pixel' } });
    await show();
    expect(seen.view).toEqual({ kind: 'already', tokenId: '12', name: 'Biscuit' });
    expect(seen.birth).toBe('idle');
    expect(pendingName('alice.testnet')).toBeNull();
  });

  // spec: add-hatch-again › Repeat birth recovery data › old birth exists during pending repeat
  it('does not navigate to the old birth during a pending repeat', async () => {
    keepPendingName('alice.testnet', 'Nova');
    worker.hatchStatus.mockResolvedValue({ open: true, pending: true, ownedCount: 0, latestBirth: { tokenId: '9', name: 'Pixel' } });
    await show();
    expect(seen.birth).toBe('hatching');
    expect(window.location.pathname).toBe('/hatch');
    await act(async () => seen.submit());
    expect(worker.hatch).not.toHaveBeenCalled();
  });

  // spec: add-hatch-again › Repeat birth recovery data › repeat confirmed after lost response
  it('opens only the token proved by the original repeat transaction', async () => {
    keepPendingName('alice.testnet', 'Nova');
    worker.hatchStatus.mockResolvedValue({ open: true, tokenId: '12', ownedCount: 1, latestBirth: { tokenId: '9', name: 'Pixel' } });
    await show();
    expect(window.location.pathname).toBe('/pet/12');
    expect(pendingName('alice.testnet')).toBeNull();
  });

  // spec: add-hatch-again › Hatch again screen › loading
  // spec: add-hatch-again › Hatch again screen › success × tab visible
  it('keeps known links during a fresh check after the tab returns', async () => {
    const ready = { open: true, ownedCount: 0, knownPets: [{ tokenId: '9', name: 'Pixel', asleep: false }] };
    let answer!: (value: typeof ready) => void;
    worker.hatchStatus.mockResolvedValueOnce(ready).mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    await show();
    expect(seen.known).toEqual(ready.knownPets);
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    expect(seen.view.kind).toBe('checking');
    expect(seen.known).toEqual(ready.knownPets);
    await act(async () => answer(ready));
    expect(seen.view.kind).toBe('form');
  });

  // spec: add-hatch-again › Hatch again screen › success × sign-out
  // spec: add-hatch-again › Hatch again screen › signed-out
  it('drops private known links when the session ends', async () => {
    worker.hatchStatus.mockResolvedValueOnce({ open: true, ownedCount: 0, knownPets: [{ tokenId: '9', name: 'Pixel', asleep: false }] })
      .mockResolvedValue({ open: true });
    await show();
    expect(seen.known).toHaveLength(1);
    await updateAuth({ authenticated: false, nearAccountId: null });
    expect(seen.known).toEqual([]);
    expect(seen.view.kind).toBe('signed-out');
  });

  // spec: add-hatch-again › Hatch again screen › success × sign-out
  // spec: add-hatch-again › Repeat birth flow › unknown outcome
  it('does not open an old account birth after sign-out while its POST is pending', async () => {
    worker.hatchStatus.mockResolvedValue({ open: true, ownedCount: 0 });
    await show();
    await act(async () => seen.setName('Nova'));
    let resolve!: (value: { tokenId: string }) => void;
    worker.hatch.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    await act(async () => { void seen.submit(); });
    await updateAuth({ authenticated: false, nearAccountId: null });
    await act(async () => resolve({ tokenId: '12' }));
    expect(window.location.pathname).toBe('/hatch');
    expect(seen.view.kind).toBe('signed-out');
  });

  // spec: add-pet › Birth flow › birth pending
  it('restores the typed name and blocks a second birth after a reload', async () => {
    keepPendingName('alice.testnet', 'Pixel');
    await show();
    expect(seen.name).toBe('Pixel');
    expect(seen.birth).toBe('hatching');
    expect(seen.view.kind).toBe('form');
    await act(async () => seen.submit());
    expect(worker.hatch).not.toHaveBeenCalled();
  });

  // spec: add-pet › Birth flow › birth pending
  // spec: add-pet › Birth flow › не вылупился
  it('keeps the name when the original hash confirms failure, then allows retry', async () => {
    keepPendingName('alice.testnet', 'Pixel');
    await show();
    worker.hatchStatus.mockResolvedValue({ open: true, failed: true });
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    expect(seen.birth).toBe('not_hatched');
    expect(seen.name).toBe('Pixel');
    expect(pendingName('alice.testnet')).toBeNull();
    worker.hatch.mockResolvedValue({ tokenId: '9' });
    await act(async () => seen.submit());
    expect(worker.hatch).toHaveBeenCalledWith('identity-token', 'Pixel');
  });

  // spec: add-pet › Birth flow › не вылупился
  it('restores the name when failure arrives after account availability on reload', async () => {
    keepPendingName('alice.testnet', 'Pixel');
    worker.hatchStatus.mockResolvedValue({ open: true, failed: true });
    Object.assign(auth, { ready: false, authenticated: false, nearAccountId: null });
    await show();
    expect(seen.name).toBe('');
    await updateAuth({ ready: true, authenticated: true, nearAccountId: 'alice.testnet' });
    expect(seen.birth).toBe('not_hatched');
    expect(seen.name).toBe('Pixel');
    expect(pendingName('alice.testnet')).toBeNull();
    worker.hatch.mockResolvedValue({ tokenId: '9' });
    await act(async () => seen.submit());
    expect(worker.hatch).toHaveBeenCalledWith('identity-token', 'Pixel');
  });

  // spec: add-pet › Birth flow › birth pending
  it('releases a saved birth when the authoritative status has no flight or pet', async () => {
    keepPendingName('alice.testnet', 'Pixel');
    worker.hatchStatus.mockResolvedValue({ open: true });
    await show();
    expect(seen.birth).toBe('idle');
    expect(seen.name).toBe('Pixel');
    expect(pendingName('alice.testnet')).toBeNull();
    worker.hatch.mockResolvedValue({ tokenId: '9' });
    await act(async () => seen.submit());
    expect(worker.hatch).toHaveBeenCalledWith('identity-token', 'Pixel');
  });

  // spec: add-pet › Birth flow › birth pending
  it('releases a pending POST when a later status has no flight or pet', async () => {
    await show();
    await act(async () => seen.setName('Pixel'));
    worker.hatch.mockRejectedValue(new (await import('../../seams/worker')).WorkerError(503, 'chain_unreachable'));
    await act(async () => seen.submit());
    expect(seen.birth).toBe('hatching');
    worker.hatchStatus.mockResolvedValue({ open: true });
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    expect(seen.birth).toBe('idle');
    expect(pendingName('alice.testnet')).toBeNull();
  });

  // spec: add-pet › Birth flow › birth pending
  it('ignores an empty poll while the birth POST has not created its flight', async () => {
    worker.hatchStatus.mockResolvedValue({ open: true });
    await show();
    await act(async () => seen.setName('Pixel'));
    let answer!: (value: { pending: true }) => void;
    worker.hatch.mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
    await act(async () => { void seen.submit(); });
    expect(seen.birth).toBe('hatching');
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    expect(seen.birth).toBe('hatching');
    expect(pendingName('alice.testnet')).toBe('Pixel');
    await act(async () => answer({ pending: true }));
    expect(seen.birth).toBe('hatching');
    worker.hatchStatus.mockResolvedValue({ open: true, pending: true });
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    expect(seen.birth).toBe('hatching');
    worker.hatchStatus.mockResolvedValue({ open: true, failed: true });
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    expect(seen.birth).toBe('not_hatched');
    expect(seen.name).toBe('Pixel');
  });

  // spec: add-pet › Birth flow › birth pending
  it('keeps hatching across a remount before the identity token and claim exist, then refreshes after POST settles', async () => {
    worker.hatchStatus.mockResolvedValue({ open: true });
    await show();
    await act(async () => seen.setName('Pixel'));
    let releaseToken!: (token: string) => void;
    auth.getIdentityToken = vi.fn()
      .mockImplementationOnce(() => new Promise<string>((resolve) => { releaseToken = resolve; }))
      .mockResolvedValue('identity-token');
    worker.hatch.mockResolvedValue({ pending: true });
    await act(async () => { void seen.submit(); });
    expect(pendingName('alice.testnet')).toBe('Pixel');
    await act(async () => root!.unmount());
    root = null;
    await show();
    expect(seen.birth).toBe('hatching');
    expect(pendingName('alice.testnet')).toBe('Pixel');
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    expect(seen.birth).toBe('hatching');
    await act(async () => { void seen.submit(); });
    expect(worker.hatch).not.toHaveBeenCalled();
    worker.hatchStatus.mockResolvedValue({ open: true, failed: true });
    await act(async () => releaseToken('identity-token'));
    expect(worker.hatch).toHaveBeenCalledTimes(1);
    expect(seen.birth).toBe('not_hatched');
    expect(seen.name).toBe('Pixel');
  });

  // spec: add-pet › Birth flow › birth pending
  it('clears the marker if the identity token disappears before POST', async () => {
    worker.hatchStatus.mockResolvedValue({ open: true });
    await show();
    await act(async () => seen.setName('Pixel'));
    auth.getIdentityToken = vi.fn(async () => null);
    await act(async () => seen.submit());
    expect(seen.birth).toBe('idle');
    expect(pendingName('alice.testnet')).toBeNull();
    expect(worker.hatch).not.toHaveBeenCalled();
  });
});
