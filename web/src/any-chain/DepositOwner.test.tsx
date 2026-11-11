// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WorkerError } from '../seams/worker-types';
import type { OwnerDepositRead } from './types';

const mocks = vi.hoisted(() => ({ owner: vi.fn(), quote: vi.fn(), approve: vi.fn(), sign: vi.fn() }));
const auth = { authenticated: true, sessionEnded: false, getIdentityToken: async () => 'identity',
  signNearHash: mocks.sign, needSession: () => true, endSession: vi.fn() };
vi.mock('../seams/auth', () => ({ useAuth: () => auth }));
vi.mock('../seams/worker', () => ({ WorkerError, workerApi: { anyChainOwnerDeposit: mocks.owner,
  anyChainSweepQuote: mocks.quote, anyChainSweepApprove: mocks.approve } }));
import { DepositOwner } from './DepositOwner';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const depositId = 'a'.repeat(32);
const routeId = 'b'.repeat(32);
const address = `0x${'c'.repeat(40)}`;
const read: OwnerDepositRead = { deposit: { id: depositId, token_id: '9', chain: 'base',
  source_tx_hash: `0x${'d'.repeat(64)}`, asset: 'usdc', amount_units: '340000', state: 'waiting',
  address, source_explorer: `https://basescan.org/tx/0x${'d'.repeat(64)}`,
  near_credit_tx: null, source_refund_tx: null }, convertedUnits: '0', sweep: {
    routeId, amountUnits: '200000', destination: address, refundTo: address,
    quote: { quote: { amountIn: '200000', amountInUsd: '0.20', amountOut: '40000000000000000000000',
      amountOutUsd: '0.19', minAmountOut: '39600000000000000000000', refundFee: '0',
      withdrawFee: '0', timeEstimate: 19 } }, approvalHash: 'e'.repeat(64),
    expiryMs: Date.now() + 120_000, state: 'quoted', nearTxHash: null, sourceTxHash: null,
    windowEndsAt: Date.now() + 3_600_000 } };
let host: HTMLElement;
let root: Root;
const show = async () => act(async () => { root.render(<DepositOwner depositId={depositId} tokenId="9"
  name="Pixel" />); });
beforeEach(() => {
  window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  mocks.owner.mockResolvedValue(read);
  mocks.sign.mockResolvedValue(Uint8Array.from({ length: 64 }, (_, index) => index));
  mocks.approve.mockResolvedValue({ state: 'sign_unknown', nearTxHash: 'near-reference' });
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove();
  for (const mock of Object.values(mocks)) mock.mockReset();
  auth.endSession.mockReset();
});

// spec: add-any-chain-feed › Pet address deposit flow › owner authorization pending
// spec: add-any-chain-feed › Pet address data › owner approval leaves browser
it('shows the exact portion and refund recipient, then signs only its approved raw hash', async () => {
  await show();
  expect(host.textContent).toContain('0.2 USDC');
  expect(host.textContent).toContain('0.14 USDC');
  expect(host.textContent).toContain(address);
  const button = [...host.querySelectorAll('button')].find((item) => item.textContent === 'Approve conversion');
  expect(button).toBeDefined();
  await act(async () => button!.click());
  expect(mocks.sign).toHaveBeenCalledWith('e'.repeat(64));
  expect(mocks.approve).toHaveBeenCalledWith('identity', routeId,
    Array.from({ length: 64 }, (_, index) => index.toString(16).padStart(2, '0')).join(''));
});

// spec: add-any-chain-feed › Pet address deposit flow › gift before settlement
it('removes owner recovery controls immediately when current ownership fails', async () => {
  mocks.owner.mockRejectedValueOnce(new WorkerError(403, 'not_owner'));
  await show();
  expect(host.textContent).toContain("This deposit belongs to Pixel's current owner.");
  expect(host.textContent).not.toContain('Approve conversion');
});

// spec: add-any-chain-feed › Pet address deposit flow › owner rejects conversion
it('keeps the deposit at the pet address when the owner dismisses the signature', async () => {
  await show();
  mocks.sign.mockRejectedValueOnce(new Error('User rejected'));
  const button = [...host.querySelectorAll('button')].find((item) => item.textContent === 'Approve conversion');
  await act(async () => button!.click());
  expect(host.textContent).toContain("Conversion not approved. USDC stays at Pixel's address.");
  expect(mocks.approve).not.toHaveBeenCalled();
});

