import { utcDay } from '../http';
import { usd12ToMicros } from '../pricing';
import { callsUsd12, randomId, yoctoMicros, type Answer } from '../spend';

export interface Screening { id: string; attempt: number; day: number }
const CLAIM_MS = 300_000;

/** Tentatively hold a slot before inference; an interrupted preparation claim expires. */
export async function claimScreening(env: Pick<Env, 'DB'>, worker: string, now: number): Promise<Screening | null> {
  const day = utcDay(now);
  await env.DB.prepare('INSERT OR IGNORE INTO will_screenings (worker_token, day, started) VALUES (?, ?, 0)').bind(worker, day).run();
  const id = randomId();
  const row = await env.DB.prepare(`INSERT INTO will_screening_claims (id, worker_token, day, expires_at)
    SELECT ?, ?, ?, ? WHERE
    (SELECT started FROM will_screenings WHERE worker_token = ? AND day = ?) +
    (SELECT COUNT(*) FROM will_screening_claims WHERE worker_token = ? AND day = ? AND expires_at > ?) < 3
    RETURNING id`)
    .bind(id, worker, day, now + CLAIM_MS, worker, day, worker, day, now).first();
  return row === null ? null : { id, attempt: 0, day };
}

/** Count before the first model call, whether data preparation or the answer. */
export async function beginScreening(env: Pick<Env, 'DB'>, worker: string, screening: Screening): Promise<Screening> {
  const row = await env.DB.prepare(`UPDATE will_screenings SET started = started + 1
    WHERE worker_token = ? AND day = ? AND started < 3 AND EXISTS
    (SELECT 1 FROM will_screening_claims WHERE id = ? AND worker_token = ? AND day = ? AND expires_at > ?)
    RETURNING started`)
    .bind(worker, screening.day, screening.id, worker, screening.day, Date.now()).first<{ started: number }>();
  if (row === null) throw new Error('screening_reservation_missing');
  await env.DB.prepare('DELETE FROM will_screening_claims WHERE id = ?').bind(screening.id).run();
  return { ...screening, attempt: row.started };
}

/** Return a claim only when no model call began. */
export async function releaseUnstartedScreening(env: Pick<Env, 'DB'>, worker: string, screening: Screening): Promise<void> {
  await env.DB.prepare('DELETE FROM will_screening_claims WHERE id = ? AND worker_token = ? AND day = ?')
    .bind(screening.id, worker, screening.day).run();
}

export async function screeningCapacity(env: Pick<Env, 'DB'>, worker: string, now: number): Promise<boolean> {
  const day = utcDay(now);
  const row = await env.DB.prepare('SELECT started FROM will_screenings WHERE worker_token = ? AND day = ?')
    .bind(worker, day).first<{ started: number }>();
  const claims = await env.DB.prepare('SELECT COUNT(*) AS n FROM will_screening_claims WHERE worker_token = ? AND day = ? AND expires_at > ?')
    .bind(worker, day, now).first<{ n: number }>();
  return (row?.started ?? 0) + (claims?.n ?? 0) < 3;
}

/** A single idempotent ledger entry includes every call the screening actually used. Timeout uses its bounded ceiling.
 * The ledger feeds the $100 birth guard and $120 project ceiling. At 100 pets and three calls/day, the volatile
 * worst case at 0.005 NEAR and $4.59/NEAR is about $6.90/day; the live rate, not that estimate, prices a call. */
export async function screeningSpend(env: Env, screening: Screening, answers: Answer[], uncertainYocto = 0n, incurredMicros = 0): Promise<number> {
  const micros = usd12ToMicros(callsUsd12(env, answers)) + yoctoMicros(env, uncertainYocto) + incurredMicros;
  if (micros <= 0) return 0;
  await env.DB.prepare("INSERT OR IGNORE INTO project_spend (at, kind, usd_micros, screening_id) VALUES (?, 'will_screening', ?, ?)")
    .bind(Date.now(), micros, screening.id).run();
  return micros;
}
