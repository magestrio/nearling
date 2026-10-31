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
import { afterWake, wakeDue, wakeIfFed } from './wake';

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
}

export type Outcome = { status: 'ok'; value?: string | null; burnt?: string } | { status: 'failed'; code: string };

/** The node that executed the meal may be behind the one that answers a read a moment later; a wake
 * that finds the pet still asleep tries once more after this. */
const SECOND_READ_MS = 1_000;

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const FEEDINGS_COLUMNS = 'id, sub, account, token_id, source, via, deposit_yocto, tx_hash, created_at';

/** Settles `row` with the outcome the network gave. `false`: another flow had already claimed it. */
export async function settleFeeding(env: Env, row: FeedingRow, outcome: Outcome): Promise<boolean> {
  const claim = [env.DB.prepare('DELETE FROM feedings WHERE id = ? RETURNING id').bind(row.id)];
  let name = '';
  if (outcome.status === 'ok' && row.via === 'link') {
    const player = await env.DB.prepare('SELECT first_name FROM players WHERE sub = ?').bind(row.sub).first<{ first_name: string | null }>();
    // '' is a nameless friend: the pet and the owner say «a friend».
    name = player?.first_name ?? '';
    // The owner's poll leaves the wake to this flow while the row stands, so the row and the friend's
    // wake end in one write: a poll finds the row or the awake pet, never the sleep without the row.
    if (await friendWakeDue(env, row.token_id)) {
      claim.unshift(
        env.DB.prepare('UPDATE pets SET slept_at = NULL, wake_seq = wake_seq + 1, wake_by = ?1 WHERE token_id = ?2 AND slept_at IS NOT NULL AND EXISTS (SELECT 1 FROM feedings WHERE id = ?3)').bind(name, row.token_id, row.id),
      );
    }
  }
  const written = await env.DB.batch(claim);
  if (written.at(-1)!.results.length === 0) return false;
  const friendWoke = written.length === 2 && written[0]!.meta.changes > 0;

  if (outcome.status === 'failed') {
    console.log(`${row.source === 'snack' ? 'snack' : 'feed'}_failed:${outcome.code}`);
    // The friend's reservation goes with a snack that did not happen: the snack is theirs again.
    if (row.source === 'snack' && row.via === 'link') {
      await env.DB.prepare('DELETE FROM friend_snacks WHERE account = ? AND token_id = ? AND day = ?').bind(row.account, row.token_id, utcDay(row.created_at)).run();
    }
    return true;
  }

  const now = Date.now();
  const statements: D1PreparedStatement[] = [];
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
  if (statements.length > 0) await env.DB.batch(statements);

  if (row.source === 'near' && row.deposit_yocto !== null) await lowerWalletSeen(env.DB, row.sub, BigInt(row.deposit_yocto));

  if (row.via === 'link') {
    if (friendWoke) {
      await afterWake(env, row.token_id, 'link', name);
    } else {
      // `afterWake` writes the note only for a wake; a meal that woke nothing is remembered here.
      await env.DB.prepare("INSERT INTO memory_notes (token_id, kind, name, at) VALUES (?, 'fed_by', ?, ?)").bind(row.token_id, name, Date.now()).run();
    }
  } else {
    await unlessUnread(wakeIfFed(env, row.token_id, 'owner'));
  }
  track('pet_fed', { via: row.via, source: row.source });
  return true;
}

/** Whether a friend's meal wakes the pet, read before the claim. The row holds the owner's poll off
 * meanwhile, also through the second read. */
async function friendWakeDue(env: Env, tokenId: string): Promise<boolean> {
  return unlessUnread(
    (async () => {
      if (await wakeDue(env, tokenId)) return true;
      if (!(await isAsleep(env.DB, tokenId))) return false;
      await pause(SECOND_READ_MS);
      return wakeDue(env, tokenId);
    })(),
  );
}

/** A pet that cannot be read after the chain recorded the meal is no wake and no error: the rest of
 * the meal's consequences run, and the owner's poll wakes the pet. */
async function unlessUnread(wake: Promise<boolean>): Promise<boolean> {
  try {
    return await wake;
  } catch (e) {
    if (e instanceof ChainUnreachable) return false;
    throw e;
  }
}

async function isAsleep(db: D1Database, tokenId: string): Promise<boolean> {
  const row = await db.prepare('SELECT slept_at FROM pets WHERE token_id = ?').bind(tokenId).first<{ slept_at: number | null }>();
  return row?.slept_at != null;
}
