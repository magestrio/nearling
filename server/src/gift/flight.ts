import { KeyType, Signature, SignedTransaction, Transaction, actions, baseEncode, createTransaction, decodeSignedTransaction } from 'near-api-js';
import type { Session } from '../auth';
import { accessKeyNonce, blockTime, ChainUnreachable, GIFT_RESERVE_YOCTO, GIFT_TRANSFER_TGAS, petView, recentBlockHash, sendSigned, transactionExpired, txHashOf, txStatus, walletBalance, type TxOutcome } from '../chain';
import { fromBase64, implicitKey, toBase64, type Reply } from '../feeding/portion';
import { giftGas } from './gas';
import { invalidateMovedLink, linkForToken, type GiftLink } from './link';

const GAS_UNIT = 1_000_000_000_000n;
const unavailable: Reply = { status: 503, body: { code: 'chain_unreachable' } };
const conflict: Reply = { status: 409, body: { code: 'gift_unavailable' } };
const bad: Reply = { status: 400, body: { code: 'bad_tx' } };

export interface GiftFlight {
  token_id: string;
  code: string;
  sender: string;
  receiver: string;
  tx_hash: string;
  signed_bytes: number[] | ArrayBuffer;
  state: 'prepared' | 'sending' | 'unknown' | 'ok' | 'failed' | 'gas_rejected';
  created_at: number;
  resolved_at: number | null;
  rebroadcast_at: number | null;
}

const flightFor = (db: D1Database, tokenId: string): Promise<GiftFlight | null> =>
  db.prepare('SELECT * FROM gift_flights WHERE token_id = ?').bind(tokenId).first<GiftFlight>();

function matchLink(link: GiftLink | null, sender: string): link is GiftLink {
  return link !== null && link.status === 'accepted' && link.giver_account === sender && link.accepted_account !== null;
}

function answer(state: string, hash?: string, extra: Record<string, unknown> = {}): Reply {
  return { status: 200, body: { status: state, ...(hash === undefined ? {} : { hash }), ...extra } };
}

async function finalise(env: Env, row: GiftFlight, when: number): Promise<void> {
  // All effects either commit together or not at all. Each mutation is conditional on the still
  // unresolved flight, so a second poll cannot move the receiver's current pet back after a visit.
  const open = "EXISTS (SELECT 1 FROM gift_flights WHERE token_id = ?1 AND tx_hash = ?2 AND state IN ('prepared', 'sending', 'unknown'))";
  await env.DB.batch([
    env.DB.prepare(`UPDATE gift_links SET status = 'transferred', accepted_name = NULL, transferred_at = ?3, version = version + 1 WHERE token_id = ?1 AND code = ?4 AND status = 'accepted' AND ${open}`)
      .bind(row.token_id, row.tx_hash, when, row.code),
    env.DB.prepare(`UPDATE pets SET last_gift_block_at = ?3, gifted_unmarked = 1 WHERE token_id = ?1 AND ${open}`)
      .bind(row.token_id, row.tx_hash, when),
    env.DB.prepare(`UPDATE players SET last_gifted_pet = ?1, current_pet = CASE WHEN current_pet = ?1 THEN NULL ELSE current_pet END WHERE account_id = ?3 AND ${open}`)
      .bind(row.token_id, row.tx_hash, row.sender),
    env.DB.prepare(`UPDATE players SET current_pet = ?1 WHERE account_id = ?3 AND ${open}`)
      .bind(row.token_id, row.tx_hash, row.receiver),
    env.DB.prepare(`UPDATE receipt_links SET revoked_at = ?3 WHERE paying_token_id = ?1 AND revoked_at IS NULL AND ${open}`)
      .bind(row.token_id, row.tx_hash, when),
    env.DB.prepare("UPDATE gift_flights SET state = 'ok', resolved_at = ?3 WHERE token_id = ?1 AND tx_hash = ?2 AND state IN ('prepared', 'sending', 'unknown')")
      .bind(row.token_id, row.tx_hash, Date.now()),
  ]);
}

async function failed(env: Env, row: GiftFlight, code: string): Promise<Reply> {
  const gas = code === 'not_enough_balance';
  await env.DB.prepare("UPDATE gift_flights SET state = ?3, resolved_at = ?4 WHERE token_id = ?1 AND tx_hash = ?2 AND state IN ('prepared', 'sending', 'unknown')")
    .bind(row.token_id, row.tx_hash, gas ? 'gas_rejected' : 'failed', Date.now()).run();
  if (code === 'owner_changed') {
    const link = await linkForToken(env.DB, row.token_id);
    if (link !== null) await invalidateMovedLink(env.DB, link);
  }
  const balance = gas ? await walletBalance(env, row.sender) : 0n;
  return answer(gas ? 'gas_rejected' : 'failed', row.tx_hash,
    gas ? { missingYocto: (GIFT_RESERVE_YOCTO > balance ? GIFT_RESERVE_YOCTO - balance : 1n).toString() } : {});
}

/** A hash may be known while the sending request has lost its response. Any retry is the exact
 * signed transaction already recorded in D1, never a fresh nonce or changed receiver. */
