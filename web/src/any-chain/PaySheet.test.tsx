// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { QuoteAnswer } from './types';

const mocks = vi.hoisted(() => ({
  tokens: vi.fn(), quote: vi.fn(), accept: vi.fn(),
}));
vi.mock('../seams/worker', () => ({ workerApi: {
  anyChainTokens: mocks.tokens, anyChainQuote: mocks.quote, anyChainAccept: mocks.accept,
} }));

import { PaySheet } from './PaySheet';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const token = { assetId: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near',
  blockchain: 'base', symbol: 'USDC', decimals: 6, price: 1, contractAddress: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' };
const quote: QuoteAnswer = { id: 'a'.repeat(32), signature: 'signature', providerReference: 'reference', quote: {
  amountIn: '250000', amountInUsd: '0.25', amountOut: '49000000000000000000000', amountOutUsd: '0.23',
  minAmountOut: '48510000000000000000000', refundFee: '10000', withdrawFee: '0', timeEstimate: 120,
} };
let root: Root;
let host: HTMLElement;
beforeEach(async () => {
  window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  mocks.tokens.mockResolvedValue({ tokens: [token] });
  mocks.quote.mockResolvedValue(quote);
  mocks.accept.mockResolvedValue({ ...quote, serverTime: new Date(Date.now()).toUTCString(), refundTo: '0x' + 'b'.repeat(40), quote: {
    ...quote.quote, depositAddress: '0x' + 'c'.repeat(40), depositMemo: 'pixel-9-quote',
    // relative to now: a fixed date passes and the address reads as expired (it did at 2026-11-11 20:40 UTC)
    timeWhenInactive: new Date(Date.now() + 300_000).toISOString(), deadline: new Date(Date.now() + 600_000).toISOString(),
  } });
  host = document.createElement('div'); document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<PaySheet request={{ tokenId: '9', name: 'Pixel' }} onClose={() => undefined} onBack={() => undefined} column />));
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove();
  mocks.tokens.mockReset(); mocks.quote.mockReset(); mocks.accept.mockReset();
});
const field = (label: string) => host.querySelector<HTMLInputElement>(`#${[...host.querySelectorAll('label')].find((l) => l.textContent?.includes(label))?.getAttribute('for')}`)!;
async function type(label: string, value: string) {
  await act(async () => { const input = field(label); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true })); });
}
const button = (name: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(name))!;
const click = (element: Element) => act(async () => { element.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

// spec: add-any-chain-feed › Cross-chain quote flow › guest quote
// spec: add-any-chain-feed › Cross-chain pay sheet screen › success
it('quotes without a session, shows live facts, and accepts only after the quote', async () => {
  await type('Return address', '0x' + 'b'.repeat(40));
  await click(button('Get payment address'));
  expect(mocks.quote).toHaveBeenCalledWith({ tokenId: '9', originAsset: token.assetId, amount: '0.25', refundTo: '0x' + 'b'.repeat(40) });
  expect(host.textContent).toContain('0.04851 NEAR');
  expect(host.textContent).toContain('Exchange and transfer fees$0.02');
  expect(host.textContent).toContain('Get payment address');
  await click(button('Get payment address'));
  expect(mocks.accept).toHaveBeenCalledWith('a'.repeat(32));
  expect(host.textContent).toContain('View payment status');
  expect(host.textContent).toContain('Your wallet sends the payment and pays its network fee.');
  expect(host.textContent).toContain('Amount to send0.25 USDC');
  expect(host.querySelectorAll('textarea[readonly]')).toHaveLength(2);
});

// spec: add-any-chain-feed › Cross-chain quote flow › quote created
it('copies the accepted chain, asset and exact amount with the destination', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  await type('Return address', '0x' + 'b'.repeat(40));
  await click(button('Get payment address'));
  await click(button('Get payment address'));
  await click(button('Copy payment details'));
  expect(writeText).toHaveBeenCalledWith(expect.stringContaining('Pay from: Base\nPay with: USDC\nAmount to send: 0.25 USDC'));
  expect(writeText.mock.calls[0]![0]).toContain('Send to this address: ' + '0x' + 'c'.repeat(40));
});

// spec: add-any-chain-feed › Origin transfer data › source transfer leaves wallet
// spec: add-any-chain-feed › Cross-chain quote flow › quote created
it('keeps the accepted origin when the initial token list arrives after the fallback quote', async () => {
  const late = { ...token, assetId: 'nep141:base-eth.omft.near', symbol: 'ETH', decimals: 18, price: 3200 };
  let finishInitial!: (value: { tokens: typeof token[] }) => void;
  mocks.tokens.mockReset();
  mocks.tokens.mockImplementationOnce(() => new Promise((resolve) => { finishInitial = resolve; }));
  mocks.tokens.mockResolvedValue({ tokens: [token] });
  await act(async () => root.unmount()); root = createRoot(host);
  await act(async () => root.render(<PaySheet request={{ tokenId: '9', name: 'Pixel' }} onClose={() => undefined} onBack={() => undefined} column />));
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  await type('Return address', '0x' + 'b'.repeat(40));
  await click(button('Get payment address'));
  await click(button('Get payment address'));
  await act(async () => finishInitial({ tokens: [late, token] }));
  expect(host.textContent).toContain('Amount to send0.25 USDC');
  await click(button('Copy payment details'));
  expect(writeText).toHaveBeenCalledWith(expect.stringContaining('Pay from: Base\nPay with: USDC\nAmount to send: 0.25 USDC'));
});

// spec: add-any-chain-feed › Cross-chain availability rule › changed quote
it('counts acceptance transit against the destination lifetime', async () => {
  let finishAccept!: (value: QuoteAnswer) => void;
  mocks.accept.mockImplementationOnce(() => new Promise((resolve) => { finishAccept = resolve; }));
  await type('Return address', '0x' + 'b'.repeat(40));
  await click(button('Get payment address'));
  let elapsed = 0;
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
  await act(async () => { button('Get payment address').dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  elapsed = 2000;
  await act(async () => finishAccept({ ...quote, serverTime: new Date().toUTCString(), quote: {
    ...quote.quote, depositAddress: '0x' + 'c'.repeat(40),
    timeWhenInactive: new Date(Date.now() + 2500).toISOString(), deadline: new Date(Date.now() + 60_000).toISOString(),
  } }));
  expect(host.textContent).toContain('This quote expired. Get a new quote before sending.');
  expect(host.querySelectorAll('textarea[readonly]')).toHaveLength(0);
  expect(button('Copy payment details')).toBeUndefined();
  clock.mockRestore();
});

// spec: add-any-chain-feed › Cross-chain availability rule › changed quote
it('uses Worker time to hide an already inactive address even when the device clock is behind', async () => {
  const expired = new Date(Date.now() + 60_000).toISOString();
  mocks.accept.mockResolvedValueOnce({ ...quote, serverTime: new Date(Date.now() + 120_000).toUTCString(),
    quote: { ...quote.quote, depositAddress: '0x' + 'c'.repeat(40), timeWhenInactive: expired,
      deadline: new Date(Date.now() + 180_000).toISOString() } });
  await type('Return address', '0x' + 'b'.repeat(40));
  await click(button('Get payment address'));
  await click(button('Get payment address'));
  expect(host.textContent).toContain('This quote expired. Get a new quote before sending.');
  expect(host.querySelectorAll('textarea[readonly]')).toHaveLength(0);
  expect(button('Get a new quote')).toBeDefined();
  await click(button('Get a new quote'));
  expect(field('Amount to send').value).toBe('0.25');
});

// spec: add-any-chain-feed › Cross-chain quote flow › unsupported origin
it('offers every listed chain and asset with its live price', async () => {
  const other = { ...token, assetId: 'nep141:base-eth.omft.near', symbol: 'ETH', decimals: 18, price: 3200 };
  const third = { ...token, assetId: 'nep141:arb-usdt.omft.near', blockchain: 'arb', symbol: 'USDT', price: 1 };
  mocks.tokens.mockResolvedValueOnce({ tokens: [token, other, third] });
  await act(async () => root.unmount());
  root = createRoot(host);
  await act(async () => root.render(<PaySheet request={{ tokenId: '9', name: 'Pixel' }} onClose={() => undefined} onBack={() => undefined} column />));
  expect(host.textContent).toContain('ETH');
  expect(host.textContent).toContain('$3,200');
  await act(async () => host.querySelector<HTMLInputElement>('input[value="arb"]')!.click());
  expect(host.textContent).toContain('USDT');
  await type('Return address', '0x' + 'b'.repeat(40));
  await click(button('Get payment address'));
  expect(mocks.quote).toHaveBeenCalledWith(expect.objectContaining({ originAsset: third.assetId }));
});

// spec: add-any-chain-feed › Cross-chain availability rule › changed quote
it('removes the old payment destination when an acceptance expires', async () => {
  await type('Return address', '0x' + 'b'.repeat(40));
  await click(button('Get payment address'));
  mocks.accept.mockRejectedValueOnce(new (await import('../seams/worker-types')).WorkerError(409, 'quote_expired'));
  await click(button('Get payment address'));
  expect(host.textContent).toContain('This quote expired. Get a new quote before sending.');
  expect(host.querySelectorAll('textarea[readonly]')).toHaveLength(0);
});

// spec: add-any-chain-feed › Cross-chain quote flow › quote below minimum
it('shows the minimum refusal without an address or payment action', async () => {
  mocks.quote.mockRejectedValueOnce(new (await import('../seams/worker-types')).WorkerError(409, 'below_minimum'));
  await type('Return address', '0x' + 'b'.repeat(40));
  await click(button('Get payment address'));
  expect(host.textContent).toContain('Too little food after fees. Try a larger amount.');
  expect(button('Get payment address')).toBeUndefined();
  expect(host.querySelectorAll('textarea[readonly]')).toHaveLength(0);
});

// spec: add-any-chain-feed › Cross-chain pay sheet screen › error
// spec: add-any-chain-feed › Cross-chain quote flow › unsupported origin
// spec: add-any-chain-feed › Cross-chain quote flow › quote above portion ceiling
// spec: add-any-chain-feed › Cross-chain availability rule › services paused
// spec: add-any-chain-feed › Cross-chain availability rule › pending capacity full
// spec: add-any-chain-feed › Cross-chain availability rule › pending stake unavailable
// spec: add-any-chain-feed › Cross-chain availability rule › receiver not registered
it.each([
  ['provider_unavailable', 'No payable quote right now. Choose another amount or asset.'],
  ['unsupported_origin', 'This chain or asset is not available now.'],
  ['above_ceiling', 'This is above the meal limit. Try a smaller amount.'],
  ['paused', 'New cross-chain payments are paused. Deposits already sent can still arrive.'],
  ['capacity_full', 'Cross-chain payment is busy. Try again later.'],
  ['pending_stake_unavailable', 'Cross-chain payment is unavailable while NEAR delivery is set up.'],
  ['receiver_unregistered', 'Cross-chain payment is unavailable while NEAR delivery is set up.'],
])('%s leaves no copyable destination', async (code, line) => {
  mocks.quote.mockRejectedValueOnce(new (await import('../seams/worker-types')).WorkerError(409, code));
  await type('Return address', '0x' + 'b'.repeat(40));
  await click(button('Get payment address'));
  expect(host.textContent).toContain(line);
  expect(host.querySelectorAll('textarea[readonly]')).toHaveLength(0);
  expect(button('Get payment address')).toBeUndefined();
});

// spec: add-any-chain-feed › Cross-chain pay sheet screen › success
it('pins the public-transfer notice with the action it belongs to, above it', async () => {
  await type('Return address', '0x' + 'b'.repeat(40));
  await click(button('Get payment address'));
  const foot = host.querySelector('.ds-sheet__foot')!;
  expect(foot.textContent).toContain('Your transfer and any food added on NEAR will be public.');
  expect(host.querySelector('.ds-sheet__body')!.textContent).not.toContain('Your transfer and any food added on NEAR will be public.');
  expect(foot.lastElementChild!.textContent).toContain('Get payment address');
});
