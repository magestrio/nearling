// The errand in flight (`Errand in flight`, §8): one row a pet. It is away, done or failed; a failed one keeps its
// form, job and reason until the next errand, «Try again», a clear of the memory or a gift (`Errand flow` › «failed
// errand after a reload»). The words of the job live in `errands.job` only while the errand is away or failed.
import { track } from '../track';
import { costUsd12 } from '../pricing';
import { randomId } from '../spend';
import type { ErrandForm } from './price';

export type FailReason = 'unreadable' | 'too_long' | 'search_down' | 'empty' | 'timeout' | 'blocked';

export interface ErrandRow {
  token_id: string;
  id: string;
  owner: string;
  form: ErrandForm;
  job: string | null;
  state: 'away' | 'done' | 'failed';
  reason: FailReason | null;
  cause: 'unreachable' | 'no_search' | null;
  sent_at: number;
  reserve_yocto: string;
  searches_ran: number;
  thought_id: string | null;
  price_yocto: string | null;
}

/** What `GET …/state` carries as `errand` (the owner's only). */
export type ErrandView =
  | { state: 'away'; form: ErrandForm; job: string | null; sentAt: number }
  | { state: 'done'; cleared: true; priceCents: number }
  | { state: 'failed'; form: ErrandForm; job: string | null; reason: FailReason; cause?: 'unreachable' | 'no_search'; priceCents?: number };

/** The pet's errand row for `ownerId`, the account that owns it now. A failed errand of an earlier owner is erased
 * here, at the first read after a gift: the server learns of a transfer only from the contract
 * (`Errand access data` › «given away after a failed errand»). */
export async function readErrand(db: D1Database, tokenId: string, ownerId: string): Promise<ErrandRow | null> {
  const row = await db.prepare('SELECT * FROM errands WHERE token_id = ?').bind(tokenId).first<ErrandRow>();
  if (row === null) return null;
  if (row.state === 'failed' && row.owner !== ownerId) {
    // A receipt the old owner paid for stays, without its words; the job, the form and the reason go.
    await db.batch([
      db.prepare("DELETE FROM errands WHERE token_id = ? AND id = ? AND state = 'failed'").bind(tokenId, row.id),
      db
        .prepare('UPDATE thoughts SET erased_at = CASE WHEN player_text IS NOT NULL OR reply_text IS NOT NULL THEN ?2 ELSE erased_at END, player_text = NULL, reply_text = NULL WHERE id = ?1')
        .bind(row.thought_id ?? '', Date.now()),
      db.prepare("UPDATE thought_calls SET req_bytes = x'', res_bytes = x'' WHERE thought_id = ?").bind(row.thought_id ?? ''),
    ]);
    return null;
  }
  return row;
}

export async function errandView(db: D1Database, row: ErrandRow | null, consumeCleared = true): Promise<ErrandView | null> {
  if (row === null) return null;
  if (row.state === 'done') {
    if (row.thought_id === null) return null;
    const thought = await db.prepare('SELECT erased_at, price_usd_micros FROM thoughts WHERE id = ?').bind(row.thought_id).first<{ erased_at: number | null; price_usd_micros: number }>();
    if (thought?.erased_at === null || thought === null) return null;
    // A clear while away erases the report's words but keeps its receipt. Let the next state read carry the end.
    if (consumeCleared) {
      const consumed = await db.prepare("DELETE FROM errands WHERE token_id = ? AND id = ? AND state = 'done' RETURNING id").bind(row.token_id, row.id).first();
      if (consumed === null) return null;
    }
    return { state: 'done', cleared: true, priceCents: Number((thought.price_usd_micros / 10_000).toPrecision(2)) };
  }
  if (row.state === 'away') return { state: 'away', form: row.form, job: row.job, sentAt: row.sent_at };
  let priceCents: number | undefined;
  if (row.thought_id !== null) {
    const paid = await db.prepare('SELECT price_usd_micros FROM thoughts WHERE id = ?').bind(row.thought_id).first<{ price_usd_micros: number }>();
    if (paid !== null) priceCents = Number((paid.price_usd_micros / 10_000).toPrecision(2));
  }
  return {
    state: 'failed',
    form: row.form,
    job: row.job,
    reason: row.reason ?? 'empty',
    ...(row.cause === null ? {} : { cause: row.cause }),
    ...(priceCents === undefined ? {} : { priceCents }),
  };
}

/** The new errand and its desk job in one batch; null when an errand of the pet is away (a second tab, a stale
 * page). The failed or done row of the pet is replaced by the new one. */
