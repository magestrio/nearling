import { describe, expect, it, vi } from 'vitest';
import { dailyResetDelay } from './dailyReset';

describe('daily Hatch reset', () => {
  // spec: add-hatch-again › Petless Home screen › closed birth × 00:00 UTC
  it('uses Worker time for the first read even when the browser is two hours ahead or behind', () => {
    try {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-11-11T02:00:00.000Z'));
      expect(dailyResetDelay('2026-11-11T00:00:00.000Z', '2026-11-10T23:59:55.000Z')).toBe(5000);
      vi.setSystemTime(new Date('2026-11-10T21:00:00.000Z'));
      expect(dailyResetDelay('2026-11-11T00:00:00.000Z', '2026-11-10T23:59:55.000Z')).toBe(5000);
    } finally {
      vi.useRealTimers();
    }
  });
});
