import type { DebateLineRead, DebateRead } from '../seams/worker-types';
import { debateCopy as copy } from './copy';
import { formatCents } from '../lib/price';
import { centsAtRate } from '../verification/checkMachine';

export function orderedLines(read: DebateRead): DebateLineRead[] {
  return [...(read.lines ?? [])].filter((line) => line.order >= 1 && line.order <= 4 && line.text !== null)
    .sort((a, b) => a.order - b.order);
}

export function lineReceipt(line: DebateLineRead): 'settled' | 'pending' | 'unavailable' {
  return line.status === 'settled' && line.receiptTxHash ? 'settled'
    : line.status === 'unavailable' ? 'unavailable' : 'pending';
}

export function transcriptStatus(read: DebateRead): string {
  if (read.status === 'completed') return copy.transcriptComplete;
  if (read.status === 'stopped') return 'Stopped by an owner';
  if (read.status === 'gift') return 'Debate ended after a gift';
  if (read.status === 'cleared') return copy.transcriptCleared;
  if (read.status === 'refused') {
    const last = orderedLines(read).at(-1);
    const name = last?.speakerPet === read.firstPet?.tokenId ? read.firstPet?.name : read.secondPet?.name;
    return `${name ?? ''} chose not to continue.`;
  }
  if (read.status === 'unavailable') {
    const next = orderedLines(read).length + 1;
    const opener = read.openerPet === read.firstPet?.tokenId ? read.firstPet : read.secondPet;
    const other = opener === read.firstPet ? read.secondPet : read.firstPet;
    const name = (next % 2 ? opener : other)?.name ?? '';
    if (read.endReason === 'debit_rejected') return copy.debitRejectedEnd;
    if (read.endReason === 'asleep') return `${name} fell asleep. This debate has ended.`;
    if (read.endReason === 'cannot_pay') return `${name} cannot pay for another line today.`;
    if (read.endReason === 'services_paused') return 'Debate paused. No more food was spent.';
    if (read.endReason === 'society_refusal') return `${name} does not want to meet today.`;
    if (read.endReason === 'daily_slot_used') return `${name} has debated today. Try again tomorrow.`;
    return 'This debate could not continue. No more food was spent.';
  }
  if (orderedLines(read).length === 0) return copy.transcriptEmpty;
  return copy.transcriptStarted;
}

export function lineCents(line: DebateLineRead): string | null {
  if (line.status !== 'settled' || line.priceYocto === null) return null;
  const hundredths = centsAtRate(line.priceYocto, line.nearUsdRate);
  if (hundredths === null) return null;
  return hundredths >= 1 && hundredths <= 9 ? `0.0${hundredths}¢` : formatCents(hundredths / 100);
}

export function exactNear(yocto: string | null): string | null {
  if (!yocto || !/^(0|[1-9][0-9]*)$/.test(yocto)) return null;
  const value = BigInt(yocto);
  const fraction = (value % 10n ** 24n).toString().padStart(24, '0').replace(/0+$/, '');
  return `${value / 10n ** 24n}${fraction ? `.${fraction}` : ''} NEAR`;
}
