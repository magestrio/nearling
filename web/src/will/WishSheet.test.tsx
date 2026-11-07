// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { WishSheet, useWishSheet, wishProgress } from './WishSheet';
import type { WishRead } from '../seams/worker';
import { WorkerError } from '../seams/worker';

const mocks = vi.hoisted(() => ({ wish: vi.fn(), cancel: vi.fn(), resume: vi.fn() }));
vi.mock('../seams/worker', async (original) => ({
  ...(await original<typeof import('../seams/worker')>()),
  workerApi: { wish: mocks.wish, cancelWish: mocks.cancel, continueWish: mocks.resume },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const price = { cents: 0.76, yocto: '1660000000000000000000' };
const read: WishRead = { active: true, reserveYocto: '660000000000000000000', releaseStatus: null, wish: {
  item: 'smart-glasses', reason: 'I want to see every tiny detail.', status: 'active', reserveYocto: '660000000000000000000',
} };
let root: ReturnType<typeof createRoot> | null = null;
let host: HTMLDivElement;

afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); root = null; vi.clearAllMocks(); });

function render(error = false, view: WishRead = read, onCancel = vi.fn(), onRetry = vi.fn(), onClose = vi.fn()) {
  window.matchMedia = vi.fn().mockReturnValue({ matches: true, addEventListener() {}, removeEventListener() {} });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  return act(async () => root!.render(<WishSheet name="Pixel" price={price} read={view} error={error} busy={false}
    onClose={onClose} onCancel={onCancel} onRetry={onRetry} onContinue={vi.fn()} />));
}

