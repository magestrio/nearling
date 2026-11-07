// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { Advice } from '../screens/pet/parts';
import type { AdviceRead } from '../seams/worker-types';
import { useAdvice, type Entry } from './useAdvice';
import { POLL_GUEST_MS, POLL_JOB_MS } from '../screens/pet/usePetScreen';

const mocks = vi.hoisted(() => ({ advice: vi.fn(), askAdvice: vi.fn(), petState: vi.fn() }));
vi.mock('../seams/worker', async (original) => ({
  ...(await original<typeof import('../seams/worker')>()),
  workerApi: { advice: mocks.advice, askAdvice: mocks.askAdvice, petState: mocks.petState },
}));
vi.mock('../seams/auth', () => ({ useAuth: () => ({ needSession: () => true, endSession: vi.fn() }) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const read: AdviceRead = {
  price: { yocto: '830000000000000000000', cents: 0.38 }, skilled: false,
  screeningAvailable: true, screeningResetAt: null, workerAsleep: false, resting: null,
  payer: { tokenId: '9', name: 'Pixel', state: 'ok', until: null }, dropsAt: null,
  pending: null, last: null, paused: false,
};
const hostAdvice: Advice = {
  payer: { tokenId: '9', name: 'Pixel' }, tokenOf: async () => 'token', report: vi.fn(),
  payerChanged: vi.fn(), look: vi.fn(), onStatus: vi.fn(), covered: false,
  check: null, offline: '', carried: null, takeCarried: vi.fn(),
};
let root: ReturnType<typeof createRoot> | null = null;
let host: HTMLDivElement;
let current: ReturnType<typeof useAdvice>;
function Hook() {
  current = useAdvice({ tokenId: '2', name: 'Biscuit', asleep: false }, hostAdvice);
  return <div data-closed={current.screeningClosed}>{current.entries.map((entry: Entry) => <p key={entry.id} data-kind={entry.kind}>{entry.kind === 'asked' ? entry.text : entry.kind}</p>)}</div>;
}
async function mount() {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(<Hook />));
}
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove(); root = null; vi.useRealTimers(); vi.clearAllMocks();
});

// spec: add-pet-will › Character refusal flow › refusal capacity reached
it('clears a closed screening only when a fresh Worker read says capacity returned', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-06T23:50:00.000Z'));
  mocks.advice.mockResolvedValueOnce({ ...read, screeningAvailable: false, screeningResetAt: '2026-11-07T00:00:00.000Z' })
    .mockResolvedValueOnce({ ...read, screeningAvailable: true, screeningResetAt: null });
  await mount();
  expect(current.screeningClosed).toBe(true);
  await act(async () => { await vi.advanceTimersByTimeAsync(POLL_GUEST_MS); });
  expect(current.screeningClosed).toBe(false);
  expect(Date.now()).toBeLessThan(Date.parse('2026-11-07T00:00:00.000Z'));
});

// spec: add-pet-will › Character refusal flow › no signed answer
it('shows a retried question once after a failed screening', async () => {
  vi.useFakeTimers();
  mocks.advice.mockResolvedValue(read);
  mocks.askAdvice.mockResolvedValueOnce({ job: 'first' }).mockResolvedValueOnce({ job: 'retry' });
  mocks.petState.mockResolvedValueOnce({ pending: false, code: 'screening_failed', jobKind: 'advice' })
    .mockResolvedValue({ pending: true });
  await mount();
  await act(async () => current.ask('Can you help?'));
  await act(async () => { await vi.advanceTimersByTimeAsync(POLL_JOB_MS); });
  expect(current.entries.some((entry) => entry.kind === 'error' && entry.code === 'screening_failed')).toBe(true);
  expect(current.entries.filter((entry) => entry.kind === 'asked' && entry.text === 'Can you help?')).toHaveLength(1);
  await act(async () => current.retry());
  expect(current.entries.filter((entry) => entry.kind === 'asked' && entry.text === 'Can you help?')).toHaveLength(1);
});
