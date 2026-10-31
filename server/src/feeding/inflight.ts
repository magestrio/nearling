// The meal or snack on its way: the player's `feedings` row, how it is asked after, and the answer a
// route gives about it. One row per player; nothing here is history (§8 › Кормление в пути).
import { txStatus } from '../chain';
import { FEEDINGS_COLUMNS, settleFeeding, type FeedingRow, type Outcome } from '../pet/settle';

export async function rowOfPlayer(db: D1Database, account: string): Promise<FeedingRow | null> {
  return db.prepare(`SELECT ${FEEDINGS_COLUMNS} FROM feedings WHERE account = ?`).bind(account).first<FeedingRow>();
}

/** The account that signed the row's transaction: the player's for a portion, the server's for a snack. */
export const senderOf = (env: Pick<Env, 'SERVER_ACCOUNT_ID'>, row: Pick<FeedingRow, 'source' | 'account'>): string =>
  row.source === 'snack' ? env.SERVER_ACCOUNT_ID : row.account;

/** Asks the network about the row's transaction and, when it has an answer, settles the row. `null`:
 * no answer yet (the row has no hash, the network has not seen it, or it has not finished). The
 * outcome is returned whether or not this call was the one that ran the consequences. */
export async function askNetwork(env: Env, row: FeedingRow): Promise<Outcome | null> {
  if (row.tx_hash === null) return null;
  const seen = await txStatus(env, row.tx_hash, senderOf(env, row));
  if (seen?.status === 'ok') {
    const outcome: Outcome = { status: 'ok', value: seen.value, ...(seen.burnt !== undefined ? { burnt: seen.burnt } : {}) };
    await settleFeeding(env, row, outcome);
    return outcome;
  }
  if (seen?.status === 'failed') {
    const outcome: Outcome = { status: 'failed', code: seen.code };
    await settleFeeding(env, row, outcome);
    return outcome;
  }
  return null;
}

/** The answer of `/send`, `/snack` and `/feed/outcome`: the status, the hash, and for the feeder's
 * thanks their own first name and whether they hatched a pet of their own. */
export async function outcomeAnswer(
  db: D1Database,
  sub: string,
  status: 'ok' | 'failed' | 'unknown',
  hash: string | null,
  hatched: boolean,
  withFriend: boolean,
): Promise<Record<string, unknown>> {
  let friend: string | null = null;
  if (status === 'ok' && withFriend) {
    const player = await db.prepare('SELECT first_name FROM players WHERE sub = ?').bind(sub).first<{ first_name: string | null }>();
    friend = player?.first_name ?? null;
  }
  return { status, ...(hash !== null ? { hash } : {}), ...(friend !== null ? { friend } : {}), hatched };
}
