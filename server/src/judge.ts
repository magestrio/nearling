import { CEILING, JUDGE_PLAYERS_LIMIT, countsOf, monthOf } from './signin';
import policy from './showcasePolicy.json';

export const JUDGE_EXPIRES_AT = Date.parse(policy.judgeExpiresAt);
export const JUDGE_DELETE_AT = Date.parse(policy.judgeDeleteAt);

/** Keep the SQL trigger's policy row in step with the one published configuration. */
export function judgePolicyStatement(db: D1Database): D1PreparedStatement {
  return db.prepare(`INSERT INTO judge_admission_policy
    (id, code_limit, uses_per_code, admitted_limit, counted_limit)
    VALUES (1, ?, ?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET code_limit = excluded.code_limit,
      uses_per_code = excluded.uses_per_code, admitted_limit = excluded.admitted_limit,
      counted_limit = excluded.counted_limit`).bind(
    policy.judgeCodes, policy.redemptionsPerCode, JUDGE_PLAYERS_LIMIT, CEILING,
  );
}

type JudgeResult = 'ok' | 'judge_invalid' | 'judge_exhausted' | 'judge_expired' | 'mau' | 'ceiling';

/** A code is 16 random bytes encoded as 32 hex digits. Its hash, never the code, is stored. */
export async function hashJudgeCode(code: string): Promise<string | null> {
  if (!/^[0-9a-f]{32}$/.test(code)) return null;
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code)));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Private issuance procedure: call only from an owner-controlled one-off tool, never an HTTP route.
 * Return the plaintext once to that caller; no Worker log, variable or D1 row contains it. */
export async function issueJudgeCodes(db: D1Database, now = Date.now()): Promise<string[]> {
  if (now >= JUDGE_EXPIRES_AT) throw new Error('judge_issuance_expired');
  const existing = await db.prepare('SELECT COUNT(*) AS n FROM judge_codes').first<{ n: number }>();
  if ((existing?.n ?? 0) !== 0) throw new Error('judge_codes_already_issued');
  const codes = Array.from({ length: policy.judgeCodes }, () => Array.from(crypto.getRandomValues(new Uint8Array(16)),
    (byte) => byte.toString(16).padStart(2, '0')).join(''));
  const hashes = await Promise.all(codes.map(hashJudgeCode));
  await db.batch([judgePolicyStatement(db), ...hashes.map((hash) => db.prepare('INSERT INTO judge_codes (hash, issued_at, expires_at) VALUES (?, ?, ?)')
    .bind(hash, now, JUDGE_EXPIRES_AT))]);
  return codes;
}

export async function checkJudgeCode(db: D1Database, code: string, now = Date.now()): Promise<JudgeResult> {
  const counts = await countsOf(db, monthOf(now));
  if (counts.signedIn + counts.refused >= CEILING) return 'ceiling';
  if (counts.signedIn >= JUDGE_PLAYERS_LIMIT) return 'mau';
  const hash = await hashJudgeCode(code);
  if (hash === null) return 'judge_invalid';
  const row = await db.prepare('SELECT expires_at, (SELECT COUNT(*) FROM judge_redemptions WHERE code_hash = ?1) AS uses FROM judge_codes WHERE hash = ?1')
    .bind(hash).first<{ expires_at: number; uses: number }>();
  if (row === null) return 'judge_invalid';
  if (row.expires_at <= now) return 'judge_expired';
  if (row.uses >= policy.redemptionsPerCode) return 'judge_exhausted';
  return 'ok';
}

/** A failed statement aborts the batch, rolling back the redemption and the player write. */
export async function redeemJudgeCode(db: D1Database, code: string, sub: string, accountId: string,
  month: string, now: number, hasRow: boolean): Promise<JudgeResult> {
  const hash = await hashJudgeCode(code);
  if (hash === null) return 'judge_invalid';
  try {
    await db.batch([
      judgePolicyStatement(db),
      db.prepare('INSERT INTO judge_redemptions (code_hash, sub, month, redeemed_at) VALUES (?, ?, ?, ?)')
        .bind(hash, sub, month, now),
      hasRow
        ? db.prepare('UPDATE players SET month = ?3, account_id = ?2 WHERE sub = ?1 AND month <> ?3')
          .bind(sub, accountId, month)
        : db.prepare('INSERT INTO players (sub, account_id, month, created_at) VALUES (?, ?, ?, ?)')
          .bind(sub, accountId, month, now),
    ]);
    return 'ok';
  } catch (error) {
    const message = String(error);
    if (message.includes('judge_expired')) return 'judge_expired';
    if (message.includes('judge_exhausted')) return 'judge_exhausted';
    if (message.includes('judge_invalid')) return 'judge_invalid';
    if (message.includes('judge_admission_full')) return 'mau';
    if (message.includes('judge_ceiling')) return 'ceiling';
    // A duplicate Google return must not consume another place; the caller checks the player row.
    if (message.includes('UNIQUE constraint failed')) return 'judge_exhausted';
    throw error;
  }
}

/** Called by the existing minute cron from the retention date onward. */
export async function cleanJudgeCodes(db: D1Database, now: number): Promise<void> {
  if (now < JUDGE_DELETE_AT) return;
  await db.batch([
    db.prepare('DELETE FROM judge_redemptions'),
    db.prepare('DELETE FROM judge_codes'),
  ]);
}
