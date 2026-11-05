// Who is let in this month (Sign-in data, ADR-015, ADR-016). The count is read from the tables that
// hold the facts: `players.month` for the signed-in, `sign_in_refusals` for the refused after Google.
// A new month needs no reset: the month is in the key.

import policy from './showcasePolicy.json';

/** Signed-in players a month after which sign-in is closed to new players (OD-130). */
export const NEW_PLAYERS_LIMIT = policy.ordinaryAdmission;
/** Ordinary and judge entries share this admitted-player ceiling. */
export const JUDGE_PLAYERS_LIMIT = policy.judgeAdmission;
/** Signed-in plus refused after Google in a month after which sign-in is closed to everyone without
 * a session (OD-840, ADR-016: 9 below Privy's 500). */
export const CEILING = policy.countedSignIns;

export type SignInState = 'open' | 'closed_new' | 'closed_all';

/** The UTC month of a time, `YYYY-MM`, compared as text. */
export function monthOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 7);
}

/** 00:00 UTC of the 1st of the next month, ISO: when a closed sign-in opens again. */
export function nextMonthStart(ms: number): string {
  const d = new Date(ms);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString();
}

export interface Counts {
  signedIn: number;
  refused: number;
}

export async function countsOf(db: D1Database, month: string): Promise<Counts> {
  const row = await db
    .prepare('SELECT (SELECT COUNT(*) FROM players WHERE month = ?1) AS signed_in, (SELECT COUNT(*) FROM sign_in_refusals WHERE month = ?1) AS refused')
    .bind(month)
    .first<{ signed_in: number; refused: number }>();
  return { signedIn: row?.signed_in ?? 0, refused: row?.refused ?? 0 };
}

export function stateOf(counts: Counts): SignInState {
  if (counts.signedIn + counts.refused >= CEILING) return 'closed_all';
  if (counts.signedIn >= NEW_PLAYERS_LIMIT) return 'closed_new';
  return 'open';
}

// The two limits inside the statement that admits a player, so two sign-ins at 479 cannot both pass.
const UNDER_LIMITS =
  '(SELECT COUNT(*) FROM players WHERE month = ?3) < ?5 AND (SELECT COUNT(*) FROM players WHERE month = ?3) + (SELECT COUNT(*) FROM sign_in_refusals WHERE month = ?3) < ?6';

/** Admits a player who is not counted this month, if the month is still open to them. `false`: the
 * statement changed nothing. `hasRow`: the player has a row of an older month. */
export async function admit(db: D1Database, sub: string, accountId: string, month: string, now: number, hasRow: boolean): Promise<boolean> {
  const statement = hasRow
    ? `UPDATE players SET month = ?3, account_id = ?2 WHERE sub = ?1 AND month <> ?3 AND ${UNDER_LIMITS}`
    : `INSERT INTO players (sub, account_id, month, created_at) SELECT ?1, ?2, ?3, ?4 WHERE ${UNDER_LIMITS} ON CONFLICT (sub) DO NOTHING`;
  const result = await db.prepare(statement).bind(sub, accountId, month, now, NEW_PLAYERS_LIMIT, CEILING).run();
  return result.meta.changes > 0;
}
