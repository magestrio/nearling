// The durable outcome of one server-signed birth, shared by Hatch and the send journal's cron.
import { decodeSignedTransaction } from 'near-api-js';
import { hatchView, sendSigned, transactionExpired, txStatus, type HatchRecord } from '../chain';
import { desk } from './desk';
import { publicPetId } from './publicIds';
import { BIRTH_STORAGE_YOCTO, nearUsdRate, STARTER_FOOD_YOCTO, yoctoToUsdMicros } from '../pricing';
import { track } from '../track';

const UNSIGNED_STALE_MS = 60_000;
const REBROADCAST_MS = 60_000;
// A legacy flight signed before signed_bytes was added cannot reveal its reference block. Two
// days after its send, a fresh chain read is required before calling the unseen hash expired.
const LEGACY_EXPIRY_MS = 48 * 3_600_000;

export interface BirthFlight {
  started_at: number;
  tx_hash: string | null;
  signed_bytes: ArrayBuffer | null;
  rebroadcast_at: number | null;
  failed: number;
}

export async function finishBirth(env: Env, account: string, tokenId: string, txHash: string): Promise<void> {
  const at = Date.now();
  const statements = [
    env.DB.prepare('INSERT OR IGNORE INTO pets (token_id, hatched_by, born_at, birth_tx) VALUES (?, ?, ?, ?)').bind(tokenId, account, at, txHash),
  ];
  if (txHash !== '') {
    statements.push(
      env.DB.prepare("UPDATE pets SET birth_tx = ? WHERE token_id = ? AND birth_tx = ''").bind(txHash, tokenId),
      env.DB.prepare("INSERT OR IGNORE INTO pet_transactions (token_id, kind, ref, tx_hash, at) VALUES (?, 'birth', 'birth', ?, ?)").bind(tokenId, txHash, at),
    );
  }
  const rate = nearUsdRate(env.NEAR_USD_RATE);
  if (rate === null) {
    console.log('rate_missing');
  } else {
    for (const [kind, yocto] of [['starter_food', STARTER_FOOD_YOCTO], ['storage', BIRTH_STORAGE_YOCTO]] as const) {
      statements.push(env.DB.prepare('INSERT OR IGNORE INTO project_spend (at, kind, usd_micros, birth_account) VALUES (?, ?, ?, ?)')
        .bind(at, kind, yoctoToUsdMicros(yocto, rate), account));
    }
  }
  const jobId = crypto.randomUUID().replaceAll('-', '');
  statements.push(env.DB.prepare(
    "INSERT INTO jobs (id, token_id, kind, mode, payload, status, created_at, owner_account) SELECT ?1, ?2, 'greeting', NULL, '{}', 'queued', ?3, NULL WHERE NOT EXISTS (SELECT 1 FROM jobs WHERE token_id = ?2 AND kind = 'greeting')",
  ).bind(jobId, tokenId, at));
  const results = await env.DB.batch(statements);
  await publicPetId(env.DB, tokenId);
  if (results.at(-1)?.meta.changes === 1) track('pet_born');
  await desk(env, tokenId).arm(tokenId);
  // Keep the journal row as the cron's retry trigger until every part of finalization,
  // including the greeting alarm, has completed.
  if (txHash !== '') await env.DB.prepare("DELETE FROM item_sends WHERE token_id = ? AND kind = 'birth' AND item = 'birth'")
    .bind(account).run();
}

/** A flight's result. A signed hash remains pending until its original outcome or an expired,
 * unseen hash with a fresh contract read proves there is no pet. */
