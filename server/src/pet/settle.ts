// The consequences of a meal or a snack, run once (`Feeding outcome rule`, design.md › Решения).
//
// A portion of NEAR or a snack is on its way as a `feedings` row (one per player). Whoever learns the
// outcome first - `POST …/feed/send`, `GET …/feed`, the outcome route, the cron - settles it, and the
// claim is `DELETE … RETURNING`: of all of them exactly one runs what follows, the rest only answer.
import { ChainUnreachable } from '../chain';
import { utcDay } from '../http';
import { KNOWN_RECORD_YOCTO, nearUsdRate, SNACK_YOCTO, yoctoToUsdMicros } from '../pricing';
import { lowerWalletSeen } from '../feeding/wallet';
import { track } from '../track';
import { noteFriend, noteMood } from './life';
import { pendingFriendWake, wakeIfFed } from './wake';
import { confirmedFunding } from '../errands/funding';
import { startShared } from '../errands/sharedRun';

export interface FeedingRow {
  id: string;
  sub: string;
  account: string;
  token_id: string;
  /** `near`: a portion the player signed; `snack`: a snack the server sent. */
  source: 'near' | 'snack';
  /** `owner`: the pet's owner fed it; `link`: anyone else did. */
  via: 'owner' | 'link';
  deposit_yocto: string | null;
  tx_hash: string | null;
  created_at: number;
  job_hash?: string | null;
}

export type Outcome = { status: 'ok'; value?: string | null; burnt?: string } | { status: 'failed'; code: string };

const SECOND_READ_MS = 1_000;
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const FEEDINGS_COLUMNS = 'id, sub, account, token_id, source, via, deposit_yocto, tx_hash, created_at, job_hash';

