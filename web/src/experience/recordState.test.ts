import { describe, expect, it } from 'vitest';
import { checkedRecord, countedDate } from './recordState';
import type { WorkRecord } from '../seams/worker-types';

const sample: WorkRecord = { tokenId: '9', counts: { paidHires: 3, completedErrands: 5, countedSince: 1794010000000000000 }, field: null, receipts: [] };
const chain = { token_id: '9', paid_hires: 3, completed_errands: 5, counted_since: 1794010000000000000 };

describe('public work record', () => {
  // spec: add-pet-experience › Work record screen › success
  it('accepts matching chain counts and the public Worker pointers', () => {
    expect(checkedRecord(sample, chain, '9')).toBe(sample);
    expect(countedDate(Date.UTC(2026, 10, 7) * 1_000_000)).toBe('Nov 7, 2026');
  });
  // spec: add-pet-experience › Work record screen › error
  it('does not assert a stale, missing, foreign or malformed count', () => {
    expect(checkedRecord(sample, { ...chain, paid_hires: 4 }, '9')).toBeNull();
    expect(checkedRecord(sample, null, '9')).toBeNull();
    expect(checkedRecord(sample, { ...chain, token_id: '2' }, '9')).toBeNull();
    expect(checkedRecord(sample, { ...chain, completed_errands: -1 }, '9')).toBeNull();
  });
});
