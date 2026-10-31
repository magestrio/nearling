// The player's game wallet as the server counts it (`Player wallet data`, `Feeding gas data`).
//
// The balance is read from the network at every opening of feeding and while the Add NEAR sheet is
// open. What the server keeps per player is decimal text (yoctoNEAR does not fit a SQLite integer):
//  - `gas_added_yocto`: what the project's transfers put into the wallet;
//  - `wallet_seen_yocto`: the highest balance counted as the player's own NEAR. A read above it is a
//    funding (`wallet_funded`), then `seen` moves up to it. Reads never lower it; a top-up raises it
//    by its amount in the statement that claims it; a confirmed meal lowers it by the deposit only,
//    so the gas refund that lands blocks later, the refund of a refused meal and the project's gas
//    never read as money. Nothing is read as funding while the player's `feedings` row stands.
import { walletBalance } from '../chain';
import type { Session } from '../auth';
import { track } from '../track';

export interface PlayerWallet {
  /** The wallet's balance now, yoctoNEAR; a wallet the network has no record of holds 0. */
  balance: bigint;
  /** What the project put into the wallet (the feeding top-up, with `add-gift` the gift's). */
  gasAdded: bigint;
  /** The feeding top-up was given (once per player, ADR-006). */
  topUpGiven: boolean;
  /** The first word of the Google name when it passed `Feeder identity data`. */
  firstName: string | null;
  /** This read counted a funding: NEAR the player brought in since the last one. */
  funded: boolean;
}

interface PlayerRow {
  first_name: string | null;
  gas_topup_at: number | null;
  gas_added_yocto: string;
  wallet_seen_yocto: string;
}

/** Reads the wallet and, when its balance rose above what was seen and no meal is on its way, counts
 * the funding once: two tabs reading at the same time, one wins the statement. `ChainUnreachable`
 * when the balance cannot be read. */
export async function readWallet(env: Pick<Env, 'DB' | 'NEAR_RPC_URL'>, session: Pick<Session, 'sub' | 'accountId'>): Promise<PlayerWallet> {
  const row = await env.DB.prepare('SELECT first_name, gas_topup_at, gas_added_yocto, wallet_seen_yocto FROM players WHERE sub = ?').bind(session.sub).first<PlayerRow>();
  const balance = await walletBalance(env, session.accountId);
  let funded = false;
  if (row !== null) {
    const seen = BigInt(row.wallet_seen_yocto);
    if (balance > seen) {
      const onItsWay = await env.DB.prepare('SELECT 1 AS found FROM feedings WHERE account = ?').bind(session.accountId).first();
      if (onItsWay === null) {
        const moved = await env.DB.prepare('UPDATE players SET wallet_seen_yocto = ?1 WHERE sub = ?2 AND wallet_seen_yocto = ?3')
          .bind(balance.toString(), session.sub, row.wallet_seen_yocto)
          .run();
        if (moved.meta.changes > 0) {
          funded = true;
          track('wallet_funded');
        }
      }
    }
  }
  return {
    balance,
    gasAdded: BigInt(row?.gas_added_yocto ?? '0'),
    topUpGiven: row?.gas_topup_at != null,
    firstName: row?.first_name ?? null,
    funded,
  };
}

/** Takes back a claim whose transfer definitely did not happen (a refusal, nothing sent): the player
 * is owed the top-up again. Only the claim that was made at `claimedAtMs` is released, and `gas_added`
 * and `seen` go down by the amount that claim put in. An unknown transfer is never released
 * (ADR-006: never twice). */
export async function releaseGasTopUp(db: D1Database, sub: string, amount: bigint, claimedAtMs: number): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const row = await db.prepare('SELECT gas_topup_at, gas_added_yocto, wallet_seen_yocto FROM players WHERE sub = ?').bind(sub).first<PlayerRow>();
    if (row === null || row.gas_topup_at !== claimedAtMs) return;
    const added = BigInt(row.gas_added_yocto);
    const seen = BigInt(row.wallet_seen_yocto);
    const released = await db
      .prepare('UPDATE players SET gas_topup_at = NULL, gas_added_yocto = ?1, wallet_seen_yocto = ?2 WHERE sub = ?3 AND gas_topup_at = ?4 AND gas_added_yocto = ?5 AND wallet_seen_yocto = ?6')
      .bind((added > amount ? added - amount : 0n).toString(), (seen > amount ? seen - amount : 0n).toString(), sub, claimedAtMs, row.gas_added_yocto, row.wallet_seen_yocto)
      .run();
    if (released.meta.changes > 0) return;
  }
}

/** A confirmed meal lowers `seen` by its deposit and by nothing else (burnt gas stays in `seen`, so
 * the refund that lands later never reads as money). Never below zero. */
export async function lowerWalletSeen(db: D1Database, sub: string, amount: bigint): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const row = await db.prepare('SELECT wallet_seen_yocto FROM players WHERE sub = ?').bind(sub).first<{ wallet_seen_yocto: string }>();
    if (row === null) return;
    const seen = BigInt(row.wallet_seen_yocto);
    const moved = await db
      .prepare('UPDATE players SET wallet_seen_yocto = ?1 WHERE sub = ?2 AND wallet_seen_yocto = ?3')
      .bind((seen > amount ? seen - amount : 0n).toString(), sub, row.wallet_seen_yocto)
      .run();
    if (moved.meta.changes > 0) return;
  }
}

/** Claims the player's one top-up of gas: marks it given and raises `gas_added` and `seen` by its
 * amount in one statement, so the transfer that follows never reads as funding. Only the first
 * caller gets `true` (a second tab gets `false` and sends nothing). The statement checks the values
 * it was computed from, so a read that moved `seen` meanwhile makes it try again with the new one. */
export async function claimGasTopUp(db: D1Database, sub: string, amount: bigint, nowMs: number): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const row = await db.prepare('SELECT gas_topup_at, gas_added_yocto, wallet_seen_yocto FROM players WHERE sub = ?').bind(sub).first<PlayerRow>();
    if (row === null || row.gas_topup_at !== null) return false;
    const claimed = await db
      .prepare('UPDATE players SET gas_topup_at = ?1, gas_added_yocto = ?2, wallet_seen_yocto = ?3 WHERE sub = ?4 AND gas_topup_at IS NULL AND gas_added_yocto = ?5 AND wallet_seen_yocto = ?6')
      .bind(nowMs, (BigInt(row.gas_added_yocto) + amount).toString(), (BigInt(row.wallet_seen_yocto) + amount).toString(), sub, row.gas_added_yocto, row.wallet_seen_yocto)
      .run();
    if (claimed.meta.changes > 0) return true;
  }
  return false;
}
