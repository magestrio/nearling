// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Line } from '../screens/pet/usePetScreen';

const { verificationThought } = vi.hoisted(() => ({ verificationThought: vi.fn() }));
vi.mock('../seams/worker', () => ({ workerApi: { verificationThought } }));
import { ReportMessage } from './reportLines';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const line: Line = { id: 'e1', who: 'pet', text: 'The operator lists a lower fare.', report: {
  form: 'find', verdict: null, top: null, sources: [], meta: '3 searches · 1.4¢', missed: [], card: null,
} };
let host: HTMLElement;
let root: Root;
const mount = async () => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<ReportMessage line={line} name="Pixel" tokenId="9" reveal={false} tokenOf={async () => 'token'} />));
};

beforeEach(() => { vi.useFakeTimers(); verificationThought.mockReset(); });
afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); vi.useRealTimers(); });

// spec: add-pet-experience › Experience capture flow › eligible report
it('refreshes an unbilled report and shows the note only after its debit settles', async () => {
  verificationThought.mockResolvedValueOnce({ viewer: 'owner', status: 'unbilled', paidWork: false })
    .mockResolvedValueOnce({ viewer: 'owner', status: 'billed', paidWork: true, containsWorkNote: true });
  await mount();
  expect(host.textContent).not.toContain('New work note');
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(host.textContent).toContain('New work note');
  expect(host.textContent).toContain('Review experience');
  expect(verificationThought).toHaveBeenCalledTimes(2);
});

// spec: add-pet-experience › Experience capture flow › no paid report
it('stops checking a billed older errand that has no experience marker', async () => {
  verificationThought.mockResolvedValue({ viewer: 'owner', status: 'billed', debitTxHash: 'settled-tx', paidWork: false });
  await mount();
  expect(host.textContent).toContain('No work note this time');
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
  expect(verificationThought).toHaveBeenCalledTimes(1);
});

// spec: add-pet-experience › Experience record contract › storage pool cannot cover first count
it('replaces the report price with the pool refusal and shows no note result', async () => {
  verificationThought.mockResolvedValue({ viewer: 'owner', billing: 'refused', code: 'pool_empty', paidWork: false });
  await mount();
  expect(host.textContent).toContain('Work is paused. Nothing was spent.');
  expect(host.textContent).not.toContain('1.4¢');
  expect(host.textContent).not.toContain('New work note');
  expect(host.textContent).not.toContain('No work note this time');
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); document.dispatchEvent(new Event('visibilitychange')); });
  expect(verificationThought).toHaveBeenCalledTimes(1);
});

// spec: add-pet-experience › Experience record contract › storage pool cannot cover first count
it('leaves the existing price behavior for another debit refusal code', async () => {
  verificationThought.mockResolvedValue({ viewer: 'owner', billing: 'refused', code: 'daily_cap', paidWork: false });
  await mount();
  expect(host.textContent).toContain('3 searches · 1.4¢');
  expect(host.textContent).not.toContain('Work is paused. Nothing was spent.');
  expect(host.textContent).not.toContain('No work note this time');
});
