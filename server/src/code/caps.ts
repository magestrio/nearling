// What bounds code before it loads (`Skill code data`, ADR-025, OD-1850): ≤ 20 test runs a pet a UTC day, and ≤ 330 code
// versions (`<token_id>:<code hash>`) loaded in a UTC day across the game. A version already loaded today runs again
// at no cost to the cap, since Cloudflare bills a version once a day. Every version the game loads is the project's
// spend at the day-and-version price (`project_spend` kind `code_version`), which births read against the $100 threshold.
import { projectPays } from '../spend';

export const MAX_TEST_RUNS = 20;
export const MAX_VERSIONS_PER_DAY = 330;
/** What one version costs the project: $0.002 in micro-dollars (volatile, ADR-025 › Billing). */
export const VERSION_USD_MICROS = 2_000;

/** One more test run of the pet today, or `false` when it has had all 20 (one statement: the count and the check agree). */
export async function takeTestRun(db: D1Database, tokenId: string, day: number): Promise<boolean> {
  const row = await db
    .prepare('INSERT INTO code_tests (token_id, day, runs) VALUES (?1, ?2, 1) ON CONFLICT (token_id, day) DO UPDATE SET runs = runs + 1 WHERE runs < ?3 RETURNING runs')
    .bind(tokenId, day, MAX_TEST_RUNS)
    .first<{ runs: number }>();
  return row !== null;
}

/** Give back a run when the game's cap stopped it before a version loaded. */
export async function giveBackTestRun(db: D1Database, tokenId: string, day: number): Promise<void> {
  await db.prepare('UPDATE code_tests SET runs = runs - 1 WHERE token_id = ?1 AND day = ?2 AND runs > 0').bind(tokenId, day).run();
}

/** Test runs left today. */
export async function testRunsLeft(db: D1Database, tokenId: string, day: number): Promise<number> {
  const row = await db.prepare('SELECT runs FROM code_tests WHERE token_id = ?1 AND day = ?2').bind(tokenId, day).first<{ runs: number }>();
  return MAX_TEST_RUNS - (row?.runs ?? 0);
}

/** The code hash that passed a test run today, if any. */
export async function passedHash(db: D1Database, tokenId: string, day: number): Promise<string | null> {
  const row = await db.prepare('SELECT passed_hash FROM code_tests WHERE token_id = ?1 AND day = ?2').bind(tokenId, day).first<{ passed_hash: string | null }>();
  return row?.passed_hash ?? null;
}

export async function markPassed(db: D1Database, tokenId: string, day: number, hash: string): Promise<void> {
  await db.prepare('UPDATE code_tests SET passed_hash = ?3 WHERE token_id = ?1 AND day = ?2').bind(tokenId, day, hash).run();
}

/** `loaded`: this version already loaded today, free to run again. `new`: it is counted now and the project pays for it.
 * `capped`: the game's 330 are used and this is not one of them — nothing may load. */
export type Claim = 'loaded' | 'new' | 'capped';

export async function claimVersion(env: Pick<Env, 'DB'>, day: number, version: string): Promise<Claim> {
  const seen = () => env.DB.prepare('SELECT 1 AS found FROM code_versions WHERE day = ?1 AND version = ?2').bind(day, version).first();
  if ((await seen()) !== null) return 'loaded';
  // one statement: the count and the insert agree, whatever else is loading
  const inserted = await env.DB
    .prepare('INSERT INTO code_versions (day, version) SELECT ?1, ?2 WHERE (SELECT COUNT(*) FROM code_versions WHERE day = ?1) < ?3 ON CONFLICT DO NOTHING RETURNING version')
    .bind(day, version, MAX_VERSIONS_PER_DAY)
    .first();
  if (inserted !== null) return 'new';
  // lost the race to the same version, or the day is full
  return (await seen()) !== null ? 'loaded' : 'capped';
}

/** Claims the version and, for a new one, writes the project's spend for it. */
export async function claimAndBill(env: Env, day: number, version: string): Promise<Claim> {
  const claim = await claimVersion(env, day, version);
  if (claim === 'new') await projectPays(env, 'code_version', VERSION_USD_MICROS);
  return claim;
}