export async function reconcile(env: Env, row: GiftFlight): Promise<Reply> {
  if (row.state === 'ok') return answer('ok', row.tx_hash);
  if (row.state === 'failed') return answer('failed', row.tx_hash);
  if (row.state === 'gas_rejected') {
    const balance = await walletBalance(env, row.sender);
    return answer('gas_rejected', row.tx_hash,
      { missingYocto: (GIFT_RESERVE_YOCTO > balance ? GIFT_RESERVE_YOCTO - balance : 1n).toString() });
  }
  const result: TxOutcome = await txStatus(env, row.tx_hash, row.sender);
  if (result?.status === 'ok') {
    let time: number | null = null;
    if (result.blockHash !== undefined) {
      try { time = await blockTime(env, result.blockHash); }
      catch (error) {
        if (!(error instanceof ChainUnreachable)) throw error;
      }
    }
    if (time === null) return answer('unknown', row.tx_hash);
    await finalise(env, row, time);
    return answer('ok', row.tx_hash);
  }
  if (result?.status === 'failed') return failed(env, row, result.code);
  let signed: SignedTransaction | null = null;
  try {
    const bytes = row.signed_bytes instanceof ArrayBuffer ? new Uint8Array(row.signed_bytes) : Uint8Array.from(row.signed_bytes);
    signed = decodeSignedTransaction(bytes);
    if (await txHashOf(signed) !== row.tx_hash || signed.transaction.signerId !== row.sender) signed = null;
  } catch { /* An older or corrupt flight cannot be resent; it still expires. */ }
  const pet = await petView(env, row.token_id);
  if (pet?.owner_id === row.receiver) {
    // Ownership can reach one RPC node before the transaction status reaches another.
    // The recipient page may show completion now, but D1's ownership boundary needs the
    // execution block time. Keep reconciling the hash until that timestamp is available.
    await env.DB.prepare("UPDATE gift_flights SET state = 'unknown' WHERE token_id = ? AND tx_hash = ? AND state = 'sending'")
      .bind(row.token_id, row.tx_hash).run();
    return answer('unknown', row.tx_hash);
  }
  if (pet === null || pet.owner_id !== row.sender) return failed(env, row, 'owner_changed');
  const expired = signed === null
    ? Date.now() - row.created_at > 24 * 3_600_000
    : await transactionExpired(env, signed.transaction.blockHash, row.created_at);
  if (expired) return failed(env, row, 'expired');
  if (signed !== null) {
    const now = Date.now();
    const claimed = await env.DB.prepare(
      "UPDATE gift_flights SET rebroadcast_at = ?3 WHERE token_id = ?1 AND tx_hash = ?2 AND state IN ('prepared', 'sending', 'unknown') AND (rebroadcast_at IS NULL OR rebroadcast_at < ?4)",
    ).bind(row.token_id, row.tx_hash, now, now - 10_000).run();
    if (claimed.meta.changes === 1) {
      const resent = await sendSigned(env, signed);
      if (resent.status === 'failed') return failed(env, row, resent.code);
      if (resent.status === 'ok') return reconcile(env, row);
    }
  }
  await env.DB.prepare("UPDATE gift_flights SET state = 'unknown' WHERE token_id = ? AND tx_hash = ? AND state = 'sending'")
    .bind(row.token_id, row.tx_hash).run();
  return answer('unknown', row.tx_hash);
}

/** Public link reads and a new owner's create can settle a flight without the giver's tab. */
export async function reconcileGiftToken(env: Env, tokenId: string): Promise<Reply | null> {
  const row = await flightFor(env.DB, tokenId);
  return row === null ? null : reconcile(env, row);
}

export async function prepareGift(env: Env, session: Session, tokenId: string): Promise<Reply> {
  try {
    const pet = await petView(env, tokenId);
    if (pet === null) return { status: 404, body: { code: 'no_pet' } };
    if (pet.owner_id !== session.accountId) return { status: 409, body: { code: 'not_owner' } };
    const link = await linkForToken(env.DB, tokenId);
    if (!matchLink(link, session.accountId)) return conflict;
    const existing = await flightFor(env.DB, tokenId);
    if (existing !== null && existing.state !== 'failed' && existing.state !== 'gas_rejected') return reconcile(env, existing);
    const gas = await giftGas(env, session);
    if (gas.kind !== 'ready') return answer(gas.kind === 'short' ? 'no_near' : gas.kind, undefined,
      gas.kind === 'short' ? { missingYocto: gas.missingYocto } : {});
    const key = implicitKey(session.accountId);
    if (key === null) return unavailable;
    const nonce = await accessKeyNonce(env, session.accountId, key);
    if (nonce === null) return unavailable;
    const tx = createTransaction(session.accountId, key, env.CONTRACT_ID, nonce + 1n,
      [actions.functionCall('nft_transfer', { receiver_id: link.accepted_account, token_id: tokenId, approval_id: null, memo: null }, GIFT_TRANSFER_TGAS * GAS_UNIT, 1n)],
      await recentBlockHash(env));
    return answer('ready', undefined, { tx: toBase64(tx.encode()), receiver: link.accepted_account, acceptedName: link.accepted_name });
  } catch (e) {
    if (e instanceof ChainUnreachable) return unavailable;
    throw e;
  }
}