export async function birthFlight(env: Env, account: string, hatch: HatchRecord, now = Date.now()): Promise<'none' | 'pending' | 'failed' | 'born'> {
  const row = await env.DB.prepare('SELECT started_at, tx_hash, signed_bytes, rebroadcast_at, failed FROM births_in_flight WHERE account = ?')
    .bind(account).first<BirthFlight>();
  if (row === null) return 'none';
  if (hatch.token_id !== null) {
    await finishBirth(env, account, hatch.token_id, row.tx_hash ?? '');
    await env.DB.prepare('DELETE FROM births_in_flight WHERE account = ? AND started_at = ?').bind(account, row.started_at).run();
    return 'born';
  }
  if (row.failed === 1) return 'failed';
  if (row.tx_hash === null) {
    if (now - row.started_at < UNSIGNED_STALE_MS) return 'pending';
    await env.DB.prepare('DELETE FROM births_in_flight WHERE account = ? AND started_at = ? AND tx_hash IS NULL')
      .bind(account, row.started_at).run();
    return 'failed';
  }

  const status = await txStatus(env, row.tx_hash, env.SERVER_ACCOUNT_ID);
  if (status?.status === 'ok') {
    const tokenId = status.value ?? (await hatchView(env, account)).token_id;
    if (tokenId === null) return 'pending';
    await finishBirth(env, account, tokenId, row.tx_hash);
    // The status endpoint can be ahead of the view endpoint. Keep the flight while the
    // owner view is behind, so a later POST cannot claim a second birth.
    if ((await hatchView(env, account)).token_id === null) return 'pending';
    await env.DB.prepare('DELETE FROM births_in_flight WHERE account = ? AND started_at = ? AND tx_hash = ?')
      .bind(account, row.started_at, row.tx_hash).run();
    return 'born';
  }
  if (status?.status === 'failed') {
    const fresh = await hatchView(env, account);
    if (fresh.token_id !== null) return birthFlight(env, account, fresh, now);
    await markFailed(env, account, row);
    return 'failed';
  }
  if (status?.status === 'pending') return 'pending';

  const signed = row.signed_bytes === null ? null : decodeSignedTransaction(new Uint8Array(row.signed_bytes));
  const expired = signed === null
    ? now - row.started_at >= LEGACY_EXPIRY_MS
    : await transactionExpired(env, signed.transaction.blockHash, row.started_at);
  if (expired) {
    // A fresh status and contract read after the expiry check protect against an RPC node
    // that briefly could not see a transaction which actually landed.
    const latest = await txStatus(env, row.tx_hash, env.SERVER_ACCOUNT_ID);
    const fresh = await hatchView(env, account);
    if (fresh.token_id !== null) return birthFlight(env, account, fresh, now);
    if (latest?.status === 'ok') {
      if (latest.value === null) return 'pending';
      await finishBirth(env, account, latest.value, row.tx_hash);
      if ((await hatchView(env, account)).token_id === null) return 'pending';
      await env.DB.prepare('DELETE FROM births_in_flight WHERE account = ? AND started_at = ? AND tx_hash = ?')
        .bind(account, row.started_at, row.tx_hash).run();
      return 'born';
    }
    if (latest?.status === 'pending') return 'pending';
    await markFailed(env, account, row);
    return 'failed';
  }
  if (signed !== null && now - (row.rebroadcast_at ?? row.started_at) >= REBROADCAST_MS) {
    const claimed = await env.DB.prepare('UPDATE births_in_flight SET rebroadcast_at = ? WHERE account = ? AND started_at = ? AND tx_hash = ? AND failed = 0 AND (rebroadcast_at IS NULL OR rebroadcast_at <= ?)')
      .bind(now, account, row.started_at, row.tx_hash, now - REBROADCAST_MS).run();
    if (claimed.meta.changes === 1) {
      // sendSigned uses the saved signature. Its immediate refusal is not a terminal birth
      // result: a hash/status or expiry plus fresh hatch_view settles the flight.
      const resent = await sendSigned(env, signed);
      if (resent.status === 'ok') {
        const tokenId = resent.value ?? (await hatchView(env, account)).token_id;
        if (tokenId !== null) {
          await finishBirth(env, account, tokenId, row.tx_hash);
          if ((await hatchView(env, account)).token_id === null) return 'pending';
          await env.DB.prepare('DELETE FROM births_in_flight WHERE account = ? AND started_at = ? AND tx_hash = ?')
            .bind(account, row.started_at, row.tx_hash).run();
          return 'born';
        }
      }
    }
  }
  return 'pending';
}

async function markFailed(env: Env, account: string, row: BirthFlight): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('UPDATE births_in_flight SET failed = 1 WHERE account = ? AND started_at = ? AND tx_hash = ?')
      .bind(account, row.started_at, row.tx_hash),
    env.DB.prepare('DELETE FROM item_sends WHERE tx_hash = ?').bind(row.tx_hash),
  ]);
}
