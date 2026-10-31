// The pause of the services (Service pause data): one row of `service_pause` while the project has
// no money for a service. The cron starts and lifts it; the balance is also read before a birth, a
// thought and a debit (`gasIsLow`), so a pause does not wait for the next minute.
import { accountBalance, PET_MINT_TGAS } from './chain';

const NEAR_PER_TGAS_YOCTO = 1_000_000_000_000_000_000_000n; // 0.001 NEAR, with a margin
const BATCH_GAS_TGAS = 15n;

export type PauseReason = 'gas' | 'ai';
/** What asks: a birth, a new thought and a snack stop on any pause; an outfit purchase or grant
 * and a stage change only on the gas one (`Pet life data`). */
export type PauseUse = 'birth' | 'thought' | 'snack' | 'outfit' | 'grow';

export async function pauseReason(db: D1Database): Promise<PauseReason | null> {
  const row = await db.prepare('SELECT reason FROM service_pause WHERE id = 1').first<{ reason: string | null }>();
  return row?.reason === 'gas' || row?.reason === 'ai' ? row.reason : null;
}

export async function isPaused(db: D1Database, use: PauseUse): Promise<boolean> {
  const reason = await pauseReason(db);
  if (reason === null) return false;
  return use === 'outfit' || use === 'grow' ? reason === 'gas' : true;
}

/** Starts a pause. A pause already on keeps its reason and its start. */
export async function setPause(db: D1Database, reason: PauseReason, nowMs: number): Promise<void> {
  await db
    .prepare('INSERT INTO service_pause (id, reason, since, last_probe) VALUES (1, ?, ?, NULL) ON CONFLICT (id) DO UPDATE SET reason = excluded.reason, since = excluded.since, last_probe = NULL WHERE service_pause.reason IS NULL')
    .bind(reason, nowMs)
    .run();
}

/** The gas to keep on the server's account: a batch per open session, plus one birth. */
export async function gasReserve(env: Env): Promise<bigint> {
  const rows = await env.DB.prepare(
    "SELECT s.id, COUNT(t.id) AS n FROM debit_sessions s LEFT JOIN thoughts t ON t.session_id = s.id AND t.status = 'unbilled' WHERE s.status IN ('open', 'sending') GROUP BY s.id",
  ).all<{ id: string; n: number }>();
  let batches = 0n;
  for (const row of rows.results) batches += BigInt(Math.max(1, Math.ceil(row.n / 12)));
  if (batches === 0n) batches = 1n;
  return (batches * BATCH_GAS_TGAS + PET_MINT_TGAS) * NEAR_PER_TGAS_YOCTO;
}

/** Reads the server account's balance now; at or under the reserve the gas pause starts. A failed
 * read is `ChainUnreachable`. */
export async function gasIsLow(env: Env, nowMs: number): Promise<boolean> {
  const balance = BigInt(await accountBalance(env, env.SERVER_ACCOUNT_ID));
  if (balance > (await gasReserve(env))) return false;
  await setPause(env.DB, 'gas', nowMs);
  return true;
}

export async function clearPause(db: D1Database): Promise<void> {
  await db.prepare('UPDATE service_pause SET reason = NULL, since = NULL, last_probe = NULL WHERE id = 1').run();
}

export async function lastProbe(db: D1Database): Promise<number | null> {
  const row = await db.prepare('SELECT last_probe FROM service_pause WHERE id = 1').first<{ last_probe: number | null }>();
  return row?.last_probe ?? null;
}

export async function noteProbe(db: D1Database, nowMs: number): Promise<void> {
  await db.prepare('UPDATE service_pause SET last_probe = ? WHERE id = 1').bind(nowMs).run();
}
