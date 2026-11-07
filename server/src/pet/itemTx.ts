// The transaction that wrote an item to a pet (`Wardrobe data`: «The hash of the transaction that wrote an
// item stays in §8 › Транзакции питомца»; ADR-012; design.md › The item's transaction).
//
// A writer holds the hash only when it hears the answer. Three paths lose it: a desk or Worker that dies
// inside the send, an answer that never comes, and a resend refused because the first send landed. So
// every transaction a writer signs is noted in `item_sends` BEFORE it is broadcast (`noteItemSend`, called
// by `ServerKey`), a writer with an `ok` keeps the hash at once (`itemTxStatements`), and the cron asks the
// network about the rows nobody settled (`settleItemSends`).
import { ChainUnreachable, hatchView, txStatus, type ServerCall } from '../chain';
import { birthFlight, finishBirth } from './birth';
/** A signed send waiting this long may belong to a writer that stopped. */
const SEND_CLAIM_STALE_MS = 60_000;

/** At most this many hashes are asked after in a tick (an unknown hash makes the RPC wait). */
const SENDS_PER_TICK = 10;
/** A hash the network did not know is asked after again no sooner than this. */
const RECHECK_MS = 10 * 60_000;
/** A hash the network has never answered for 24 hours is dropped: the reference block of the transaction is
 * past the chain's validity window by then, so it can no longer land (`FEEDING_FAILED_AFTER_MS`'s reason). */
const LOST_AFTER_MS = 24 * 3_600_000;

/** Stores the hash of a transaction about to be broadcast for the item (`pet` and slug of `writes`). A throw
 * is the caller's «nothing was sent».
 *
 * For a purchase (`writes.buy`) this is the last check before the broadcast and it is authoritative: the
 * insert happens only while the row of that id is `sending`, in one statement. The cron fails a `sending`
 * row with no hash noted (`settleBuys`), also one that is still waiting in the key's queue; when it did, the
 * insert changes nothing, this throws, and the transaction is not broadcast. The cron's flip
 * in turn changes nothing once a hash is noted, so of the two exactly one wins. */
export async function noteItemSend(db: D1Database, writes: Exclude<NonNullable<ServerCall['writes']>, { kind: 'shared_open' | 'shared_debit' | 'will_start' | 'will_release' }>, txHash: string, now: number, signedBytes: Uint8Array): Promise<void> {
  if (writes.kind === 'birth' || writes.kind === 'growth') {
    const kind = writes.kind;
    const tokenId = kind === 'birth' ? writes.receiver : writes.tokenId;
    const ref = kind === 'birth' ? 'birth' : writes.stage;
    if (writes.kind === 'birth') {
      const [, updated] = await db.batch([
        db.prepare('INSERT OR IGNORE INTO item_sends (tx_hash, token_id, item, sent_at, kind) VALUES (?, ?, ?, ?, ?)')
          .bind(txHash, tokenId, ref, now, kind),
        db.prepare('UPDATE births_in_flight SET tx_hash = ?, signed_bytes = ?, rebroadcast_at = ? WHERE account = ? AND started_at = ?')
          .bind(txHash, signedBytes.buffer.slice(signedBytes.byteOffset, signedBytes.byteOffset + signedBytes.byteLength), now, writes.receiver, writes.startedAt),
      ]);
      if (updated.meta.changes !== 1) throw new Error('birth_claim_lost');
      return;
    }
    await db.prepare('INSERT OR IGNORE INTO item_sends (tx_hash, token_id, item, sent_at, kind) VALUES (?, ?, ?, ?, ?)')
      .bind(txHash, tokenId, ref, now, kind).run();
    return;
  }
  if (writes.buy === undefined) {
    await db.prepare('INSERT OR IGNORE INTO item_sends (tx_hash, token_id, item, sent_at) VALUES (?, ?, ?, ?)').bind(txHash, writes.tokenId, writes.item, now).run();
    return;
  }
  const noted = await db
    .prepare("INSERT INTO item_sends (tx_hash, token_id, item, sent_at) SELECT ?1, ?2, ?3, ?4 WHERE EXISTS (SELECT 1 FROM outfit_buys WHERE id = ?5 AND status = 'sending')")
    .bind(txHash, writes.tokenId, writes.item, now, writes.buy)
    .run();
  if (noted.meta.changes === 0) throw new Error('buy_not_sending');
}

/** Keeps the hash that wrote the item (`pet_transactions`, by token_id, so it stays through a gift and a
 * clear of the memory) and ends the pair's `item_sends` rows: whichever send it was, the item is written
 * once, and the others' rows have nothing left to find. */
export function itemTxStatements(db: D1Database, tokenId: string, item: string, txHash: string, now: number): D1PreparedStatement[] {
  return recordTxStatements(db, tokenId, 'item', item, txHash, now);
}

export function recordTxStatements(db: D1Database, tokenId: string, kind: 'item' | 'growth' | 'birth', ref: string, txHash: string, now: number): D1PreparedStatement[] {
  return [
    db.prepare('INSERT OR IGNORE INTO pet_transactions (token_id, kind, ref, tx_hash, at) VALUES (?, ?, ?, ?, ?)').bind(tokenId, kind, ref, txHash, now),
    db.prepare('DELETE FROM item_sends WHERE token_id = ? AND kind = ? AND item = ?').bind(tokenId, kind, ref),
  ];
}

