// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WorkerError } from '../seams/worker-types';
import type { AddressAnswer, TrackedDeposit } from './types';

const mocks = vi.hoisted(() => ({ addresses: vi.fn(), track: vi.fn(), clipboard: vi.fn(), event: vi.fn() }));
vi.mock('../track', () => ({ track: mocks.event }));
vi.mock('../seams/worker', () => ({ workerApi: {
  anyChainAddresses: mocks.addresses, anyChainTrack: mocks.track,
} }));
import { AddressSheet } from './AddressSheet';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const answer: AddressAnswer = { tokenId: '9', minimumFoodYocto: '10000000000000000000000', addresses: [
  { chain: 'base', address: `0x${'a'.repeat(40)}`, asset: 'base-usdc', contractAddress: `0x${'b'.repeat(40)}`,
    path: 'base:9', amountUsdc: '0.04', waitSeconds: 120 },
  { chain: 'solana', address: 'F'.repeat(44), asset: 'sol-usdc', contractAddress: 'E'.repeat(44),
    path: 'solana:9', amountUsdc: '0.05', waitSeconds: 180 },
] };
const tracked: TrackedDeposit = { id: 'b'.repeat(32), url: `/pet/9/feed/status/${'b'.repeat(32)}`,
  status: { state: 'waiting_for_owner', source: 'https://basescan.org/tx/test', nearCredit: null, refund: null } };
let host: HTMLElement;
let root: Root;
beforeEach(async () => {
  window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: mocks.clipboard } });
  mocks.clipboard.mockResolvedValue(undefined);
  mocks.addresses.mockResolvedValue(answer);
  mocks.track.mockResolvedValue(tracked);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<AddressSheet request={{ tokenId: '9', name: 'Pixel' }}
    onClose={() => undefined} onBack={() => undefined} />));
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove();
  mocks.addresses.mockReset(); mocks.track.mockReset(); mocks.clipboard.mockReset(); mocks.event.mockReset();
});
const button = (name: string) => [...host.querySelectorAll('button')].find((item) => item.textContent?.includes(name))!;
const click = (element: Element) => act(async () => { element.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

// spec: add-any-chain-feed › Pet address sheet screen › success
// spec: add-any-chain-feed › Pet address deposit flow › address copied
it('shows only live pet-bound Base and Solana offers and copies the selected address', async () => {
  expect(mocks.addresses).toHaveBeenCalledWith('9');
  expect(host.textContent).toContain('0.04 USDC');
  expect(host.textContent).toContain('about 3 minutes');
  expect(host.textContent).toContain('Other tokens or a transfer on the wrong network may not become food');
  await click(button('Copy Base address'));
  expect(mocks.clipboard).toHaveBeenCalledWith(answer.addresses[0]!.address);
  // spec: add-any-chain-feed › Cross-chain playtest data › address copy event
  expect(mocks.event).toHaveBeenCalledExactlyOnceWith('pet_address_copied', { chain: 'base' });
  expect(host.textContent).toContain('Track this deposit');
});

// spec: add-any-chain-feed › Pet address sheet screen › error
// spec: add-any-chain-feed › Pet address deposit flow › signer unavailable
it('offers no stale address after the signer becomes unavailable', async () => {
  await act(async () => root.unmount());
  root = createRoot(host);
  mocks.addresses.mockRejectedValueOnce(new WorkerError(503, 'signer_unavailable'));
  await act(async () => root.render(<AddressSheet request={{ tokenId: '9', name: 'Pixel' }}
    onClose={() => undefined} onBack={() => undefined} />));
  expect(host.textContent).toContain('Address or rate unavailable. Check again before sending.');
  expect(button('Copy Base address')).toBeUndefined();
  await click(button('Try again'));
  expect(button('Copy Base address')).toBeDefined();
});

// spec: add-any-chain-feed › Pet address deposit flow › signer unavailable
it('rechecks the signer before copying a previously displayed address', async () => {
  mocks.addresses.mockRejectedValueOnce(new WorkerError(503, 'signer_unavailable'));
  await click(button('Copy Base address'));
  expect(mocks.clipboard).not.toHaveBeenCalled();
  expect(mocks.event).not.toHaveBeenCalled();
  expect(button('Copy Base address')).toBeUndefined();
  expect(host.textContent).toContain('Address or rate unavailable. Check again before sending.');
});

// spec: add-any-chain-feed › Cross-chain playtest data › address copy event
it('does not report an address copy when the clipboard rejects it', async () => {
  mocks.clipboard.mockRejectedValueOnce(new Error('clipboard denied'));
  await click(button('Copy Solana address'));
  expect(mocks.event).not.toHaveBeenCalled();
  expect(host.textContent).toContain('Select and copy the details by hand.');
});

// spec: add-any-chain-feed › Pet address deposit flow › address copied
it('rejects an address response derived for a different token_id', async () => {
  await act(async () => root.unmount());
  root = createRoot(host);
  mocks.addresses.mockResolvedValueOnce({ ...answer, addresses: answer.addresses.map((item) =>
    ({ ...item, path: `${item.chain}:2` })) });
  await act(async () => root.render(<AddressSheet request={{ tokenId: '9', name: 'Pixel' }}
    onClose={() => undefined} onBack={() => undefined} />));
  expect(button('Copy Base address')).toBeUndefined();
  expect(host.textContent).toContain('Address or rate unavailable. Check again before sending.');
});

// spec: add-any-chain-feed › Pet address deposit flow › sender obtains status link
// spec: add-any-chain-feed › Pet address data › sender transaction lookup
it('tracks a source hash without a session and returns an opaque public link', async () => {
  await click(host.querySelector('a[href="#track"]')!);
  const field = host.querySelector('input')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, `0x${'c'.repeat(64)}`);
    field.dispatchEvent(new Event('input', { bubbles: true })); });
  await click(button('Track this deposit'));
  expect(mocks.track).toHaveBeenCalledWith({ tokenId: '9', chain: 'base', hash: `0x${'c'.repeat(64)}` });
  expect(host.textContent).toContain('Waiting for owner');
  expect(host.querySelector('textarea')?.value.endsWith(tracked.url)).toBe(true);
  expect(host.textContent).not.toContain('approval');
});

// spec: add-any-chain-feed › Pet address sheet screen › success
it('carries the pet fullness in the sheet head when the sheet it came from had one', async () => {
  await act(async () => root.unmount());
  root = createRoot(host);
  await act(async () => root.render(<AddressSheet request={{ tokenId: '9', name: 'Pixel', fullness: { state: 'hungry', level: 0.25 } }}
    onClose={() => undefined} onBack={() => undefined} />));
  expect(host.querySelector('.ds-sheet__sub')?.textContent).toContain('Hungry');
});
