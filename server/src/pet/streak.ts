// The streak rule in TypeScript: the same arithmetic as `next_streak` in `contract/src/pet.rs`, so the
// Worker can show the coming number before the mark reaches the chain (ADR-010 › «The forecast») and
// find out what a mark that was sent and not heard of did. `contract/tests/fixtures/streak-cases.json`
// is read by a Rust unit test and by `test/ritual-rules.test.ts`, which keeps the two equal.

/** Freezes saturate here, as the contract's `u8` does. */
const MAX_FREEZES = 255;

export interface StreakBefore {
  streak: number;
  freezes: number;
  /** The UTC day of the last mark; 0 before the first. */
  last: number;
}

export interface StreakAfter {
  streak: number;
  freezes: number;
  /** The freezes the mark spent; on a restart, all the pet had. */
  spent: number;
}

/** What `streak_mark(day, skipped)` writes. The first mark is streak 1 and reads no `skipped`; after it
 * the days missed are those between the last day and `day` less `skipped`: freezes cover them, or the
 * streak restarts at 1 with no freezes. Every 7th day adds a freeze, a restart never lands on one. */
export function applyMark(before: StreakBefore, day: number, skipped: number): StreakAfter {
  let { streak, freezes } = before;
  let spent = 0;
  if (before.last === 0) {
    streak = 1;
  } else {
    const missed = Math.max(0, day - before.last - 1 - skipped);
    if (missed <= freezes) {
      freezes -= missed;
      streak += 1;
      spent = missed;
    } else {
      spent = freezes;
      streak = 1;
      freezes = 0;
    }
  }
  if (streak % 7 === 0) freezes = Math.min(MAX_FREEZES, freezes + 1);
  return { streak, freezes, spent };
}

export interface ForecastInput {
  /** The streak and the freezes on chain, and the last marked day (`null`: no mark yet). */
  streak: number;
  freezes: number;
  last: number | null;
  today: number;
  /** The days in the gap that D1 knows are not missed: excused ones, and completed ones whose mark is pending. */
  covered: ReadonlySet<number>;
  /** The last UTC day whose end the cron has closed (`ritual_clock`). */
  closedDay: number;
  /** The pet was gifted and has had no mark since: the number and its note stay, the line does not. */
  gifted: boolean;
}

/** The number the next mark will write, shown before it lands: «not yet on chain». `line` is the words
 * about the miss («frozen»: a freeze kept the streak; «fresh»: it starts over) and is `null` for a gifted
 * pet. `n` and `k` are what those words say: the streak on chain, and the freezes left (0 on a restart). */
export interface Forecast {
  days: number;
  freezes: number;
  line: 'frozen' | 'fresh' | null;
  n: number;
  k: number;
  missed: number;
}

/** The forecast of today, or `null` when there is nothing to forecast: no mark yet (days from birth to
 * the first mark are not misses), nothing missed, or yesterday not closed yet (in the first minute of a
 * day an excused night would read as a missed one and a freeze would flash and vanish). */
export function forecastOf(input: ForecastInput): Forecast | null {
  if (input.last === null || input.last === 0) return null;
  if (input.closedDay < input.today - 1) return null;
  let missed = 0;
  for (let day = input.last + 1; day < input.today; day += 1) if (!input.covered.has(day)) missed += 1;
  if (missed === 0) return null;
  if (missed <= input.freezes) {
    return { days: input.streak, freezes: input.freezes - missed, line: input.gifted ? null : 'frozen', n: input.streak, k: input.freezes - missed, missed };
  }
  return { days: 0, freezes: 0, line: input.gifted ? null : 'fresh', n: input.streak, k: 0, missed };
}