// spec: add-any-chain-feed › Pet address deposit flow › NEAR signing failed
it('reports a wallet signing failure without claiming that the owner rejected', async () => {
  await show();
  mocks.sign.mockRejectedValueOnce(new Error('Wallet transport unavailable'));
  const button = [...host.querySelectorAll('button')].find((item) => item.textContent === 'Approve conversion');
  await act(async () => button!.click());
  expect(host.textContent).toContain("Conversion could not be prepared. USDC remains at Pixel's address.");
  expect(host.textContent).not.toContain('Conversion not approved.');
  mocks.quote.mockResolvedValueOnce({ routeId: 'f'.repeat(32), amountUnits: '200000',
    remainderUnits: '140000', chain: 'base', destination: read.sweep!.destination,
    refundTo: address, quote: read.sweep!.quote.quote, approvalHash: 'f'.repeat(64),
    expiryMs: Date.now() + 300_000 });
  const retry = [...host.querySelectorAll('button')].find((item) => item.textContent === 'Try again');
  await act(async () => retry!.click());
  expect(mocks.quote).toHaveBeenCalledWith('identity', depositId);
});

// spec: add-any-chain-feed › Pet address deposit flow › NEAR signing failed
it('asks for a fresh bounded quote only after Try again on a failed signing', async () => {
  mocks.owner.mockResolvedValue({ ...read, sweep: { ...read.sweep!, state: 'sign_failed',
    nearTxHash: 'N'.repeat(44) } });
  mocks.quote.mockResolvedValue({ routeId: 'f'.repeat(32), amountUnits: '200000',
    remainderUnits: '140000', chain: 'base', destination: read.sweep!.destination,
    refundTo: address, quote: read.sweep!.quote.quote, approvalHash: 'f'.repeat(64),
    expiryMs: Date.now() + 300_000 });
  await show();
  expect(host.textContent).toContain("Conversion could not be prepared. USDC remains at Pixel's address.");
  expect(mocks.quote).not.toHaveBeenCalled();
  const retry = [...host.querySelectorAll('button')].find((item) => item.textContent === 'Try again');
  await act(async () => retry!.click());
  expect(mocks.quote).toHaveBeenCalledWith('identity', depositId);
});

// spec: add-any-chain-feed › Pet address deposit flow › NEAR signing outcome unknown
it('keeps the original NEAR reference and disables another approval while signing is uncertain', async () => {
  mocks.owner.mockResolvedValueOnce(read).mockResolvedValue({ ...read,
    sweep: { ...read.sweep!, state: 'sign_unknown', nearTxHash: 'N'.repeat(44) } });
  await show();
  const approve = [...host.querySelectorAll('button')].find((item) => item.textContent === 'Approve conversion');
  await act(async () => approve!.click());
  expect(host.textContent).toContain('Checking conversion approval. Please wait before trying again.');
  // the reference is drawn short (first 8, last 6) so it fits a phone; the link keeps the whole hash
  expect(host.textContent).toContain('NNNNNNNN…NNNNNN');
  expect([...host.querySelectorAll('button')].filter((item) => item.textContent === 'Approve conversion')).toHaveLength(0);
  expect(mocks.approve).toHaveBeenCalledTimes(1);
});

// spec: add-any-chain-feed › Cross-chain payment status screen › signed-out
it('drops owner-only details when the session expires during the owner read', async () => {
  mocks.owner.mockRejectedValueOnce(new WorkerError(401, 'signed_out'));
  await show();
  expect(host.textContent).not.toContain(address);
  expect(auth.endSession).toHaveBeenCalledWith(true, true);
});

// spec: add-any-chain-feed › Pet address deposit flow › sweep sent
it('names 1-Click\'s reference and a distinct short source link once the sweep has left approval', async () => {
  const sweepHash = `0x${'a'.repeat(64)}`;
  mocks.owner.mockResolvedValue({ ...read, sweep: { ...read.sweep!, state: 'sent', sourceTxHash: sweepHash,
    quote: { quote: { ...read.sweep!.quote.quote, depositAddress: address }, correlationId: '4Vx3h2c7-9d41-4e6a-8b0f-2c1d5a7e4b8E' } } });
  await show();
  expect(host.textContent).toContain('Base · 0xaaa…aaaa');
  expect(host.textContent).toContain('1-Click · 4Vx3h…4b8E');
  expect(host.querySelector(`a[href="https://1click.chaindefuser.com/v0/status?depositAddress=${address}"]`)).not.toBeNull();
  expect(host.textContent).not.toContain('View transfer on Base');
});

// spec: add-any-chain-feed › Pet address deposit flow › owner authorization pending
it('draws no 1-Click reference while the quote still waits for approval', async () => {
  mocks.owner.mockResolvedValue({ ...read, sweep: { ...read.sweep!, quote: { ...read.sweep!.quote, correlationId: 'reference-0001' } } });
  await show();
  expect(host.textContent).not.toContain('1-Click');
});
