import { expect, it } from 'vitest';
import type { DebateRead } from '../seams/worker-types';
import { exactNear, lineCents, lineReceipt, orderedLines, transcriptStatus } from './transcript';

const base: DebateRead = { id: 'a'.repeat(64), status: 'running', topic: 'Rain?',
  firstPet: { tokenId: '9', name: 'Pixel' }, secondPet: { tokenId: '5', name: 'Nori' }, openerPet: '9', lines: [] };
const line = (order: number, status: 'settled' | 'receipt_pending' | 'unavailable') => ({ order,
  speakerPet: order % 2 ? '9' : '5', status, text: `line ${order}`, requestBytes: null, responseBytes: null,
  signedCall: null, receiptTxHash: status === 'settled' ? 'hash' : null, priceYocto: '180000000000000000000', nearUsdRate: '4.59' });

// spec: add-debates › Debate transcript screen › empty
// spec: add-debates › Debate turn flow › started
it('orders delivered lines and keeps an empty published debate distinct from a completed one', () => {
  expect(transcriptStatus(base)).toBe('No lines yet. The pets are getting ready.');
  const read = { ...base, lines: [line(2, 'settled'), line(1, 'settled')] };
  expect(orderedLines(read).map((row) => row.order)).toEqual([1, 2]);
  expect(transcriptStatus(read)).toBe('Debate started');
  expect(transcriptStatus({ ...read, status: 'completed' })).toBe('Debate complete');
});

// spec: add-debates › Debate turn flow › receipt pending
// spec: add-debates › Debate turn flow › debit rejected
it('only makes a settled receipt checkable', () => {
  expect(lineReceipt(line(1, 'receipt_pending'))).toBe('pending');
  expect(lineReceipt(line(1, 'unavailable'))).toBe('unavailable');
  expect(lineReceipt(line(1, 'settled'))).toBe('settled');
  expect(lineReceipt({ ...line(1, 'settled'), receiptTxHash: null })).toBe('pending');
  expect(transcriptStatus({ ...base, status: 'unavailable', endReason: 'debit_rejected' }))
    .toBe("Debate stopped: a line couldn't be paid. Nothing was charged for it.");
  expect(lineCents(line(1, 'settled'))).toBe('0.08¢');
  expect(lineCents(line(1, 'receipt_pending'))).toBeNull();
});

// spec: add-debates › Debate turn flow › owner stops
// spec: add-debates › Debate turn flow › gift mid debate
// spec: add-debates › Debate transcript screen › asleep
it('renders the end reason without dropping paid lines', () => {
  const read = { ...base, lines: [line(1, 'settled'), line(2, 'settled')] };
  expect(transcriptStatus({ ...read, status: 'stopped' })).toBe('Stopped by an owner');
  expect(transcriptStatus({ ...read, status: 'gift' })).toBe('Debate ended after a gift');
  expect(transcriptStatus({ ...read, status: 'unavailable', endReason: 'asleep' })).toBe('Pixel fell asleep. This debate has ended.');
  expect(exactNear('180000000000000000000')).toBe('0.00018 NEAR');
});
