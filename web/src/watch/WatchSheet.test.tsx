// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ watch: vi.fn(), auth: { needSession: () => true, sessionLine: null, endSession: vi.fn() } }));
vi.mock('../seams/auth', () => ({ useAuth: () => mocks.auth }));
vi.mock('../seams/worker', async () => ({ ...(await import('../seams/worker-types')), workerApi: { watch: mocks.watch } }));
vi.mock('../signin/SignInOutcome', () => ({ useSignInLines: () => [null] }));
vi.mock('../feeding/feedRequest', () => ({ openFeed: vi.fn() }));

import { WatchSheet } from './WatchSheet';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const SAVED = { target: 'NEAR price', savedHourUtc: 0, nextCheck: '2026-11-12T00:00:00.000Z', paused: false,
  latestResult: null, latestReceiptId: null, latestPriceYocto: null, upTo: { cents: 1.1, yocto: '1' } };
const tokenOf = async () => 'token';
let host: HTMLElement;
let root: Root;

function Harness() {
  const [open, setOpen] = useState(true);
  const [draft, setDraft] = useState('');
  return <><button onClick={() => setOpen(true)}>Open watch</button><button className="ds-hotbar__action" aria-haspopup="menu">More</button><WatchSheet tokenId="9" name="Pixel" open={open} draft={draft}
    onDraft={setDraft} onClose={() => setOpen(false)} tokenOf={tokenOf} onOwnerLost={() => undefined} onChanged={() => undefined} /></>;
}

beforeEach(async () => {
  window.matchMedia = ((query: string) => ({ matches: true, media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  mocks.watch.mockReset().mockResolvedValue(SAVED);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<Harness />));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

// spec: add-game-layout › Pet actions menu screen › success (awake owner) × Close Watch sheet
it('returns focus to More after its Watch sheet closes', async () => {
  await act(async () => host.querySelector<HTMLButtonElement>('.ds-sheet__head button[aria-label="Close"]')!.click());
  expect(document.activeElement).toBe(host.querySelector('.ds-hotbar__action'));
});

// spec: add-pet-errands › Watch sheet screen › success
it('uses the Stage column sheet with the public notice beside the watch actions', () => {
  const sheet = host.querySelector('.ds-sheet-layer--column');
  expect(sheet).not.toBeNull();
  expect(sheet?.querySelector('.ds-sheet__body textarea')).not.toBeNull();
  const foot = sheet?.querySelector('.ds-sheet__foot');
  expect(foot?.textContent).toContain("Your target is public on Pixel's page.");
  expect(foot?.textContent).toContain('Stop watch');
  expect(foot?.textContent).toContain('Save watch');
});

// spec: add-pet-errands › Watch sheet screen › success × close and reopen
it('discards an invalid draft when closed and reloads the saved target on reopen', async () => {
  const field = host.querySelector<HTMLTextAreaElement>('textarea')!;
  expect(field.value).toBe('NEAR price');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, ' ');
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => host.querySelector<HTMLButtonElement>('.ds-sheet__foot button:last-child')!.click());
  expect(host.textContent).toContain('Name a topic, release, account or page to watch.');
  await act(async () => host.querySelector<HTMLButtonElement>('.ds-sheet__head button[aria-label="Close"]')!.click());
  await act(async () => host.querySelector<HTMLButtonElement>('button')!.click());
  expect(host.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('NEAR price');
  expect(host.textContent).not.toContain('Name a topic, release, account or page to watch.');
});

// spec: add-pet-errands › Daily watch flow › first check
// spec: add-pet-errands › Daily watch flow › sleeping pause
it('updates the persistent status region when a read brings a result and then a pause', async () => {
  mocks.watch.mockResolvedValue({ ...SAVED, latestResult: 'first', latestPriceYocto: '1700000000000000000000', latestNearUsdRate: '5' });
  await act(async () => document.dispatchEvent(new Event('visibilitychange')));
  expect(host.querySelector('.ds-hidden[role="status"]')?.textContent).toContain('First check saved as a starting point');
  mocks.watch.mockResolvedValue({ ...SAVED, latestResult: 'first', latestPriceYocto: '1700000000000000000000', latestNearUsdRate: '5', pause: 'sleeping' });
  await act(async () => document.dispatchEvent(new Event('visibilitychange')));
  expect(host.querySelector('.ds-hidden[role="status"]')?.textContent).toContain("Pixel is asleep, so today's watch is paused.");
});