/** Settles `row` with the outcome the network gave. `false`: another flow had already claimed it. */
export async function settleFeeding(env: Env, row: FeedingRow, outcome: Outcome): Promise<boolean> {
  const claim = [env.DB.prepare('DELETE FROM feedings WHERE id = ? RETURNING id').bind(row.id)];
  if (outcome.status === 'ok') {
    claim.unshift(env.DB.prepare(`INSERT INTO known_pets (account_id, token_id, reason, interacted_at)
      SELECT ?1, ?2, 'feed', ?3 WHERE EXISTS (SELECT 1 FROM feedings WHERE id = ?4)
      ON CONFLICT (account_id, token_id) DO UPDATE SET reason = 'feed', interacted_at = excluded.interacted_at`)
      .bind(row.account, row.token_id, Date.now(), row.id));
  }
  if (outcome.status === 'ok' && row.via === 'link') {
    // Keep this independent read for the cron. Its RPC cannot hold up a confirmed outcome.
    claim.unshift(env.DB.prepare('INSERT OR IGNORE INTO feed_introductions (feed_id, account, token_id, created_at) VALUES (?, ?, ?, ?)')
      .bind(row.id, row.account, row.token_id, Date.now()));
  }
  if (outcome.status === 'ok' && row.job_hash != null) {
    const funding = await confirmedFunding(env, row);
    claim.unshift(env.DB.prepare(
      `INSERT INTO shared_funding_evidence (job_hash, funding_index, tx_hash, token_id, source, amount_yocto)
       VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (job_hash, funding_index) DO NOTHING`,
    ).bind(row.job_hash, funding.index, funding.txHash, row.token_id, row.source, funding.amount));
    claim.unshift(env.DB.prepare(
      `INSERT INTO shared_errand_contributions (tx_hash, token_id, job_hash, contributor_account, source, amount_yocto, confirmed_at, funding_index)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8 FROM shared_errands
       WHERE token_id = ?2 AND job_hash = ?3 ON CONFLICT (tx_hash) DO NOTHING`,
    ).bind(funding.txHash, row.token_id, row.job_hash, row.account, row.source, funding.amount, Date.now(), funding.index));
  }
  let name = '';
  if (outcome.status === 'ok' && row.via === 'link') {
    const player = await env.DB.prepare('SELECT first_name FROM players WHERE sub = ?').bind(row.sub).first<{ first_name: string | null }>();
    // '' is a nameless friend: the pet and the owner say «a friend».
    name = player?.first_name ?? '';
    // Commit the confirmed outcome now. The owner's poll can retry this named wake independently
    // of the in-flight row, even if every pet view immediately after confirmation is stale.
    claim.unshift(env.DB.prepare(`INSERT OR IGNORE INTO pending_feed_wakes (token_id, feed_id, name, created_at)
      SELECT ?1, ?2, ?3, ?4 FROM pets WHERE token_id = ?1 AND slept_at IS NOT NULL
        AND EXISTS (SELECT 1 FROM feedings WHERE id = ?2)`)
      .bind(row.token_id, row.id, name, Date.now()));
  }
  const written = await env.DB.batch(claim);
  if (written.at(-1)!.results.length === 0) return false;

  if (outcome.status === 'failed') {
    console.log(`${row.source === 'snack' ? 'snack' : 'feed'}_failed:${outcome.code}`);
    // The friend's reservation goes with a snack that did not happen: the snack is theirs again.
    if (row.source === 'snack' && row.via === 'link') {
      await env.DB.prepare('DELETE FROM friend_snacks WHERE account = ? AND token_id = ? AND day = ?').bind(row.account, row.token_id, utcDay(row.created_at)).run();
    }
    return true;
  }

  const now = Date.now();
  // A confirmed meal or snack lifts the pet's mood for the day, the owner's or a friend's (`Mood
  // rule`); a friend's is also a deed of the window, once per friend (`Trait rule`). A failed meal
  // returned above and does neither.
  const statements: D1PreparedStatement[] = noteMood(env.DB, row.token_id, utcDay(now));
  if (row.via === 'link') statements.push(...noteFriend(env.DB, row.token_id, row.account));
  // A friend's meal or snack is an acquaintance of the pet: a hint for hiring, whether or not the pool
  // paid the chain's record (`pet_knows` is the truth, §8 › Индекс знакомых).
  if (row.via === 'link') {
    statements.push(env.DB.prepare('INSERT OR IGNORE INTO known_index (token_id, account) VALUES (?, ?)').bind(row.token_id, row.account));
  }
  // What the project paid for a snack: its food, its gas and, when the pool paid a new acquaintance's
  // record, that storage (Траты проекта). A portion costs the project nothing.
  if (row.source === 'snack') {
    const rate = nearUsdRate(env.NEAR_USD_RATE);
    if (rate === null) {
      console.log('rate_missing');
    } else {
      const spend: [string, bigint][] = [['snack', SNACK_YOCTO]];
      if (outcome.burnt !== undefined) spend.push(['gas', BigInt(outcome.burnt)]);
      if (outcome.value === 'true') spend.push(['storage', KNOWN_RECORD_YOCTO]);
      for (const [kind, yocto] of spend) {
        statements.push(env.DB.prepare('INSERT INTO project_spend (at, kind, usd_micros) VALUES (?, ?, ?)').bind(now, kind, yoctoToUsdMicros(yocto, rate)));
      }
    }
  } else if (outcome.value === 'true') {
    const rate = nearUsdRate(env.NEAR_USD_RATE);
    if (rate !== null) statements.push(env.DB.prepare('INSERT INTO project_spend (at, kind, usd_micros) VALUES (?, ?, ?)').bind(now, 'storage', yoctoToUsdMicros(KNOWN_RECORD_YOCTO, rate)));
  }
  await env.DB.batch(statements);

  if (row.source === 'near' && row.deposit_yocto !== null) await lowerWalletSeen(env.DB, row.sub, BigInt(row.deposit_yocto));

  if (row.via === 'link') {
    await env.DB.prepare("INSERT INTO memory_notes (token_id, kind, name, at) VALUES (?, 'fed_by', ?, ?)").bind(row.token_id, name, Date.now()).run();
    // A second provider read can see the just-confirmed food; the owner's poll remains the
    // prompt retry if both reads lag or the RPC cannot be read.
    const first = await pendingFriendWake(env, row.token_id);
    if (first.pending) {
      await pause(SECOND_READ_MS);
      await pendingFriendWake(env, row.token_id);
    }
  } else {
    await unlessUnread(wakeIfFed(env, row.token_id, 'owner'));
  }
  track('pet_fed', { via: row.via, source: row.source });
  if (row.job_hash != null) await startShared(env, row.token_id).catch(() => console.log('shared_start_failed'));
  return true;
}

/** An owner meal can leave its wake to the owner's poll on an unreadable chain. */
async function unlessUnread(wake: Promise<boolean>): Promise<boolean> {
  try {
    return await wake;
  } catch (e) {
    if (e instanceof ChainUnreachable) return false;
    throw e;
  }
}
