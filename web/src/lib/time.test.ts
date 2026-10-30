import { describe, expect, it } from 'vitest';
import { formatClock, nextUtcMidnight, resetTime } from './time';

describe('{time}', () => {
  // spec: add-pet › Hatch screen › рождения на сегодня закрыты
  it('shows 00:00 UTC on the player\'s clock as HH:MM, 24 hours', () => {
    const midnight = new Date('2026-10-30T00:00:00Z');
    expect(formatClock(midnight, 'Etc/GMT-2')).toBe('02:00');
    expect(formatClock(midnight, 'UTC')).toBe('00:00');
    expect(formatClock(midnight, 'America/New_York')).toBe('20:00');
    expect(formatClock(midnight, 'Asia/Kolkata')).toBe('05:30');
  });

  it('finds the next 00:00 UTC, at midnight itself too', () => {
    expect(nextUtcMidnight(new Date('2026-10-30T13:45:00Z')).toISOString()).toBe('2026-10-31T00:00:00.000Z');
    expect(nextUtcMidnight(new Date('2026-10-30T00:00:00Z')).toISOString()).toBe('2026-10-31T00:00:00.000Z');
    expect(nextUtcMidnight(new Date('2026-12-31T23:59:59Z')).toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });

  it('takes the server\'s `until`, or the next midnight when there is none or it is not a time', () => {
    const now = new Date('2026-10-30T13:45:00Z');
    expect(resetTime('2026-10-31T00:00:00.000Z', now, 'Etc/GMT-2')).toBe('02:00');
    expect(resetTime(undefined, now, 'Etc/GMT-2')).toBe('02:00');
    expect(resetTime('garbage', now, 'Etc/GMT-2')).toBe('02:00');
  });
});
