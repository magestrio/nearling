// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  track: vi.fn(),
  wallet: vi.fn(),
  auth: { authenticated: true, sessionEnded: false, getIdentityToken: async () => 'token', endSession: vi.fn(), needSession: () => true },
}));
vi.mock('../track', () => ({ track: mocks.track }));
vi.mock('../seams/auth', () => ({ useAuth: () => mocks.auth }));
vi.mock('../seams/worker', async () => ({ ...(await import('../seams/worker-types')), workerApi: { wallet: mocks.wallet }, toastHeld: () => false }));

import { AddNearBody, WATCH_MS } from './AddNearSheet';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ADDRESS = 'b'.repeat(64);
let root: Root | null = null;
let host: HTMLElement;
const onStatus = vi.fn();
const onArrived = vi.fn();
const onClose = vi.fn();

async function mount(from: 'feed' | 'gift' = 'feed') {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<AddNearBody from={from} onStatus={onStatus} onArrived={onArrived} onClose={onClose} />));
}
const settle = (ms = 0) => act(async () => vi.advanceTimersByTimeAsync(ms));

beforeEach(() => {
  vi.useFakeTimers();
  for (const m of [mocks.track, mocks.wallet, mocks.auth.endSession, onStatus, onArrived, onClose]) m.mockReset();
  mocks.auth.sessionEnded = false;
  mocks.wallet.mockResolvedValue({ address: ADDRESS, balance: '0', funded: false });
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  host.remove();
  vi.useRealTimers();
});

describe('the Add NEAR step', () => {
  // spec: add-feeding › Add NEAR sheet screen › success
  it('counts its opening once, with where it was opened from, and says «Waiting for your NEAR…» on the sheet', async () => {
    await mount('gift');
    await settle();
    expect(mocks.track).toHaveBeenCalledTimes(1);
    expect(mocks.track).toHaveBeenCalledWith('add_near_opened', { from: 'gift' });
    expect(host.textContent).toContain(ADDRESS);
    expect(onStatus).toHaveBeenLastCalledWith('Waiting for your NEAR…');
  });

  // spec: add-feeding › Add NEAR sheet screen › NEAR пришёл
  it('watches every 5 s; NEAR that came is «Your NEAR is here!» for 4 s and then hands back to the sheet it came from', async () => {
    await mount();
    await settle();
    expect(mocks.wallet).toHaveBeenCalledTimes(1);
    await settle(WATCH_MS);
    expect(mocks.wallet).toHaveBeenCalledTimes(2);
    mocks.wallet.mockResolvedValue({ address: ADDRESS, balance: '900000000000000000000000', funded: true });
    await settle(WATCH_MS);
    expect(host.textContent).toContain('Your NEAR is here!');
    expect(onStatus).toHaveBeenLastCalledWith('Your NEAR is here!');
    expect(onArrived).not.toHaveBeenCalled();
    await settle(3_900);
    expect(onArrived).not.toHaveBeenCalled();
    await settle(200);
    expect(onArrived).toHaveBeenCalledTimes(1);
    // the watch ended with the arrival
    const asked = mocks.wallet.mock.calls.length;
    await settle(WATCH_MS * 3);
    expect(mocks.wallet).toHaveBeenCalledTimes(asked);
  });

  // spec: add-feeding › Add NEAR sheet screen › NEAR пришёл × the address copied before
  it('NEAR that comes after the address was copied is still announced: «Your NEAR is here!», not «Address copied.»', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(async () => undefined) }, configurable: true });
    await mount();
    await settle();
    const copy = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Copy')!;
    await act(async () => copy.click());
    await settle();
    expect(onStatus).toHaveBeenLastCalledWith('Address copied.');
    mocks.wallet.mockResolvedValue({ address: ADDRESS, balance: '900000000000000000000000', funded: true });
    await settle(WATCH_MS);
    expect(onStatus).toHaveBeenLastCalledWith('Your NEAR is here!');
  });

  // spec: add-feeding › Add NEAR sheet screen › success × session ended
  it('a 401 on the watch ends the session and the step stands as it is; the watch stops', async () => {
    await mount();
    await settle();
    const { WorkerError } = await import('../seams/worker-types');
    mocks.wallet.mockRejectedValue(new WorkerError(401, 'signed_out'));
    await settle(WATCH_MS);
    expect(mocks.auth.endSession).toHaveBeenCalledWith(true, false);
    expect(onClose).not.toHaveBeenCalled();
    expect(host.textContent).toContain(ADDRESS);
    mocks.auth.sessionEnded = true;
    await act(async () => root!.render(<AddNearBody from="feed" onStatus={onStatus} onArrived={onArrived} onClose={onClose} />));
    const asked = mocks.wallet.mock.calls.length;
    await settle(WATCH_MS * 3);
    expect(mocks.wallet).toHaveBeenCalledTimes(asked);
  });

  // spec: add-feeding › Add NEAR sheet screen › error
  it('an address that does not load is the error with «Try again», which reads it again', async () => {
    const { WorkerError } = await import('../seams/worker-types');
    mocks.wallet.mockRejectedValueOnce(new WorkerError(503, 'chain_unreachable'));
    await mount();
    await settle();
    expect(host.textContent).toContain("We couldn't show your address right now. Try again in a moment.");
    expect(host.textContent).not.toContain(ADDRESS);
    const retry = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Try again')!;
    await act(async () => retry.click());
    await settle();
    expect(host.textContent).toContain(ADDRESS);
    expect(mocks.wallet).toHaveBeenCalledTimes(2);
  });
});