export async function sendErrand(db: D1Database, a: { tokenId: string; owner: string; form: ErrandForm; job: string; now: number }): Promise<{ errand: string; job: string } | null> {
  const errand = randomId();
  const job = crypto.randomUUID().replaceAll('-', '');
  const written = await db.batch([
    db
      .prepare(
        `INSERT INTO errands (token_id, id, owner, form, job, state, reason, cause, sent_at, reserve_yocto, searches_ran, thought_id, price_yocto)
         SELECT ?1, ?2, ?3, ?4, ?5, 'away', NULL, NULL, ?6, '0', 0, NULL, NULL WHERE NOT EXISTS (SELECT 1 FROM errands WHERE token_id = ?1 AND state = 'away')
         ON CONFLICT (token_id) DO UPDATE SET id = excluded.id, owner = excluded.owner, form = excluded.form, job = excluded.job, state = 'away', reason = NULL, cause = NULL,
           sent_at = excluded.sent_at, reserve_yocto = '0', searches_ran = 0, thought_id = NULL, price_yocto = NULL
         RETURNING id`,
      )
      .bind(a.tokenId, errand, a.owner, a.form, a.job, a.now),
    db
      .prepare("INSERT INTO jobs (id, token_id, kind, mode, payload, status, created_at) SELECT ?1, ?2, 'errand', NULL, '{}', 'queued', ?3 WHERE EXISTS (SELECT 1 FROM errands WHERE token_id = ?2 AND id = ?4)")
      .bind(job, a.tokenId, a.now, errand),
  ]);
  return (written[0]?.results.length ?? 0) === 0 ? null : { errand, job };
}

/** The errand of the pet that is away now, if any. */
export async function awayErrand(db: D1Database, tokenId: string): Promise<ErrandRow | null> {
  return db.prepare("SELECT * FROM errands WHERE token_id = ? AND state = 'away'").bind(tokenId).first<ErrandRow>();
}

export interface Paid {
  /** What the pet paid: the price in USD at the rate it was made, and the project's cost for what the pet paid. */
  priceUsd: number;
  costUsd: number;
}

export const nothingPaid: Paid = { priceUsd: 0, costUsd: 0 };

export interface FailedWith {
  reason: FailReason;
  cause?: 'unreachable' | 'no_search';
  searches?: number;
  priceYocto?: bigint;
  thoughtId?: string;
  paid?: Paid;
  cut?: boolean;
  projectUsd?: number;
}

/** Ends the errand with no report: the row turns `failed` with its form and job, the reserve is released, and the
 * event goes out — only when this call is the one that ended it (a timeout may have ended it first). */
export async function failErrand(db: D1Database, row: ErrandRow, a: FailedWith): Promise<boolean> {
  const ended = await db.batch([
    db
      .prepare("UPDATE errands SET state = 'failed', reason = ?3, cause = ?4, reserve_yocto = '0', searches_ran = COALESCE(?5, searches_ran), thought_id = COALESCE(?6, thought_id), price_yocto = COALESCE(?7, price_yocto) WHERE token_id = ?1 AND id = ?2 AND state = 'away' RETURNING id")
      .bind(row.token_id, row.id, a.reason, a.cause ?? null, a.searches ?? null, a.thoughtId ?? null, a.priceYocto === undefined ? null : a.priceYocto.toString()),
    db.prepare('DELETE FROM pet_spend WHERE token_id = ?').bind(row.token_id),
  ]);
  if ((ended[0]?.results.length ?? 0) === 0) return false;
  announceFailed(row, a);
  return true;
}

/** The event and the log line of an errand that ended without a report (codes and counters only). */
export function announceFailed(row: Pick<ErrandRow, 'form'>, a: FailedWith): void {
  const paid = a.paid ?? nothingPaid;
  track('errand_failed', {
    form: row.form,
    reason: a.reason,
    ...(a.cause === undefined ? {} : { cause: a.cause }),
    searches: a.searches ?? 0,
    price_usd: paid.priceUsd,
    cost_usd: paid.costUsd,
    cut: a.cut ?? false,
    project_usd: a.projectUsd ?? 0,
  });
  console.log(`errand_failed:${a.reason}`);
}

/** The project's cost of tokens in USD, as the events carry it (no markup, no gas share). */
export function tokensCostUsd(env: Parameters<typeof costUsd12>[0], calls: { tokensIn: number; tokensOut: number }[]): number {
  return Number(calls.reduce((sum, c) => sum + costUsd12(env, c.tokensIn, c.tokensOut), 0n)) / 1e12;
}
