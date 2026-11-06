import { describe, expect, it } from 'vitest';
import { latestPrice, localCheckTime, nearPrice, nextCheckDate, pauseLine, replacedLine, resultLine, stoppedLine } from './view';
import type { WatchRead } from '../seams/worker-types';

const read: WatchRead = { target: 'NEAR price', savedHourUtc: 2, paused: false,
  nextCheck: '2026-11-12T02:00:00.000Z', latestResult: 'unchanged',
  latestPriceYocto: '1700000000000000000000', latestReceiptId: 'watch-1',
  latestNearUsdRate: '5',
  upTo: { cents: 1.1, yocto: '2200000000000000000000' } };

describe('watch result copy', () => {
  // spec: add-pet-errands › Daily watch flow › unchanged check
  it('shows a quiet paid check with its receipt price and UTC next date', () => {
    expect(latestPrice(read)).toBe('0.85¢');
    expect(resultLine('Pixel', read)).toBe('No change to NEAR price · 0.85¢');
    expect(nextCheckDate(read.nextCheck!, 'UTC')).toBe('Nov 12, 2026');
    expect(localCheckTime(2, new Date('2026-11-12T02:00:00.000Z'))).toMatch(/^\d\d:\d\d$/);
  });

  // spec: add-pet-errands › Daily watch flow › first check
  it('calls the first paid check a starting point', () => {
    expect(resultLine('Pixel', { ...read, latestResult: 'first' })).toBe('First check saved as a starting point · 0.85¢');
  });

  // spec: add-pet-errands › Watch observation data › named source unreadable
  it('names the search charge only if the failed check has one', () => {
    expect(resultLine('Pixel', { ...read, latestResult: 'failed' })).toBe("Pixel couldn't read NEAR price today. Its search used 0.85¢ of food.");
    expect(resultLine('Pixel', { ...read, latestResult: 'unreadable' })).toBe("Pixel couldn't read NEAR price today. Its search used 0.85¢ of food.");
    expect(resultLine('Pixel', { ...read, latestResult: 'no_search', latestPriceYocto: null })).toBe("Pixel couldn't read NEAR price today.");
  });

  it('keeps the exact NEAR amount if the receipt rate cannot be read', () => {
    expect(nearPrice('1700000000000000000000')).toBe('0.0017 NEAR');
    expect(latestPrice({ ...read, latestNearUsdRate: null })).toBe('0.0017 NEAR');
  });
});

const TODAY = Date.UTC(2026, 10, 11, 12);
const DAY = Math.floor(TODAY / 86_400_000);

describe('watch pause and replacement copy', () => {
  // spec: add-pet-errands › Daily watch flow › sleeping pause
  it('offers Feed only where a meal makes a later check possible', () => {
    expect(pauseLine('Pixel', 'sleeping')).toEqual({ text: "Pixel is asleep, so today's watch is paused. Feed Pixel to make a later daily check possible.", feed: true });
    expect(pauseLine('Pixel', 'food')).toEqual({ text: "Today's watch is paused until Pixel has enough food.", feed: true });
    for (const pause of ['energy', 'cap', 'services'] as const) expect(pauseLine('Pixel', pause).feed).toBe(false);
  });

  // spec: add-pet-errands › Daily watch flow › target replaced
  // spec: add-pet-errands › Daily watch flow › target replaced after failed check
  it('says a new comparison starts, and that a failed started day was used', () => {
    expect(replacedLine(null, 'A', TODAY)).toBeNull();
    expect(replacedLine({ ...read, target: 'A' }, 'A', TODAY)).toBeNull();
    expect(replacedLine({ ...read, target: 'A', lastStartedDay: DAY, latestResult: 'unchanged' }, 'B', TODAY)).toBe('Now watching B. The next eligible check starts a new comparison.');
    expect(replacedLine({ ...read, target: 'A', lastStartedDay: DAY - 1, latestResult: 'failed' }, 'B', TODAY)).toBe('Now watching B. The next eligible check starts a new comparison.');
    expect(replacedLine({ ...read, target: 'A', lastStartedDay: DAY, latestResult: 'failed' }, 'B', TODAY)).toBe("Now watching B. Today's check was used; the new target starts after 00:00 UTC.");
  });

  // spec: add-pet-errands › Daily watch flow › watch stopped
  it('names who keeps the past', () => {
    expect(stoppedLine('Pixel')).toBe('Watch stopped. Past diary entries and receipts stay with Pixel.');
  });
});
