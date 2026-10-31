import type { StreakCell } from '../ds';

const CELLS = 7;

/** The seven cells of the Streak strip when the forecast puts frozen days beside today (`Streak rule` › «заморозка спасла серию»):
 *  oldest first, today last, the covered days dashed before it, the days of the streak lit before those, the rest not drawn. With
 *  no day missed the DS's own rule draws the strip, so there is none to give. `done` — today's ritual is done, so today is counted.
 *  Only the forecast has such cells: once the mark lands the day is just a day of the streak, and D1 keeps no such day. */
export function streakCells(days: number, missed: number, done = false): StreakCell[] | undefined {
  if (missed <= 0) return undefined;
  const frozen = Math.min(missed, CELLS - 1);
  const lit = Math.max(0, Math.min(days, CELLS - 1 - frozen));
  const cells: StreakCell[] = [];
  for (let i = 0; i < CELLS; i += 1) {
    if (i === CELLS - 1) cells.push(done ? 'lit' : 'today');
    else if (i >= CELLS - 1 - frozen) cells.push('frozen');
    else if (i >= CELLS - 1 - frozen - lit) cells.push('lit');
    else cells.push('none');
  }
  return cells;
}
