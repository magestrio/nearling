import type { WorkRecord } from '../seams/worker-types';

export interface ChainWorkCount {
  token_id: string;
  paid_hires: number;
  completed_errands: number;
  counted_since: number;
}

/** A D1 pointer is shown only alongside the same checked chain count. */
export function checkedRecord(record: WorkRecord, chain: ChainWorkCount | null, tokenId: string): WorkRecord | null {
  if (!chain || chain.token_id !== tokenId || record.tokenId !== tokenId) return null;
  if (!Number.isSafeInteger(chain.paid_hires) || !Number.isSafeInteger(chain.completed_errands)
    || !Number.isInteger(chain.counted_since) || chain.counted_since < 0
    || chain.paid_hires < 0 || chain.completed_errands < 0) return null;
  return record.counts.paidHires === chain.paid_hires
    && record.counts.completedErrands === chain.completed_errands
    && record.counts.countedSince === chain.counted_since ? record : null;
}

export function countedDate(ns: number): string {
  return new Date(Math.floor(ns / 1_000_000)).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  });
}
