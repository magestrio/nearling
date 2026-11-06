import { formatCents } from '../lib/price';
import { resetTime } from '../lib/time';
import type { WatchRead } from '../seams/worker-types';
import { centsAtRate } from '../verification/checkMachine';

/** The saved UTC hour is a daily wall-clock slot; show that hour in this player's local time. */
export function localCheckTime(hour: number, now = new Date()): string {
  const at = new Date(now);
  at.setUTCHours(hour, 0, 0, 0);
  return new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);
}

export function nextCheckDate(iso: string, timeZone?: string): string {
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', ...(timeZone ? { timeZone } : {}) }).format(new Date(iso));
}

export function latestPrice(read: WatchRead): string | null {
  if (!read.latestPriceYocto) return null;
  const hundredths = centsAtRate(read.latestPriceYocto, read.latestNearUsdRate ?? null);
  if (hundredths === null) return nearPrice(read.latestPriceYocto);
  return hundredths >= 1 && hundredths <= 9 ? `0.0${hundredths}¢` : formatCents(hundredths / 100);
}

export function nearPrice(yocto: string): string {
  const amount = BigInt(yocto);
  const fraction = (amount % 10n ** 24n).toString().padStart(24, '0').replace(/0+$/, '');
  return `${amount / 10n ** 24n}${fraction ? `.${fraction}` : ''} NEAR`;
}

export function resultLine(name: string, read: WatchRead): string | null {
  if (!read.target || !read.latestResult) return null;
  const price = latestPrice(read);
  if (read.latestResult === 'first' && price) return `First check saved as a starting point · ${price}`;
  if (read.latestResult === 'unchanged' && price) return `No change to ${read.target} · ${price}`;
  if (read.latestResult === 'changed') return `${name} checked ${read.target}${read.latestChange ? `: ${read.latestChange}` : ''}${price ? ` · ${price}` : ''}`;
  if (read.latestResult === 'failed' || read.latestResult === 'unreadable' || read.latestResult === 'no_search') return `${name} couldn't read ${read.target} today.${price ? ` Its search used ${price} of food.` : ''}`;
  return null;
}

type Pause = NonNullable<WatchRead['pause']>;

/** The line for a day the scheduled check was skipped, and whether a meal would make a later check possible. */
export function pauseLine(name: string, pause: Pause, now = new Date()): { text: string; feed: boolean } {
  switch (pause) {
    case 'sleeping': return { text: `${name} is asleep, so today's watch is paused. Feed ${name} to make a later daily check possible.`, feed: true };
    case 'food': return { text: `Today's watch is paused until ${name} has enough food.`, feed: true };
    case 'energy': return { text: `${name} is resting until ${resetTime(null, now)}. Today's watch is skipped.`, feed: false };
    case 'cap': return { text: `Today's watch is paused at ${name}'s spending limit. Another check can run after 00:00 UTC.`, feed: false };
    case 'services': return { text: "Today's watch is paused while thoughts are unavailable.", feed: false };
  }
}

const FAILED_CHECKS = new Set(['failed', 'unreadable', 'no_search']);

/** What the owner is told after saving a target: a different one starts a new comparison, and a check that already started
 *  today (and failed) is not replayed for it. The first target and the same one again say nothing. */
export function replacedLine(previous: WatchRead | null, saved: string, nowMs = Date.now()): string | null {
  if (!previous?.target || previous.target === saved) return null;
  const usedAndFailed = previous.lastStartedDay === Math.floor(nowMs / 86_400_000) && FAILED_CHECKS.has(previous.latestResult ?? '');
  return usedAndFailed
    ? `Now watching ${saved}. Today's check was used; the new target starts after 00:00 UTC.`
    : `Now watching ${saved}. The next eligible check starts a new comparison.`;
}

export const stoppedLine = (name: string): string => `Watch stopped. Past diary entries and receipts stay with ${name}.`;
