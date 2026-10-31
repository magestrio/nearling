// The close of a UTC day (design.md › Решения › The day's record). When a day ends, the days that
// went by without an available or finished ritual are marked `excused`: they go into `skipped` of the
// next streak mark, so they neither grow nor break the streak (`Streak rule` › «питомец спал», «день не
// записан», `Ritual day rule`). One batch per day, set-based; `ritual_clock.closed_day` keeps the last
// day closed, so an outage of the cron closes each day it missed.
import { utcDay } from '../http';

/** At most this many days are closed in a tick (an outage longer than that catches up over a few). */
const DAYS_PER_TICK = 31;

/** Closes every day from the one after `closed_day` to yesterday. The first run only starts the clock
 * at yesterday: there is no ritual before the change. */
export async function closeDays(env: Env, nowMs: number): Promise<void> {
  const yesterday = utcDay(nowMs) - 1;
  const clock = await env.DB.prepare('SELECT closed_day FROM ritual_clock WHERE id = 1').first<{ closed_day: number }>();
  if (clock === null) {
    await env.DB.prepare('INSERT OR IGNORE INTO ritual_clock (id, closed_day) VALUES (1, ?)').bind(yesterday).run();
    return;
  }
  let closed = 0;
  for (let day = clock.closed_day + 1; day <= yesterday && closed < DAYS_PER_TICK; day += 1) {
    await env.DB.batch(closeStatements(env.DB, day));
    closed += 1;
  }
}

function closeStatements(db: D1Database, day: number): D1PreparedStatement[] {
  const start = day * 86_400_000;
  const end = start + 86_400_000;
  // A row is made for the pet if it has none, and excused unless the ritual ended: a completed day
  // with `excused = 1` is exactly «day not recorded», and that is the mark writer's to set.
  const excuse = (where: string) =>
    `INSERT INTO ritual_days (token_id, day, excused) SELECT token_id, ?1, 1 FROM pets WHERE born_at < ?3 AND ${where} ON CONFLICT (token_id, day) DO UPDATE SET excused = 1 WHERE completed_at IS NULL`;
  return [
    // The pet slept through the end of the day.
    db.prepare(excuse('slept_at IS NOT NULL AND slept_at < ?3')).bind(day, start, end),
    // Nothing was available: the riddle of the day never opened, and the pet has no entry of that day.
    db
      .prepare(
        excuse(
          "NOT EXISTS (SELECT 1 FROM riddles WHERE day = ?1 AND sealed_at IS NOT NULL) AND NOT EXISTS (SELECT 1 FROM thoughts t WHERE t.token_id = pets.token_id AND t.kind = 'diary' AND t.created_at >= ?2 AND t.created_at < ?3 AND (t.reply_text IS NOT NULL OR t.erased_at IS NOT NULL))",
        ),
      )
      .bind(day, start, end),
    // A mark that did not land by the end of the next day is lost (ADR-010 › Which day).
    db.prepare('UPDATE ritual_days SET excused = 1 WHERE completed_at IS NOT NULL AND marked_at IS NULL AND excused = 0 AND day < ?').bind(day),
    db.prepare('INSERT INTO ritual_clock (id, closed_day) VALUES (1, ?1) ON CONFLICT (id) DO UPDATE SET closed_day = excluded.closed_day WHERE closed_day < excluded.closed_day').bind(day),
  ];
}
