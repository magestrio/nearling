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