function checked(env: Env, session: Session, tokenId: string, receiver: string, tx: Transaction, bytes: Uint8Array, signature: Uint8Array): boolean {
  if (tx.signerId !== session.accountId || tx.receiverId !== env.CONTRACT_ID || tx.nonceIndex !== undefined || tx.nonceMode !== undefined) return false;
  if (tx.publicKey.toString() !== implicitKey(session.accountId)?.toString()) return false;
  if (tx.actions.length !== 1 || signature.length !== 64 || bytes.length === 0) return false;
  const call = tx.actions[0]?.functionCall;
  if (call?.methodName !== 'nft_transfer' || call.gas !== GIFT_TRANSFER_TGAS * GAS_UNIT || call.deposit !== 1n) return false;
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(new TextDecoder().decode(Uint8Array.from(call.args as ArrayLike<number>))) as Record<string, unknown>;
  } catch { return false; }
  return Object.keys(args).sort().join(',') === 'approval_id,memo,receiver_id,token_id'
    && args.receiver_id === receiver && args.token_id === tokenId && args.approval_id === null && args.memo === null;
}

export async function sendGift(env: Env, session: Session, tokenId: string, input: { tx?: unknown; signature?: unknown }): Promise<Reply> {
  if (typeof input.tx !== 'string' || typeof input.signature !== 'string' || input.tx.length > 2_800 || input.signature.length > 200) return bad;
  const bytes = fromBase64(input.tx);
  const signature = fromBase64(input.signature);
  if (bytes === null || signature === null) return bad;
  let tx: Transaction;
  try { tx = Transaction.decode(bytes); } catch { return bad; }
  if (toBase64(tx.encode()) !== input.tx) return bad;
  try {
    const link = await linkForToken(env.DB, tokenId);
    if (!matchLink(link, session.accountId)) return conflict;
    if (!checked(env, session, tokenId, link.accepted_account!, tx, bytes, signature)) return bad;
    if (!tx.publicKey.verify(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), signature)) return bad;
    const signed = new SignedTransaction({ transaction: tx, signature: new Signature({ keyType: KeyType.ED25519, data: signature }) });
    const hash = await txHashOf(signed);
    const existing = await flightFor(env.DB, tokenId);
    if (existing !== null && existing.state !== 'failed' && existing.state !== 'gas_rejected') return existing.tx_hash === hash ? reconcile(env, existing) : { status: 409, body: { code: 'pending' } };
    const pet = await petView(env, tokenId);
    if (pet?.owner_id !== session.accountId) return conflict;
    const encoded = signed.encode();
    const inserted = await env.DB.prepare(
      `INSERT INTO gift_flights (token_id, code, sender, receiver, tx_hash, signed_bytes, state, created_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, 'prepared', ?7 WHERE EXISTS
         (SELECT 1 FROM gift_links WHERE token_id = ?1 AND code = ?2 AND status = 'accepted' AND accepted_account = ?4)
       ON CONFLICT(token_id) DO UPDATE SET code = excluded.code, sender = excluded.sender,
         receiver = excluded.receiver, tx_hash = excluded.tx_hash, signed_bytes = excluded.signed_bytes,
         state = 'prepared', created_at = excluded.created_at, resolved_at = NULL, rebroadcast_at = NULL
       WHERE gift_flights.state IN ('failed', 'gas_rejected') RETURNING *`,
    ).bind(tokenId, link.code, session.accountId, link.accepted_account, hash, encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength), Date.now()).first<GiftFlight>();
    if (inserted === null) return { status: 409, body: { code: 'pending' } };
    const claimed = await env.DB.prepare("UPDATE gift_flights SET state = 'sending' WHERE token_id = ? AND tx_hash = ? AND state = 'prepared'")
      .bind(tokenId, hash).run();
    if (claimed.meta.changes !== 1) return { status: 409, body: { code: 'pending' } };
    const sent = await sendSigned(env, signed);
    if (sent.status === 'failed') return failed(env, inserted, sent.code);
    if (sent.status === 'ok') return reconcile(env, (await flightFor(env.DB, tokenId))!);
    await env.DB.prepare("UPDATE gift_flights SET state = 'unknown' WHERE token_id = ? AND tx_hash = ? AND state = 'sending'").bind(tokenId, hash).run();
    return answer('unknown', hash);
  } catch (e) {
    if (e instanceof ChainUnreachable) return unavailable;
    throw e;
  }
}

export async function giftOutcome(env: Env, session: Session, tokenId: string): Promise<Reply> {
  try {
    const row = await flightFor(env.DB, tokenId);
    if (row === null) return conflict;
    if (session.accountId !== row.sender && session.accountId !== row.receiver) return { status: 403, body: { code: 'not_owner' } };
    return reconcile(env, row);
  } catch (e) {
    if (e instanceof ChainUnreachable) return unavailable;
    throw e;
  }
}
