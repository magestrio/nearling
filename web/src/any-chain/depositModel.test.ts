import { expect, it } from 'vitest';
import { depositView, ownerDepositLine, sweepRemaining } from './depositModel';
import type { OwnerDepositRead } from './types';

const base: OwnerDepositRead = { deposit: { id: 'a'.repeat(32), token_id: '9', chain: 'base',
  source_tx_hash: `0x${'b'.repeat(64)}`, asset: 'usdc', amount_units: '340000', state: 'waiting',
  address: `0x${'c'.repeat(40)}`, source_explorer: 'https://basescan.org/tx/source',
  near_credit_tx: null, source_refund_tx: null }, convertedUnits: '0', sweep: null };

// spec: add-any-chain-feed › Pet address deposit flow › supported deposit seen
// spec: add-any-chain-feed › Pet address deposit flow › unsupported deposit
// spec: add-any-chain-feed › Pet address deposit flow › below conversion minimum
it('uses actual deposit state without calling an observed transfer food', () => {
  expect(depositView(base)).toBe('observed');
  expect(ownerDepositLine('observed', 'Pixel', 'base')).toBe('USDC arrived for Pixel. Waiting for conversion.');
  expect(depositView({ ...base, deposit: { ...base.deposit, state: 'below_minimum' } })).toBe('below_minimum');
  expect(depositView({ ...base, deposit: { ...base.deposit, asset: 'other' } })).toBe('unsupported');
});

// spec: add-any-chain-feed › Pet address deposit flow › deposit exceeds one sweep
// spec: add-any-chain-feed › Pet address deposit flow › remainder after sweep
it('separates a bounded portion, remaining balance and the next sweep window', () => {
  const read: OwnerDepositRead = { ...base, sweep: { routeId: 'd'.repeat(32), amountUnits: '200000',
    destination: 'destination', refundTo: base.deposit.address,
    quote: { quote: { amountIn: '200000', amountInUsd: '0.2', amountOut: '40000000000000000000000',
      amountOutUsd: '0.19', minAmountOut: '39600000000000000000000', refundFee: '0', withdrawFee: '0', timeEstimate: 19 } },
    approvalHash: 'e'.repeat(64), expiryMs: 5000, state: 'quoted', nearTxHash: null,
    sourceTxHash: null, windowEndsAt: 3_605_000 } };
  expect(depositView(read, 1000)).toBe('oversized');
  expect(depositView({ ...read, convertedUnits: '200000', sweep: { ...read.sweep!, state: 'food' } }, 1000)).toBe('remainder');
  expect(sweepRemaining({ ...read, convertedUnits: '200000', sweep: { ...read.sweep!, state: 'food' } })).toBe('0.14');
});

// spec: add-any-chain-feed › Pet address deposit flow › NEAR signing outcome unknown
// spec: add-any-chain-feed › Pet address deposit flow › sweep awaiting gas
// spec: add-any-chain-feed › Pet address deposit flow › sweep sent
// spec: add-any-chain-feed › Pet address deposit flow › sweep failed
it.each([['sign_unknown', 'sign_unknown'], ['awaiting_gas', 'awaiting_gas'], ['sent', 'sent'],
  ['failed', 'failed'], ['refunded', 'refunded']])('maps %s to %s without a food claim', (state, expected) => {
  const read = { ...base, sweep: { routeId: 'd', amountUnits: '200000', destination: 'destination',
    refundTo: base.deposit.address, quote: { quote: {} as never }, approvalHash: 'e', expiryMs: 5000,
    state, nearTxHash: null, sourceTxHash: null, windowEndsAt: 3_605_000 } };
  expect(depositView(read, 1000)).toBe(expected);
});
