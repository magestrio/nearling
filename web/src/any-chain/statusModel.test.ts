import { expect, it } from 'vitest';
import { creditedDelivery, nearProof, paymentLine, reasonLine } from './statusModel';
import type { HeldStatus, QuoteStatus } from './types';

const status = (state: string): QuoteStatus => ({ id: 'a'.repeat(32), tokenId: '9', state,
  providerState: 'SUCCESS', providerReference: 'provider-reference', sourceTxHash: 'source-hash',
  sourceCondition: 'observed', providerRefundAmount: null, providerRefundTxHash: null,
  refundTo: 'payer-address', deliveries: [] });

// spec: add-any-chain-feed › Cross-chain settlement data › recovery after unknown outcome
// spec: add-any-chain-feed › Cross-chain quote flow › source transfer pending
it('does not infer food from provider SUCCESS or a pending NEAR delivery', () => {
  const candidate = status('delivery_unverified');
  expect(paymentLine({ kind: 'quote', value: candidate }, 'Pixel')).toBe('Still on its way');
  expect(nearProof(candidate)).toBeNull();
  candidate.deliveries.push({ receiptId: 'receipt', nearTxHash: 'near-hash', amount: '49000000000000000000000',
    kind: 'pending', creditId: 1, heldId: null, reason: null, unwrapFailed: false, creditedAmount: null });
  expect(paymentLine({ kind: 'quote', value: candidate }, 'Pixel')).toBe('Still on its way');
  expect(creditedDelivery(candidate)).toBeNull();
});

// spec: add-any-chain-feed › Cross-chain payment status screen › success
// spec: add-any-chain-feed › Cross-chain proof data › credit proof
// spec: add-any-chain-feed › Cross-chain quote flow › excess input refunded
it('shows actual NEAR credit and a separate verified excess refund', () => {
  const candidate = status('food');
  candidate.deliveries.push({ receiptId: 'receipt', nearTxHash: 'near-hash', amount: '49000000000000000000000',
    kind: 'pending', creditId: 1, heldId: null, reason: null, unwrapFailed: false,
    creditedAmount: '48700000000000000000000' });
  expect(nearProof(candidate)).toEqual({ amount: '0.0487 NEAR', hash: 'near-hash' });
  expect(paymentLine({ kind: 'quote', value: candidate }, 'Pixel')).toBe('Pixel received food from another chain.');
  candidate.state = 'food_excess_refunded';
  candidate.providerRefundTxHash = 'refund-hash';
  expect(paymentLine({ kind: 'quote', value: candidate }, 'Pixel')).toBe('You fed Pixel!');
});

// spec: add-any-chain-feed › Cross-chain quote flow › provider refund
// spec: add-any-chain-feed › Cross-chain quote flow › provider failure
// spec: add-any-chain-feed › Cross-chain quote flow › unknown outcome
it('requires verified source refund evidence before claiming refund', () => {
  expect(paymentLine({ kind: 'quote', value: status('provider_refund_unverified') }, 'Pixel'))
    .toBe('Outcome not known yet. Keep this page and check again.');
  const refunded = status('provider_refunded');
  refunded.providerRefundTxHash = 'proof';
  expect(paymentLine({ kind: 'quote', value: refunded }, 'Pixel'))
    .toBe('Refund reported to payer-address. Check your wallet; fees may apply.');
  expect(paymentLine({ kind: 'quote', value: status('provider_failed') }, 'Pixel'))
    .toBe('Swap failed. Keep this reference for recovery.');
});

// spec: add-any-chain-feed › Cross-chain quote flow › transfer too small
// spec: add-any-chain-feed › Cross-chain quote flow › transfer after deadline
// spec: add-any-chain-feed › Cross-chain quote flow › wrong asset sent
it.each([
  ['transfer_too_small', 'Too little arrived. It may be refunded after the deadline, less the quoted fee.'],
  ['transfer_late', 'This address expired. Funds may be delayed or lost. Keep the transfer link.'],
  ['wrong_asset', 'Wrong asset sent. It may not be recoverable. Keep the transfer link.'],
])('%s keeps the transfer as evidence without promising food', (state, line) => {
  const candidate = status(state);
  expect(paymentLine({ kind: 'quote', value: candidate }, 'Pixel')).toBe(line);
  expect(nearProof(candidate)).toBeNull();
});

