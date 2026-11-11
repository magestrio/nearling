import { expect, test } from '@playwright/test';
import { drawn, openWith, PIXEL, ASLEEP_PIXEL, setWorker } from './helpers';
import type { QuoteStatus } from '../src/any-chain/types';

const paymentId = 'a'.repeat(32);
const path = `/pet/9/feed/status/${paymentId}`;
const base: QuoteStatus = { id: paymentId, tokenId: '9', state: 'source_transfer_pending', providerState: 'PROCESSING',
  providerReference: 'provider-reference', sourceTxHash: `0x${'b'.repeat(64)}`, sourceCondition: 'observed',
  sourceAmount: '250000', sourceAsset: 'USDC', sourceChain: 'base',
  providerStatusUrl: 'https://1click.chaindefuser.com/v0/status?depositAddress=shown',
  providerRefundAmount: null, providerRefundTxHash: null, refundTo: `0x${'c'.repeat(40)}`, deliveries: [] };
const pet = { pets: { '9': PIXEL }, anyChainStatus: base };

// spec: add-any-chain-feed › Cross-chain payment status screen › signed-out
// spec: add-any-chain-feed › Cross-chain quote flow › source transfer pending
test('a signed-out payer can follow the opaque status without Google', async ({ page }) => {
  await openWith(page, path, { worker: pet });
  await expect(drawn(page, 'Still on its way')).toBeVisible();
  await expect(page.getByRole('link', { name: 'View transfer on Base' })).toHaveAttribute('href', /basescan\.org/);
  await expect(page.getByText('Amount sent')).toBeVisible();
  await expect(page.getByText('0.25 USDC')).toBeVisible();
  await expect(page.getByRole('link', { name: 'View exchange status' })).toHaveAttribute('href', /1click\.chaindefuser\.com\/v0\/status/);
  await expect(page.getByRole('button', { name: 'Feed Pixel' })).toBeVisible();
  await expect(page.getByText('View NEAR credit')).toHaveCount(0);
});

// spec: add-any-chain-feed › Cross-chain payment status screen › asleep
// spec: add-any-chain-feed › Cross-chain settlement data › recovery after unknown outcome
test('provider success leaves an asleep pet asleep until the NEAR credit', async ({ page }) => {
  await openWith(page, path, { worker: { pets: { '9': ASLEEP_PIXEL }, anyChainStatus: {
    ...base, state: 'delivery_unverified', providerState: 'SUCCESS',
  } } });
  await expect(page.getByText('Pixel is asleep. Food will wake them after the NEAR credit confirms.')).toBeVisible();
  await expect(page.getByText('View NEAR credit')).toHaveCount(0);
});

// spec: add-any-chain-feed › Cross-chain payment status screen › success
// spec: add-any-chain-feed › Cross-chain proof data › credit proof
test('only a confirmed callback yields food and its NEAR proof', async ({ page }) => {
  await openWith(page, path, { worker: { ...pet, anyChainStatus: { ...base, state: 'food',
    deliveries: [{ receiptId: 'receipt', nearTxHash: '4NaHJ39MtdVKeEXbg2XdNgqSRLmALibhoyyoGCHcAoKH',
      amount: '49000000000000000000000', kind: 'pending', creditId: 1, heldId: null, reason: null,
      unwrapFailed: false, creditedAmount: '48700000000000000000000' }],
  } } });
  await expect(drawn(page, 'Pixel received food from another chain.')).toBeVisible();
  await expect(page.getByText('0.0487 NEAR')).toBeVisible();
  await expect(page.getByRole('link', { name: 'View NEAR credit' })).toHaveAttribute('href', /nearblocks\.io\/txns/);
});

// spec: add-any-chain-feed › Cross-chain payment status screen › empty
// spec: add-any-chain-feed › Cross-chain payment status screen › error
test('a missing payment is distinct from an unreadable one and retries the same id', async ({ page }) => {
  await openWith(page, path, { worker: { ...pet, anyChainStatus: { fail: { status: 503, code: 'chain_unreachable' } } } });
  await expect(drawn(page, 'Payment status is unavailable. Your transfer may still be on its way.')).toBeVisible();
  await setWorker(page, { anyChainStatus: { fail: { status: 404, code: 'payment_missing' } },
    anyChainDepositStatus: { fail: { status: 404, code: 'deposit_missing' } } });
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(drawn(page, 'No payment found here.')).toBeVisible();
});