/** A send the network answered `failed` (or refused) did not write the item: its row has nothing to find. */
export const dropItemSendStatement = (db: D1Database, txHash: string): D1PreparedStatement => db.prepare('DELETE FROM item_sends WHERE tx_hash = ?').bind(txHash);

export const dropItemSend = (db: D1Database, txHash: string): Promise<unknown> => dropItemSendStatement(db, txHash).run();

/** The newest hash noted for the pair: the one send of a purchase whose desk died, or the last of a grant's. */
export function newestItemSend(db: D1Database, tokenId: string, item: string): Promise<string | null> {
  return db
    .prepare('SELECT tx_hash FROM item_sends WHERE token_id = ? AND item = ? ORDER BY sent_at DESC, rowid DESC LIMIT 1')
    .bind(tokenId, item)
    .first<{ tx_hash: string }>()
    .then((r) => r?.tx_hash ?? null);
}

interface SendRow {
  tx_hash: string;
  token_id: string;
  item: string;
  kind: 'item' | 'growth' | 'birth';
  sent_at: number;
}

/** The hashes nobody settled: rows older than a claim and not looked at for 10 minutes, the never-looked
 * first, then the longest-waiting. `ok` keeps the hash whichever send it was; `failed` ends that one row;
 * a hash the network does not know waits, and at 24 hours its row goes (`item_tx_lost` when it was the
 * pair's last and nothing was kept). */
export async function settleItemSends(env: Env, nowMs: number): Promise<void> {
  const due = await env.DB.prepare(
    'SELECT tx_hash, token_id, item, kind, sent_at FROM item_sends WHERE sent_at < ?1 AND (checked_at IS NULL OR checked_at <= ?2) ORDER BY checked_at IS NOT NULL, COALESCE(checked_at, sent_at), rowid LIMIT ?3',
  )
    .bind(nowMs - SEND_CLAIM_STALE_MS, nowMs - RECHECK_MS, SENDS_PER_TICK)
    .all<SendRow>();
  for (const row of due.results) {
    if (row.kind === 'birth') {
      try {
        const hatch = await hatchView(env, row.token_id);
        const result = await birthFlight(env, row.token_id, hatch, nowMs);
        // An older successful POST can have removed the flight before its hash was found.
        // Only a confirmed successful hash may become the pet's verification link.
        if (result === 'none' && hatch.token_id !== null) {
          const status = await txStatus(env, row.tx_hash, env.SERVER_ACCOUNT_ID);
          if (status?.status === 'ok') await finishBirth(env, row.token_id, hatch.token_id, row.tx_hash);
          else if (status?.status === 'failed' || nowMs - row.sent_at >= LOST_AFTER_MS) await dropItemSend(env.DB, row.tx_hash);
        }
        if (result === 'none' && hatch.token_id === null) {
          const status = await txStatus(env, row.tx_hash, env.SERVER_ACCOUNT_ID);
          if (status?.status === 'failed' || nowMs - row.sent_at >= LOST_AFTER_MS) await dropItemSend(env.DB, row.tx_hash);
        }
      } catch (e) {
        if (!(e instanceof ChainUnreachable)) throw e;
        console.log('item_tx_unreadable');
      }
      // Keep unresolved births behind fresh rows until the normal retry interval passes.
      // A completed birth may already have removed this journal row.
      await env.DB.prepare('UPDATE item_sends SET checked_at = ? WHERE tx_hash = ?').bind(nowMs, row.tx_hash).run();
      continue;
    }
    let seen;
    try {
      seen = await txStatus(env, row.tx_hash, env.SERVER_ACCOUNT_ID);
    } catch (e) {
      // The network is not readable now: this row is looked at again a minute on.
      if (!(e instanceof ChainUnreachable)) throw e;
      console.log('item_tx_unreadable');
      continue;
    }
    if (seen?.status === 'ok') {
      await env.DB.batch(recordTxStatements(env.DB, row.token_id, row.kind, row.item, row.tx_hash, nowMs));
    } else if (seen?.status === 'failed') {
      await dropItemSend(env.DB, row.tx_hash);
    } else if (nowMs - row.sent_at >= LOST_AFTER_MS) {
      const gone = await env.DB.prepare('DELETE FROM item_sends WHERE tx_hash = ? RETURNING tx_hash').bind(row.tx_hash).first();
      if (gone === null) continue;
      const left = await env.DB.prepare(
        "SELECT (SELECT COUNT(*) FROM item_sends WHERE token_id = ?1 AND kind = ?3 AND item = ?2) + (SELECT COUNT(*) FROM pet_transactions WHERE token_id = ?1 AND kind = ?3 AND ref = ?2) AS n",
      )
        .bind(row.token_id, row.item, row.kind)
        .first<{ n: number }>();
      if (left?.n === 0) console.log('item_tx_lost');
    } else {
      await env.DB.prepare('UPDATE item_sends SET checked_at = ? WHERE tx_hash = ?').bind(nowMs, row.tx_hash).run();
    }
  }
}
