import type { OwnerDepositRead, SweepRead } from './types';
import { formatUnits } from './quoteMachine';

export type DepositView = 'observed' | 'unsupported' | 'below_minimum' | 'quoted' | 'oversized' |
  'remainder' | 'rejected' | 'sign_failed' | 'sign_unknown' | 'submitted' | 'awaiting_gas' |
  'sent' | 'failed' | 'refunded' | 'food';

export function depositView(read: OwnerDepositRead, now = Date.now()): DepositView {
  const { deposit, sweep } = read;
  if (deposit.state === 'refunded' || sweep?.state === 'refunded') return 'refunded';
  if (deposit.state === 'food' && BigInt(read.convertedUnits) >= BigInt(deposit.amount_units)) return 'food';
  if (sweep?.state === 'food' && BigInt(read.convertedUnits) < BigInt(deposit.amount_units)) return 'remainder';
  if (deposit.state === 'unsupported' || deposit.asset !== 'usdc') return 'unsupported';
  if (sweep) {
    if (sweep.state === 'quoted' && sweep.expiryMs > now)
      return BigInt(deposit.amount_units) - BigInt(read.convertedUnits) > BigInt(sweep.amountUnits) ? 'oversized' : 'quoted';
    if (sweep.state === 'sign_unknown') return 'sign_unknown';
    if (sweep.state === 'sign_failed') return 'sign_failed';
    if (sweep.state === 'approval_rejected') return 'rejected';
    if (sweep.state === 'awaiting_gas') return 'awaiting_gas';
    if (sweep.state === 'failed') return 'failed';
    if (sweep.state === 'sent' || sweep.state === 'broadcasting') return 'sent';
    if (sweep.state === 'signing' || sweep.state === 'signed') return 'submitted';
  }
  return deposit.state === 'below_minimum' ? 'below_minimum' : 'observed';
}

export function ownerDepositLine(view: DepositView, name: string, chain: 'base' | 'solana'): string {
  const network = chain === 'base' ? 'Base' : 'Solana';
  return {
    observed: `USDC arrived for ${name}. Waiting for conversion.`,
    unsupported: 'This deposit cannot become food automatically. Keep the transaction link for recovery.',
    below_minimum: `Too small to convert now. It stays at ${name}'s address.`,
    quoted: 'Waiting for owner', oversized: 'Waiting for owner',
    remainder: 'Became food', food: 'Became food',
    rejected: `Conversion not approved. USDC stays at ${name}'s address.`,
    sign_failed: `Conversion could not be prepared. USDC remains at ${name}'s address.`,
    sign_unknown: 'Checking conversion approval. Please wait before trying again.',
    submitted: 'Approval received. Preparing conversion.',
    awaiting_gas: `Conversion is waiting for network gas. USDC is still at ${name}'s address.`,
    sent: 'USDC sent for conversion. Still on its way.',
    failed: `Conversion failed. USDC may still be at ${name}'s address. Check the chain before trying again.`,
    refunded: `Refunded to ${name}'s ${network} address. Check the deposit before trying again.`,
  }[view];
}

export function sweepRemaining(read: OwnerDepositRead): string {
  const amount = BigInt(read.deposit.amount_units);
  const used = BigInt(read.convertedUnits) +
    (read.sweep?.state === 'quoted' ? BigInt(read.sweep.amountUnits) : 0n);
  return formatUnits(amount > used ? (amount - used).toString() : '0', 6, 6);
}

export function sweepPortion(sweep: SweepRead): string { return formatUnits(sweep.amountUnits, 6, 6); }
