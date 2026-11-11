import { describe, expect, it } from 'vitest';
import { WorkerError } from '../seams/worker-types';
import { addressExpired, decimalUnits, formatUnits, quoteIssue, supportedToken } from './quoteMachine';

describe('any-chain quote rules', () => {
  // spec: add-any-chain-feed › Cross-chain quote flow › quote below minimum
  // spec: add-any-chain-feed › Cross-chain quote flow › quote above portion ceiling
  // spec: add-any-chain-feed › Cross-chain availability rule › changed quote
  it('maps live refusals to distinct nonpayable states', () => {
    expect(quoteIssue(new WorkerError(409, 'below_minimum'))).toBe('below');
    expect(quoteIssue(new WorkerError(409, 'above_ceiling'))).toBe('above');
    expect(quoteIssue(new WorkerError(409, 'quote_expired'))).toBe('changed');
    expect(quoteIssue(new WorkerError(409, 'capacity_full'))).toBe('capacity');
    expect(quoteIssue(new WorkerError(409, 'pending_stake_unavailable'))).toBe('stake');
    expect(quoteIssue(new WorkerError(409, 'receiver_unregistered'))).toBe('receiver');
  });

  // spec: add-any-chain-feed › Cross-chain quote flow › unsupported origin
  it('selects each payable asset from the live list on its chosen chain', () => {
    const token = { assetId: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near',
      blockchain: 'base', symbol: 'USDC', decimals: 6, price: 1, contractAddress: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' };
    expect(supportedToken([token], 'base')).toEqual(token);
    expect(supportedToken([token], 'solana')).toBeNull();
    const other = { ...token, assetId: 'nep141:base-eth.omft.near', symbol: 'ETH', decimals: 18, price: 3200 };
    expect(supportedToken([token, other], 'base', other.assetId)).toEqual(other);
    expect(supportedToken([token], 'base', other.assetId)).toBeNull();
  });

  // spec: add-any-chain-feed › Cross-chain quote data › quote request leaves browser
  it('keeps the source amount exact and formats NEAR without floating point', () => {
    expect(decimalUnits('0.25', 6)).toBe('250000');
    expect(decimalUnits('0.0000001', 6)).toBeNull();
    expect(decimalUnits('0', 6)).toBeNull();
    expect(formatUnits('48510000000000000000000', 24)).toBe('0.04851');
  });

  // spec: add-any-chain-feed › Cross-chain availability rule › changed quote
  it('stops copying a destination at its inactive time or deadline', () => {
    const answer = { id: 'a', signature: 's', providerReference: 'p', quote: {
      amountIn: '1', amountInUsd: '1', amountOut: '1', amountOutUsd: '1', minAmountOut: '1', refundFee: '0',
      withdrawFee: '0', timeEstimate: 1, timeWhenInactive: '2026-11-11T20:40:00Z', deadline: '2026-11-11T20:45:00Z',
    } };
    expect(addressExpired(answer, Date.parse('2026-11-11T20:39:59Z'))).toBe(false);
    expect(addressExpired(answer, Date.parse('2026-11-11T20:40:00Z'))).toBe(true);
  });
});
