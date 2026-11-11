import type { DepositStatus, HeldStatus, QuoteStatus } from './types';
import { formatUnits } from './quoteMachine';

export type PaymentRead = { kind: 'quote'; value: QuoteStatus; held?: HeldStatus | null }
  | { kind: 'deposit'; value: DepositStatus };

const quoteLines: Record<string, string> = {
  source_pending: 'Still on its way', source_transfer_pending: 'Still on its way',
  unwrap_pending: 'Still on its way', delivery_unverified: 'Still on its way',
  transfer_too_small: 'Too little arrived. It may be refunded after the deadline, less the quoted fee.',
  transfer_late: 'This address expired. Funds may be delayed or lost. Keep the transfer link.',
  wrong_asset: 'Wrong asset sent. It may not be recoverable. Keep the transfer link.',
  provider_failed: 'Swap failed. Keep this reference for recovery.',
  unknown_outcome: 'Outcome not known yet. Keep this page and check again.',
  provider_refund_unverified: 'Outcome not known yet. Keep this page and check again.',
  unwrap_failed: 'NEAR delivery stalled. Keep this payment page.',
};

/** The words of a coded contract rejection or recovery outcome (the `receipt`, `recovery` and `sweep` contract Scenarios). */
export function reasonLine(reason: string | null | undefined, name: string): string | null {
  return ({
    token_rejected: 'Token delivery was rejected. Keep the transfer reference.',
    retry_failed_route: 'Checking NEAR delivery again.',
    route_not_recoverable: 'This payment cannot be retried yet. Check its current status.',
    wrong_refund_recipient: `Refund address did not match ${name}'s address. Conversion stopped.`,
    wrong_caller: 'Conversion could not be submitted. Try again.',
    unknown_pet: 'Pet not found for this conversion.',
    wrong_owner_approval: `Only ${name}'s current owner can approve conversion.`,
    expired_approval: 'Approval expired. Check the quote and approve again.',
    wrong_derivation_path: 'Pet address did not match. Conversion stopped.',
    unsupported_token_or_chain: 'This asset cannot be converted here.',
    excessive_sweep: 'Conversion amount is too large. Check again.',
    duplicate_sweep: 'Conversion amount or route changed. Check again.',
    missing_quote_destination: 'No conversion destination. Get a new quote.',
  } as Record<string, string>)[reason ?? ''] ?? null;
}

export function creditedDelivery(status: QuoteStatus): QuoteStatus['deliveries'][number] | null {
  return status.deliveries.find((item) => item.kind === 'pending' && item.creditedAmount !== null &&
    item.creditId !== null) ?? null;
}

/** The asset a held delivery is returned in and what was returned: the payer's own asset, USDC when the Worker names none. */
export function heldReturn(held: HeldStatus): { symbol: string; decimals: number; amount: string | null } {
  return { symbol: held.refundAsset ?? 'USDC', decimals: held.refundDecimals ?? 6, amount: held.refundAmount ?? held.refundAmountUsdc };
}

export function paymentLine(read: PaymentRead, name: string): string {
  if (read.kind === 'deposit') return { waiting_for_owner: 'Waiting for owner', converting: 'Converting',
    became_food: 'Became food', refunded: 'Refunded' }[read.value.state];
  const status = read.value;
  if (read.held) {
    const back = heldReturn(read.held);
    if (read.held.state === 'reverse_quote_ready' && read.held.quote)
      return `Return being prepared. Estimated ${formatUnits(read.held.quote.amountOut, back.decimals, back.decimals)} ${back.symbol} after fees; minimum ${formatUnits(read.held.quote.minAmountOut, back.decimals, back.decimals)} ${back.symbol}.`;
    return {
      below_return_minimum: 'This amount is below the return minimum. It remains held and cannot be returned through 1-Click now.',
      reverse_exchange_failed: "The return didn't go through. Your money is still held for return. We'll try again.",
      settlement_transfer_failed: "The return couldn't start. Your money is still held. We'll try again.",
      release_in_progress: 'Return in progress', return_in_progress: 'Return in progress',
      refund_confirmed: read.held.recipient
        ? `Return confirmed: ${formatUnits(back.amount ?? '0', back.decimals, back.decimals)} ${back.symbol} reached your ${read.held.sourceTxHash?.startsWith('0x') ? 'Base' : 'Solana'} address. No food was added.`
        : `Return confirmed: ${formatUnits(back.amount ?? '0', back.decimals, back.decimals)} ${back.symbol} was sent back to the payer. No food was added.`,
    }[read.held.state] ?? 'Payment held — no food added';
  }
  const rejected = reasonLine(status.reason, name);
  if (rejected) return rejected;
  const credit = creditedDelivery(status);
  if (credit) return status.state === 'food_excess_refunded' ? `You fed ${name}!` : `${name} received food from another chain.`;
  if (status.state === 'provider_refunded' && status.providerRefundTxHash)
    return `Refund reported to ${status.refundTo}. Check your wallet; fees may apply.`;
  if (status.state === 'held') return 'Payment held — no food added';
  return quoteLines[status.state] ?? 'Outcome not known yet. Keep this page and check again.';
}

export function nearProof(status: QuoteStatus): { amount: string; hash: string } | null {
  const credited = creditedDelivery(status);
  return credited ? { amount: `${formatUnits(credited.creditedAmount!, 24)} NEAR`, hash: credited.nearTxHash } : null;
}
