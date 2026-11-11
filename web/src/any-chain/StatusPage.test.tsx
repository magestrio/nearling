// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WorkerError } from '../seams/worker-types';
import type { QuoteStatus } from './types';

const mocks = vi.hoisted(() => ({ pet: vi.fn(), status: vi.fn(), deposit: vi.fn(), held: vi.fn(), begin: vi.fn(),
  sessionEnded: false, authenticated: false }));
vi.mock('../seams/worker', () => ({ workerApi: { pet: mocks.pet, anyChainStatus: mocks.status,
  anyChainDepositStatus: mocks.deposit, anyChainHeldStatus: mocks.held }, WorkerError }));
vi.mock('../seams/auth', () => ({ useAuth: () => ({ authenticated: mocks.authenticated, sessionEnded: mocks.sessionEnded,
  getIdentityToken: async () => null }) }));
vi.mock('../signin/signIn', () => ({ useSignIn: () => ({ begin: mocks.begin }) }));
vi.mock('../pet/PetFigure', () => ({ ELEVATION: 0, PetFigure: () => <div data-testid="pet" /> }));
import { StatusPage } from './StatusPage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const id = 'a'.repeat(32);
const quote: QuoteStatus = { id, tokenId: '9', state: 'delivery_unverified', providerState: 'SUCCESS',
  sourceChain: 'base',
  providerReference: 'provider-ref', sourceTxHash: `0x${'b'.repeat(64)}`, sourceCondition: 'observed',
  providerRefundAmount: null, providerRefundTxHash: null, refundTo: `0x${'c'.repeat(40)}`, deliveries: [] };
let root: Root;
let host: HTMLElement;
const render = async () => { await act(async () => root.render(<StatusPage tokenId="9" paymentId={id} />)); };
beforeEach(() => {
  mocks.sessionEnded = false;
  mocks.authenticated = false;
  window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  mocks.pet.mockResolvedValue({ tokenId: '9', name: 'Pixel', stage: 'adult', fullness: { state: 'asleep', level: 0 },
    mood: null, worn: null, skill: null, viewer: 'visitor' });
  mocks.status.mockResolvedValue(quote);
  mocks.deposit.mockRejectedValue(new WorkerError(404, 'deposit_missing'));
  mocks.held.mockRejectedValue(new WorkerError(404, 'held_missing'));
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove();
  for (const mock of Object.values(mocks)) if (typeof mock === 'function') mock.mockReset();
});

// spec: add-any-chain-feed › Cross-chain payment status screen › signed-out
it('keeps a deposit sender link public after the prior session expires', async () => {
  mocks.sessionEnded = true;
  mocks.authenticated = true;
  mocks.status.mockRejectedValueOnce(new WorkerError(404, 'payment_missing'));
  mocks.deposit.mockResolvedValueOnce({ id, tokenId: '9', state: 'waiting_for_owner', source: 'https://basescan.org/tx/source',
    nearCredit: null, refund: null });
  await render();
  expect(host.textContent).toContain('Waiting for owner');
  expect(host.textContent).toContain('Sign in to see this deposit');
});

// spec: add-any-chain-feed › Cross-chain payment status screen › asleep
// spec: add-any-chain-feed › Cross-chain payment status screen › signed-out
it('reads a public bearer link, keeps the asleep notice, and shows no food without a credit', async () => {
  await render();
  expect(mocks.status).toHaveBeenCalledWith(id);
  expect(host.textContent).toContain('Still on its way');
  expect(host.textContent).toContain('Pixel is asleep. Food will wake them after the NEAR credit confirms.');
  expect(host.querySelector('a[href*="basescan.org"]')).not.toBeNull();
  expect(host.textContent).not.toContain('View NEAR credit');
  expect([...host.querySelectorAll('button')].some((item) => item.textContent === 'Feed Pixel')).toBe(true);
});

// spec: add-any-chain-feed › Cross-chain payment status screen › empty
it('refuses a deposit link whose pet ID differs from the route', async () => {
  mocks.status.mockRejectedValueOnce(new WorkerError(404, 'payment_missing'));
  mocks.deposit.mockResolvedValueOnce({ id, tokenId: '2', state: 'became_food', source: 'https://basescan.org/tx/source',
    nearCredit: 'https://nearblocks.io/txns/credit', refund: null });
  await render();
  expect(host.textContent).toContain('No payment found here.');
  expect(host.textContent).not.toContain('Became food');
  expect(host.textContent).not.toContain('View NEAR credit');
});

// spec: add-any-chain-feed › Cross-chain payment status screen › asleep
it('offers another Feed route to a signed-in player while payment is unsettled', async () => {
  mocks.authenticated = true;
  await render();
  expect(host.textContent).toContain('Pixel is asleep. Food will wake them after the NEAR credit confirms.');
  expect([...host.querySelectorAll('button')].some((item) => item.textContent === 'Feed Pixel')).toBe(true);
});