// spec: add-pet-will › Wish sheet screen › success
it('shows cents before exact NEAR, the private target, the reserve notice and cancellation', async () => {
  const cancel = vi.fn();
  await render(false, read, cancel);
  expect(wishProgress(read.wish!, price)).toEqual({ fraction: 0.3975, cents: 'Saved 0.30¢ of 0.76¢', near: '0.00066 of 0.00166 NEAR' });
  expect(host.textContent).toContain('Smart glasses');
  expect(host.textContent).toContain('I want to see every tiny detail.');
  expect(host.textContent).toContain('Saved 0.30¢ of 0.76¢');
  expect(host.textContent).toContain('0.00066 of 0.00166 NEAR');
  expect(host.textContent).toContain('Earned food only');
  expect(host.querySelector('.ds-facts')?.textContent?.trim()).toBe('Earned food only');
  expect(host.textContent).toContain("Saved food and a bought outfit are public on NEAR forever. The wish's words stay private.");
  await act(async () => (Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Cancel wish'))!.click());
  expect(cancel).toHaveBeenCalledOnce();
});

// spec: add-pet-will › Wish sheet screen › error
// spec: add-pet-will › Wish sheet screen › error × Cancel wish unavailable
// spec: add-pet-will › Wish sheet screen › error × Purchase unavailable
it('offers only retry when fresh ownership or chain read fails', async () => {
  const cancel = vi.fn();
  const retry = vi.fn();
  await render(true, null as unknown as WishRead, cancel, retry);
  expect(host.textContent).toContain('Wish unavailable. Try again.');
  expect(Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Try again')?.classList.contains('ds-button--block')).toBe(true);
  expect(host.textContent).not.toContain('Cancel wish');
  expect(host.textContent).not.toContain('Smart glasses');
  await act(async () => (Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Try again'))!.click());
  expect(retry).toHaveBeenCalledOnce();
  expect(cancel).not.toHaveBeenCalled();
});

// spec: add-pet-will › Wish sheet screen › success × Close
it('moves focus into the sheet and returns it to its opener after Esc closes it', async () => {
  const opener = document.createElement('button');
  opener.textContent = "Pixel's wish";
  document.body.append(opener);
  opener.focus();
  const close = vi.fn();
  await render(false, read, vi.fn(), vi.fn(), close);
  expect(host.querySelector('[role="dialog"]')?.contains(document.activeElement)).toBe(true);
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(close).toHaveBeenCalledOnce();
  await act(async () => root?.unmount());
  expect(document.activeElement).toBe(opener);
  opener.remove();
  root = null;
});

// spec: add-pet-will › Wish pursuit flow › purchase waits for daily reset
it('shows a full reserve as waiting without claiming the outfit is owned', async () => {
  await render(false, { ...read, wish: { ...read.wish!, status: 'waiting_day', reserveYocto: price.yocto } });
  expect(host.textContent).toContain('Buying tomorrow');
  expect(host.textContent).toContain('Saved 0.76¢ of 0.76¢');
  expect(host.textContent).not.toContain('earned Smart glasses');
});

// spec: add-pet-will › Will ownership rule › gift confirmed
// spec: add-pet-will › Will ownership rule › new owner continues
it('lets the new owner continue the inherited wish once and rereads its active state', async () => {
  window.matchMedia = vi.fn().mockReturnValue({ matches: true, addEventListener() {}, removeEventListener() {} });
  const paused: WishRead = { ...read, active: false, wish: { ...read.wish!, status: 'paused' } };
  mocks.wish.mockResolvedValueOnce(paused).mockResolvedValueOnce({ ...read, wish: { ...read.wish!, status: 'active' } });
  mocks.resume.mockResolvedValue({ status: 'active' });
  const released = vi.fn();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(<Hook lost={vi.fn()} released={released} />));
  await act(async () => (host.querySelector('button') as HTMLButtonElement).click());
  expect(host.textContent).toContain('Pixel has a wish in progress');
  await act(async () => (Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Continue wish'))!.click());
  expect(mocks.resume).toHaveBeenCalledOnce();
  expect(mocks.cancel).not.toHaveBeenCalled();
  expect(host.textContent).not.toContain('Pixel has a wish in progress');
  expect(released).toHaveBeenCalledOnce();
});

// spec: add-pet-will › Will ownership rule › new owner continues
it('refreshes Pet and hides an old release error when Continue confirms an active wish', async () => {
  window.matchMedia = vi.fn().mockReturnValue({ matches: true, addEventListener() {}, removeEventListener() {} });
  const paused: WishRead = { ...read, active: false, releaseStatus: 'failed', wish: { ...read.wish!, status: 'paused' } };
  const continued: WishRead = { ...read, releaseStatus: 'failed' };
  mocks.wish.mockResolvedValueOnce(paused).mockResolvedValueOnce(continued);
  mocks.resume.mockResolvedValue({ status: 'active' });
  const released = vi.fn();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(<Hook lost={vi.fn()} released={released} />));
  await act(async () => (host.querySelector('button') as HTMLButtonElement).click());
  expect(host.textContent).toContain('Wish cancellation failed. Try again.');
  await act(async () => (Array.from(host.querySelectorAll('button')).find((button) => button.textContent === 'Continue wish'))!.click());
  expect(mocks.resume).toHaveBeenCalledOnce();
  expect(released).toHaveBeenCalledOnce();
  expect(host.textContent).not.toContain('Wish cancellation failed. Try again.');
  expect(host.textContent).not.toContain('Pixel has a wish in progress');
});

// spec: add-pet-will › Will ownership rule › new owner continues × Pending operation
it('keeps a pending continuation disabled until a fresh read sees the active wish', async () => {
  window.matchMedia = vi.fn().mockReturnValue({ matches: true, addEventListener() {}, removeEventListener() {} });
  const paused: WishRead = { ...read, active: false, wish: { ...read.wish!, status: 'paused' } };
  mocks.wish.mockResolvedValueOnce(paused).mockResolvedValueOnce(paused).mockResolvedValueOnce(read);
  mocks.resume.mockResolvedValue({ code: 'wish_pending' });
  const released = vi.fn();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(<Hook lost={vi.fn()} released={released} />));
  await act(async () => (host.querySelector('button') as HTMLButtonElement).click());
  await act(async () => (Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Continue wish'))!.click());
  expect(Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Continue wish')?.getAttribute('aria-disabled')).toBe('true');
  expect(mocks.resume).toHaveBeenCalledOnce();
  await act(async () => document.dispatchEvent(new Event('visibilitychange')));
  expect(host.textContent).not.toContain('Pixel has a wish in progress');
  expect(released).toHaveBeenCalledOnce();
});

function Hook({ lost, released }: { lost: () => void; released: () => void }) {
  const sheet = useWishSheet('9', 'Pixel', price, async () => 'token', lost, released);
  return <><button onClick={sheet.open}>Open wish</button>{sheet.node}</>;
}

// spec: add-pet-will › Wish pursuit flow › owner cancels
it('keeps a pending release open and disables a second cancellation until a fresh read confirms it', async () => {
  window.matchMedia = vi.fn().mockReturnValue({ matches: true, addEventListener() {}, removeEventListener() {} });
  mocks.wish.mockResolvedValue(read);
  mocks.cancel.mockResolvedValue({ status: 'pending' });
  const released = vi.fn();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(<Hook lost={vi.fn()} released={released} />));
  await act(async () => (host.querySelector('button') as HTMLButtonElement).click());
  await act(async () => (Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Cancel wish'))!.click());
  expect(host.querySelector('[role="dialog"]')).not.toBeNull();
  expect(Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Cancel wish')?.getAttribute('aria-disabled')).toBe('true');
  expect(mocks.cancel).toHaveBeenCalledOnce();
  mocks.wish.mockResolvedValueOnce({ wish: null, reserveYocto: '0', active: false, releaseStatus: 'confirmed' });
  await act(async () => document.dispatchEvent(new Event('visibilitychange')));
  expect(host.querySelector('[role="dialog"]')).toBeNull();
  expect(released).toHaveBeenCalledOnce();
});

// spec: add-pet-will › Wish pursuit flow › owner cancels
it('lets the owner close an unknown release, then offers cancellation again after a failed release read', async () => {
  window.matchMedia = vi.fn().mockReturnValue({ matches: true, addEventListener() {}, removeEventListener() {} });
  const unknown = { ...read, releaseStatus: 'unknown' as const };
  const failed = { ...read, releaseStatus: 'failed' as const, wish: { ...read.wish!, status: 'paused' as const } };
  mocks.wish.mockResolvedValueOnce(read).mockResolvedValueOnce(unknown).mockResolvedValueOnce(unknown).mockResolvedValueOnce(failed);
  mocks.cancel.mockResolvedValue({ status: 'pending' });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(<Hook lost={vi.fn()} released={vi.fn()} />));
  await act(async () => (host.querySelector('button') as HTMLButtonElement).click());
  await act(async () => (Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Cancel wish'))!.click());
  expect(Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Cancel wish')?.getAttribute('aria-disabled')).toBe('true');
  await act(async () => (Array.from(host.querySelectorAll('button')).find((b) => b.getAttribute('aria-label') === 'Close')!).click());
  expect(host.querySelector('[role="dialog"]')).toBeNull();
  await act(async () => (host.querySelector('button') as HTMLButtonElement).click());
  await act(async () => document.dispatchEvent(new Event('visibilitychange')));
  expect(host.textContent).toContain('Wish cancellation failed. Try again.');
  expect(Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Cancel wish')?.getAttribute('aria-disabled')).not.toBe('true');
  await act(async () => (Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Cancel wish'))!.click());
  expect(mocks.cancel).toHaveBeenCalledTimes(2);
});

// spec: add-pet-will › Will ownership rule › former owner opens
it('removes private words when the fresh owner check refuses the read', async () => {
  window.matchMedia = vi.fn().mockReturnValue({ matches: true, addEventListener() {}, removeEventListener() {} });
  mocks.wish.mockResolvedValueOnce(read).mockRejectedValueOnce(new WorkerError(403, 'not_owner'));
  const lost = vi.fn();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(<Hook lost={lost} released={vi.fn()} />));
  await act(async () => (host.querySelector('button') as HTMLButtonElement).click());
  expect(host.textContent).toContain('I want to see every tiny detail.');
  await act(async () => document.dispatchEvent(new Event('visibilitychange')));
  expect(host.textContent).not.toContain('I want to see every tiny detail.');
  expect(lost).toHaveBeenCalledOnce();
});
