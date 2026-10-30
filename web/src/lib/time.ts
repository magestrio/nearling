// `{time}` of the copy: 00:00 UTC, when the day's limits reset, as the player's clock shows it (add-pet › Hatch screen
// «рождения на сегодня закрыты», Daily cap rule › «Устал»): HH:MM, 24 hours — «02:00» at UTC+2.

/** HH:MM, 24 h, of `at` in `timeZone` (the browser's own when omitted). */
export function formatClock(at: Date, timeZone?: string): string {
  return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone }).format(at);
}

/** The next 00:00 UTC after `now`. */
export function nextUtcMidnight(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}

/** The `{time}` for the day's reset: from the server's `until` (an ISO time) when it gives one, else the next 00:00 UTC. */
export function resetTime(until?: string | null, now: Date = new Date(), timeZone?: string): string {
  const at = until ? new Date(until) : nextUtcMidnight(now);
  return formatClock(Number.isNaN(at.getTime()) ? nextUtcMidnight(now) : at, timeZone);
}