// spec: add-any-chain-feed › Cross-chain quote data › status link shared
it('shows the quoted amount and route with a working provider-status link', async () => {
  mocks.status.mockResolvedValueOnce({ ...quote, sourceAmount: '150000', sourceAsset: 'USDC',
    sourceChain: 'base', providerStatusUrl: 'https://1click.chaindefuser.com/v0/status?depositAddress=shown' });
  await render();
  expect(host.textContent).toContain('Amount sent');
  expect(host.textContent).toContain('0.15 USDC');
  expect(host.textContent).toContain('Base → NEAR');
  const link = [...host.querySelectorAll('a')].find((item) => item.textContent === 'View exchange status');
  expect(link?.href).toBe('https://1click.chaindefuser.com/v0/status?depositAddress=shown');
});

// spec: add-any-chain-feed › Cross-chain payment status screen › empty
it('shows an empty route only after both public status reads miss', async () => {
  mocks.status.mockRejectedValueOnce(new WorkerError(404, 'payment_missing'));
  await render();
  expect(mocks.deposit).toHaveBeenCalledWith(id);
  expect(host.textContent).toContain('No payment found here.');
});

// spec: add-any-chain-feed › Cross-chain payment status screen › error
it('keeps a provider outage distinct from a missing route', async () => {
  mocks.status.mockRejectedValueOnce(new WorkerError(503, 'chain_unreachable'));
  await render();
  expect(host.textContent).toContain('Payment status is unavailable. Your transfer may still be on its way.');
  expect(mocks.deposit).not.toHaveBeenCalled();
});

// spec: add-any-chain-feed › Cross-chain settlement data › held delivery reconciled
it('reads held evidence separately and never treats provider success as food', async () => {
  mocks.status.mockResolvedValueOnce({ ...quote, state: 'held', deliveries: [{ receiptId: 'receipt',
    nearTxHash: '4NaHJ39MtdVKeEXbg2XdNgqSRLmALibhoyyoGCHcAoKH', amount: '41440000000000000000000',
    kind: 'held', creditId: null, heldId: 5, reason: 'invalid_route', unwrapFailed: false, creditedAmount: null }] });
  mocks.held.mockResolvedValueOnce({ heldId: 5, amount: '41440000000000000000000', reason: 'invalid_route',
    nearTxHash: '4NaHJ39MtdVKeEXbg2XdNgqSRLmALibhoyyoGCHcAoKH', state: 'source_unverified',
    sourceVerified: false, recipient: null, sourceTxHash: null, quote: null, releaseTxHash: null,
    refundTxHash: null, refundAmountUsdc: null });
  await render();
  expect(mocks.held).toHaveBeenCalledWith(5, id, null);
  expect(host.textContent).toContain('Payment held — no food added');
  expect(host.textContent).toContain('The delivery did not include a valid payment reference.');
  expect(host.textContent).not.toContain('View NEAR credit');
});

// spec: add-any-chain-feed › Cross-chain proof data › credit proof
// spec: add-any-chain-feed › Held delivery refund data › refund confirmed
it.each([
  ['ethereum', 'Ethereum', 'https://etherscan.io/tx/'],
  ['aptos', 'Aptos', 'https://explorer.aptoslabs.com/txn/'],
])('uses the recorded %s origin for source and return proofs', async (chain, label, prefix) => {
  const sourceTxHash = `0x${'b'.repeat(64)}`;
  const refundTxHash = `0x${'d'.repeat(64)}`;
  mocks.status.mockResolvedValueOnce({ ...quote, sourceChain: chain, sourceTxHash,
    state: 'held', deliveries: [{ receiptId: 'receipt', nearTxHash: 'N'.repeat(44), amount: '10000000000000000000000',
      kind: 'held', creditId: null, heldId: 5, reason: 'capacity', unwrapFailed: false, creditedAmount: null }] });
  mocks.held.mockResolvedValueOnce({ heldId: 5, amount: '10000000000000000000000', reason: 'capacity',
    nearTxHash: 'N'.repeat(44), state: 'refund_confirmed', sourceVerified: true,
    recipient: `0x${'c'.repeat(40)}`, sourceTxHash, quote: null, releaseTxHash: 'R'.repeat(44),
    refundTxHash, refundAmountUsdc: '10000' });
  await render();
  const suffix = chain === 'aptos' ? '?network=mainnet' : '';
  expect([...host.querySelectorAll('a')].find((item) => item.textContent?.includes(label))?.href)
    .toBe(`${prefix}${sourceTxHash}${suffix}`);
  expect([...host.querySelectorAll('a')].find((item) => item.textContent === 'View confirmed return')?.href)
    .toBe(`${prefix}${refundTxHash}${suffix}`);
});
