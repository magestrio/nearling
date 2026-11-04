import type { Session } from '../auth';
import { decodeSignedTransaction, type SignedTransaction } from 'near-api-js';
import { accountBalance, ChainUnreachable, GIFT_RESERVE_YOCTO, isNodeRefusal, sendSigned, transactionExpired, txHashOf, txStatus, walletBalance } from '../chain';

const NEW_ACCOUNT_COST = 14_000_000_000_000_000_000_000n;
const EXISTING_ACCOUNT_COST = 7_000_000_000_000_000_000_000n;
const UNSENT_STALE_MS = 30_000;
const RETRY_MS = 10_000;

interface ClaimRow {
  gift_topup_at: number | null;
  gift_topup_flight: string | null;
  gift_topup_op: string | null;
  gift_topup_signed_bytes: number[] | ArrayBuffer | null;
  gift_topup_retry_at: number | null;
  gas_added_yocto: string;
  wallet_seen_yocto: string;
}

async function claimRow(db: D1Database, sub: string): Promise<ClaimRow | null> {
  return db.prepare('SELECT gift_topup_at, gift_topup_flight, gift_topup_op, gift_topup_signed_bytes, gift_topup_retry_at, gas_added_yocto, wallet_seen_yocto FROM players WHERE sub = ?')
    .bind(sub).first<ClaimRow>();
}

async function release(env: Env, sub: string, at: number, op: string | null): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    const row = await claimRow(env.DB, sub);
    if (row?.gift_topup_at !== at || row.gift_topup_op !== op) return;
    const added = BigInt(row.gas_added_yocto);
    const seen = BigInt(row.wallet_seen_yocto);
    const changed = await env.DB.prepare(
      'UPDATE players SET gift_topup_at = NULL, gift_topup_flight = NULL, gift_topup_op = NULL, gift_topup_signed_bytes = NULL, gift_topup_retry_at = NULL, gas_added_yocto = ?1, wallet_seen_yocto = ?2 WHERE sub = ?3 AND gift_topup_at = ?4 AND gift_topup_op IS ?5 AND gas_added_yocto = ?6 AND wallet_seen_yocto = ?7',
    ).bind((added > GIFT_RESERVE_YOCTO ? added - GIFT_RESERVE_YOCTO : 0n).toString(),
      (seen > GIFT_RESERVE_YOCTO ? seen - GIFT_RESERVE_YOCTO : 0n).toString(),
      sub, at, op, row.gas_added_yocto, row.wallet_seen_yocto).run();
    if (changed.meta.changes === 1) return;
  }
}

export type GasAnswer = { kind: 'ready' } | { kind: 'pending' } | { kind: 'paused' } | { kind: 'short'; missingYocto: string };

async function storedTransfer(env: Env, session: Session, row: ClaimRow): Promise<SignedTransaction | null> {
  if (row.gift_topup_flight === null || row.gift_topup_signed_bytes === null) return null;
  try {
    const bytes = row.gift_topup_signed_bytes instanceof ArrayBuffer
      ? new Uint8Array(row.gift_topup_signed_bytes) : Uint8Array.from(row.gift_topup_signed_bytes);
    const signed = decodeSignedTransaction(bytes);
    const tx = signed.transaction;
    if (await txHashOf(signed) !== row.gift_topup_flight || tx.signerId !== env.GAS_ACCOUNT_ID
      || tx.receiverId !== session.accountId || tx.actions.length !== 1
      || tx.actions[0]?.transfer?.deposit !== GIFT_RESERVE_YOCTO) return null;
    return signed;
  } catch { return null; }
}

/** The gift claim is separate from the feeding claim. The claim and both wallet counters move in
 * one D1 statement before the gas account signs anything. An uncertain transfer keeps the claim. */
