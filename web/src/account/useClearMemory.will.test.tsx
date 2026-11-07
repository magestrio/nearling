// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { AuthContext, type AuthApi } from '../seams/auth-context';
import { WorkerError } from '../seams/worker';
import { useClearMemory, type ClearPhase } from './useClearMemory';

const mock = vi.hoisted(() => ({ wish: vi.fn(), clear: vi.fn(), shared: vi.fn() }));
vi.mock('../seams/worker', async (original) => ({
  ...(await original<typeof import('../seams/worker')>()),
  workerApi: { wish: mock.wish, clearMemory: mock.clear },
}));
vi.mock('../errands/sharedApproval', () => ({ sharedJobOf: mock.shared }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let phase: ClearPhase;
let run: () => Promise<void>;

function Harness() {
  const state = useClearMemory('9', { done: vi.fn(), retry: vi.fn(), notOwner: vi.fn(), close: vi.fn() });
  phase = state.phase;
  run = state.clear;
  return null;
}

afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); vi.clearAllMocks(); });

// spec: add-pet-will › Will memory clear flow › release fails
// spec: add-pet-will › Will memory clear flow › deletion fails after release
it.each([503, 500])('keeps a wish-clear failure retryable at HTTP %i', async (status) => {
  mock.wish.mockResolvedValue({ wish: { item: 'smart-glasses', reason: 'private', status: 'active', reserveYocto: '1' } });
  mock.shared.mockResolvedValue({ shared_job: null });
  mock.clear.mockRejectedValue(new WorkerError(status, 'clear_failed'));
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<AuthContext.Provider value={{ needSession: () => true, getIdentityToken: async () => 'token' } as AuthApi}><Harness /></AuthContext.Provider>));
  await act(async () => run());
  expect(phase).toEqual({ kind: 'error', why: 'failed', hasWish: true });
  expect(mock.clear).toHaveBeenCalledOnce();
});
