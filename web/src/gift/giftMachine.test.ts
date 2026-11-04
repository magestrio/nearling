import { expect, it } from 'vitest';
import { GiftGate, PendingGiftSend, giftPhase, noFlightAfterFailedSend } from './giftMachine';
import { missingNear } from './GiftSheet';
import { WorkerError } from '../seams/worker-types';

// spec: add-gift › Gift flow › передаёт
it('admits only one transfer until its definite outcome', async () => {
  const gate = new GiftGate();
  let sends = 0;
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  const tap = async () => { if (!gate.take()) return; sends += 1; await pending; gate.release(); };
  const first = tap();
  const second = tap();
  expect(sends).toBe(1);
  expect(gate.locked).toBe(true);
  finish(); await Promise.all([first, second]);
  expect(gate.take()).toBe(true);
});

// spec: add-gift › Gift flow › исход неизвестен
it('keeps an unknown transfer pending and rounds a gas shortfall upward', () => {
  expect(giftPhase('unknown')).toBe('pending');
  expect(giftPhase('ok')).toBe('given');
  expect(missingNear('1')).toBe('0.01');
  expect(missingNear('10000000000000000000001')).toBe('0.02');
});

// spec: add-gift › Gift flow › исход неизвестен
it('recognizes a no-flight poll only while the signed payload remains available', () => {
  const noFlight = new WorkerError(409, 'gift_unavailable');
  expect(noFlightAfterFailedSend(noFlight, true)).toBe(true);
  expect(noFlightAfterFailedSend(noFlight, false)).toBe(false);
  expect(noFlightAfterFailedSend(new WorkerError(409, 'pending'), true)).toBe(false);
  expect(noFlightAfterFailedSend(new WorkerError(503, 'chain_unreachable'), true)).toBe(false);
  expect(noFlightAfterFailedSend(new WorkerError(0, 'unreachable'), true)).toBe(false);
});

// spec: add-gift › Gift flow › исход неизвестен
it('resends the original signed payload after no-flight 409 and keeps it across another uncertain response', async () => {
  const pending = new PendingGiftSend();
  const gate = new GiftGate();
  const signed = { tx: 'original-transaction', signature: 'original-signature' };
  const sent: Array<{ tx: string; signature: string }> = [];
  const noFlight = new WorkerError(409, 'gift_unavailable');
  const send = async (payload: { tx: string; signature: string }) => {
    sent.push(payload);
    if (sent.length === 1) throw new WorkerError(0, 'unreachable');
    return { status: 'unknown' as const };
  };

  expect(gate.take()).toBe(true);
  pending.retain(signed);
  await expect(pending.resendOnNoFlight(noFlight, send)).rejects.toMatchObject({ code: 'unreachable' });
  expect(gate.locked).toBe(true);
  expect(await pending.resendOnNoFlight(noFlight, send)).toEqual({ status: 'unknown' });
  expect(sent).toEqual([signed, signed]);
  expect(sent[0]).toBe(sent[1]);
  expect(await pending.resendOnNoFlight(new WorkerError(409, 'pending'), send)).toBeNull();
  pending.clear();
  expect(await pending.resendOnNoFlight(noFlight, send)).toBeNull();
  expect(sent).toHaveLength(2);
});

// spec: add-gift › Gift flow › исход неизвестен
it('preserves the signed payload when the resend is definitely refused, until the link is read', async () => {
  const pending = new PendingGiftSend();
  const signed = { tx: 'original-transaction', signature: 'original-signature' };
  const refusal = new WorkerError(409, 'gift_unavailable');
  pending.retain(signed);
  await expect(pending.resendOnNoFlight(refusal, async () => { throw refusal; })).rejects.toBe(refusal);
  const sent: Array<{ tx: string; signature: string }> = [];
  await pending.resendOnNoFlight(refusal, async (payload) => {
    sent.push(payload);
    return { status: 'unknown' };
  });
  expect(sent).toEqual([signed]);
  expect(sent[0]).toBe(signed);
});