export async function giftGas(env: Env, session: Session): Promise<GasAnswer> {
  const balance = await walletBalance(env, session.accountId);
  if (balance >= GIFT_RESERVE_YOCTO) return { kind: 'ready' };
  const row = await claimRow(env.DB, session.sub);
  if (row === null) return { kind: 'pending' };
  if (row.gift_topup_at !== null) {
    if (row.gift_topup_flight !== null) {
      const result = await txStatus(env, row.gift_topup_flight, env.GAS_ACCOUNT_ID);
      if (result?.status === 'failed') {
        await release(env, session.sub, row.gift_topup_at, row.gift_topup_op);
      } else if (result?.status === 'ok') {
        return { kind: 'short', missingYocto: (GIFT_RESERVE_YOCTO - balance).toString() };
      } else {
        const signed = await storedTransfer(env, session, row);
        const expired = signed === null
          ? Date.now() - row.gift_topup_at > 24 * 3_600_000
          : await transactionExpired(env, signed.transaction.blockHash, row.gift_topup_at);
        if (expired) {
          // Expiry only stops another broadcast of these bytes. A pruned status cannot
          // tell whether the reserve landed and was already spent by the player.
          return { kind: 'short', missingYocto: (GIFT_RESERVE_YOCTO - balance).toString() };
        } else {
          if (signed !== null) {
            const now = Date.now();
            const retry = await env.DB.prepare(
              'UPDATE players SET gift_topup_retry_at = ?1 WHERE sub = ?2 AND gift_topup_at = ?3 AND gift_topup_op IS ?4 AND gift_topup_flight = ?5 AND (gift_topup_retry_at IS NULL OR gift_topup_retry_at < ?6)',
            ).bind(now, session.sub, row.gift_topup_at, row.gift_topup_op, row.gift_topup_flight, now - RETRY_MS).run();
            if (retry.meta.changes === 1) {
              const resent = await sendSigned(env, signed);
              if (resent.status === 'failed') {
                // A replay can be rejected after the first send landed. Only a recorded
                // execution failure proves the top-up was not used.
                const settled = await txStatus(env, row.gift_topup_flight, env.GAS_ACCOUNT_ID);
                if (settled?.status === 'failed') await release(env, session.sub, row.gift_topup_at, row.gift_topup_op);
                else return { kind: 'pending' };
              }
              else if (resent.status === 'ok') return (await walletBalance(env, session.accountId)) >= GIFT_RESERVE_YOCTO
                ? { kind: 'ready' } : { kind: 'short', missingYocto: (GIFT_RESERVE_YOCTO - balance).toString() };
              else return { kind: 'pending' };
            } else return { kind: 'pending' };
          } else return { kind: 'pending' };
        }
      }
    } else {
      // The queued job may still sign. Once this claim is stale, release it by operation ID;
      // its delayed onSigned update will then fail before any broadcast.
      if (Date.now() - row.gift_topup_at < UNSENT_STALE_MS) return { kind: 'pending' };
      await release(env, session.sub, row.gift_topup_at, row.gift_topup_op);
    }
  }
  const fresh = await claimRow(env.DB, session.sub);
  if (fresh === null || fresh.gift_topup_at !== null) return { kind: 'pending' };
  const gasBalance = BigInt(await accountBalance(env, env.GAS_ACCOUNT_ID));
  // A new implicit account costs the gas account creation plus transfer fees as measured in the
  // sandbox. Checking this before the claim keeps the paused path free of any signature.
  if (gasBalance < (balance === 0n ? NEW_ACCOUNT_COST : EXISTING_ACCOUNT_COST)) return { kind: 'paused' };
  const now = Date.now();
  const op = crypto.randomUUID();
  const claimed = await env.DB.prepare(
    'UPDATE players SET gift_topup_at = ?1, gift_topup_op = ?2, gift_topup_flight = NULL, gift_topup_signed_bytes = NULL, gift_topup_retry_at = NULL, gas_added_yocto = ?3, wallet_seen_yocto = ?4 WHERE sub = ?5 AND gift_topup_at IS NULL AND gas_added_yocto = ?6 AND wallet_seen_yocto = ?7',
  ).bind(now, op, (BigInt(fresh.gas_added_yocto) + GIFT_RESERVE_YOCTO).toString(),
    (BigInt(fresh.wallet_seen_yocto) + GIFT_RESERVE_YOCTO).toString(),
    session.sub, fresh.gas_added_yocto, fresh.wallet_seen_yocto).run();
  if (claimed.meta.changes !== 1) return { kind: 'pending' };
  const result = await env.SERVER_KEY.get(env.SERVER_KEY.idFromName('gas'))
    .transfer(session.accountId, GIFT_RESERVE_YOCTO.toString(), { sub: session.sub, claimedAt: now, op });
  if (result.status === 'unreachable') {
    // The key did not broadcast if it could not persist its signed hash. If the network itself was
    // unreachable after signing, the stored hash keeps the claim for reconciliation.
    const current = await claimRow(env.DB, session.sub);
    if (current?.gift_topup_flight === null) await release(env, session.sub, now, op);
    throw new ChainUnreachable();
  }
  if (result.status === 'failed') {
    const current = await claimRow(env.DB, session.sub);
    const settled = current?.gift_topup_flight ? await txStatus(env, current.gift_topup_flight, env.GAS_ACCOUNT_ID) : null;
    // This is the claim's first send. A typed node refusal without an executed hash proves
    // no reserve moved; later rebroadcasts cannot make that inference from an unseen hash.
    if (settled?.status === 'failed' || (settled === null && isNodeRefusal(result.code))) {
      await release(env, session.sub, now, op);
      return result.code === 'not_enough_balance' ? { kind: 'paused' } : { kind: 'pending' };
    }
    return { kind: 'pending' };
  }
  if (result.status === 'unknown') return { kind: 'pending' };
  return (await walletBalance(env, session.accountId)) >= GIFT_RESERVE_YOCTO ? { kind: 'ready' } : { kind: 'pending' };
}