// spec: add-any-chain-feed › Cross-chain settlement data › held delivery reconciled
// spec: add-any-chain-feed › Held delivery refund data › reverse quote ready
// spec: add-any-chain-feed › Held delivery refund data › refund confirmed
it('keeps held food absent and separates payer and owner return copy', () => {
  const candidate = status('held');
  const held: HeldStatus = { heldId: 4, amount: '41440000000000000000000', reason: 'invalid_route',
    nearTxHash: 'held-hash', state: 'reverse_quote_ready', sourceVerified: true,
    recipient: 'payer-address', sourceTxHash: 'source-hash', quote: { amountOut: '137600', minAmountOut: '136200',
      refundFee: '1000', withdrawFee: '500' }, releaseTxHash: null, refundTxHash: null, refundAmountUsdc: null };
  expect(nearProof(candidate)).toBeNull();
  expect(paymentLine({ kind: 'quote', value: candidate, held }, 'Pixel'))
    .toBe('Return being prepared. Estimated 0.1376 USDC after fees; minimum 0.1362 USDC.');
  held.state = 'refund_confirmed'; held.refundAmountUsdc = '137600';
  expect(paymentLine({ kind: 'quote', value: candidate, held }, 'Pixel'))
    .toBe('Return confirmed: 0.1376 USDC reached your Solana address. No food was added.');
  delete held.recipient;
  expect(paymentLine({ kind: 'quote', value: candidate, held }, 'Pixel'))
    .toBe('Return confirmed: 0.1376 USDC was sent back to the payer. No food was added.');
});

// spec: add-any-chain-feed › Held delivery refund data › reverse quote ready
// spec: add-any-chain-feed › Held delivery refund data › refund confirmed
it('words a return in the asset the payer sent, not in USDC', () => {
  const candidate = status('held');
  const held: HeldStatus = { heldId: 4, amount: '41440000000000000000000', reason: 'invalid_route',
    nearTxHash: 'held-hash', state: 'refund_confirmed', sourceVerified: true,
    recipient: 'payer-address', sourceTxHash: 'source-hash', quote: null, releaseTxHash: null, refundTxHash: null,
    refundAmountUsdc: null, refundAmount: '12500000', refundAsset: 'SOL', refundDecimals: 9 };
  expect(paymentLine({ kind: 'quote', value: candidate, held }, 'Pixel'))
    .toBe('Return confirmed: 0.0125 SOL reached your Solana address. No food was added.');
});

// spec: add-any-chain-feed › wNEAR receipt contract › wrong token caller
// spec: add-any-chain-feed › wNEAR recovery contract › retry failed route
// spec: add-any-chain-feed › wNEAR recovery contract › route not recoverable
// spec: add-any-chain-feed › Pet sweep authorization contract › wrong refund recipient
// spec: add-any-chain-feed › Pet sweep authorization contract › wrong caller
// spec: add-any-chain-feed › Pet sweep authorization contract › unknown pet
// spec: add-any-chain-feed › Pet sweep authorization contract › wrong or stale owner approval
// spec: add-any-chain-feed › Pet sweep authorization contract › expired or reused approval
// spec: add-any-chain-feed › Pet sweep authorization contract › wrong derivation path
// spec: add-any-chain-feed › Pet sweep authorization contract › unsupported token or chain
// spec: add-any-chain-feed › Pet sweep authorization contract › excessive sweep
// spec: add-any-chain-feed › Pet sweep authorization contract › duplicate sweep
// spec: add-any-chain-feed › Pet sweep authorization contract › missing quote destination
it('words a coded contract rejection exactly, and an ordinary route not at all', () => {
  const words = (reason: string) => paymentLine({ kind: 'quote', value: { ...status('unknown_outcome'), reason } }, 'Pixel');
  expect(words('token_rejected')).toBe('Token delivery was rejected. Keep the transfer reference.');
  expect(words('retry_failed_route')).toBe('Checking NEAR delivery again.');
  expect(words('route_not_recoverable')).toBe('This payment cannot be retried yet. Check its current status.');
  expect(words('wrong_refund_recipient')).toBe("Refund address did not match Pixel's address. Conversion stopped.");
  expect(words('wrong_caller')).toBe('Conversion could not be submitted. Try again.');
  expect(words('unknown_pet')).toBe('Pet not found for this conversion.');
  expect(words('wrong_owner_approval')).toBe("Only Pixel's current owner can approve conversion.");
  expect(words('expired_approval')).toBe('Approval expired. Check the quote and approve again.');
  expect(words('wrong_derivation_path')).toBe('Pet address did not match. Conversion stopped.');
  expect(words('unsupported_token_or_chain')).toBe('This asset cannot be converted here.');
  expect(words('excessive_sweep')).toBe('Conversion amount is too large. Check again.');
  expect(words('duplicate_sweep')).toBe('Conversion amount or route changed. Check again.');
  expect(words('missing_quote_destination')).toBe('No conversion destination. Get a new quote.');
  expect(reasonLine(null, 'Pixel')).toBeNull();
  expect(words('something_else')).toBe('Outcome not known yet. Keep this page and check again.');
});
