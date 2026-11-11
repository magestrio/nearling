import { expect, test } from '@playwright/test';
import { drawn, openWith, PIXEL } from './helpers';
import type { HeldStatus, QuoteStatus } from '../src/any-chain/types';

const paymentId = 'a'.repeat(32);
const held: HeldStatus = { heldId: 5, amount: '41440000000000000000000', reason: 'invalid_route',
  nearTxHash: 'BDMX1MyDJezDjDgk4gVgP6JhgznfWjwe9sNcMfMxkYnX', state: 'source_unverified',
  sourceVerified: false, recipient: null, sourceTxHash: null, quote: null,
  releaseTxHash: null, refundTxHash: null, refundAmountUsdc: null };
const status: QuoteStatus = { id: paymentId, tokenId: '9', state: 'held', providerState: 'SUCCESS',
  providerReference: 'provider-reference', sourceTxHash: null, sourceCondition: null,
  providerRefundAmount: null, providerRefundTxHash: null, refundTo: 'payer-address', deliveries: [{
    receiptId: 'receipt', nearTxHash: held.nearTxHash, amount: held.amount, kind: 'held', creditId: null,
    heldId: held.heldId, reason: held.reason, unwrapFailed: false, creditedAmount: null,
  }] };

// spec: add-any-chain-feed › Cross-chain settlement data › held delivery reconciled
// spec: add-any-chain-feed › Held delivery refund data › source unverified
test('provider SUCCESS and held custody still show no food or refund', async ({ page }) => {
  await openWith(page, `/pet/9/feed/status/${paymentId}`, { worker: { pets: { '9': PIXEL },
    anyChainStatus: status, anyChainHeldStatus: held } });
  await expect(drawn(page, 'Payment held — no food added')).toBeVisible();
  await expect(page.getByText('0.04144 wNEAR')).toBeVisible();
  await expect(page.getByRole('link', { name: 'View NEAR delivery' })).toHaveAttribute('href', /nearblocks\.io\/txns/);
  await expect(page.getByText('View NEAR credit')).toHaveCount(0);
  await expect(page.getByText('View confirmed return')).toHaveCount(0);
});

// spec: add-any-chain-feed › Held delivery refund data › reverse quote ready
test('return preparation shows the net, minimum, fees and verified recipient', async ({ page }) => {
  await openWith(page, `/pet/9/feed/status/${paymentId}`, { worker: { pets: { '9': PIXEL },
    anyChainStatus: status, anyChainHeldStatus: { ...held, state: 'reverse_quote_ready', sourceVerified: true,
      recipient: 'payer-address', quote: { amountOut: '137600', minAmountOut: '136200',
        refundFee: '1000', withdrawFee: '500' } } } });
  await expect(drawn(page, 'Return being prepared. Estimated 0.1376 USDC after fees; minimum 0.1362 USDC.')).toBeVisible();
  await expect(page.getByText('payer-address')).toBeVisible();
  await expect(page.getByText('Exchange fee')).toBeVisible();
});
