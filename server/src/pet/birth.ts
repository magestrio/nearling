// The durable outcome of one server-signed birth, shared by Hatch and the send journal's cron.
import { decodeSignedTransaction } from 'near-api-js';
import { ChainUnreachable, finalBirthStatus, hatchView, sendSigned, transactionExpired, type HatchRecord } from '../chain';
import { desk } from './desk';
import { publicPetId } from './publicIds';
import { BIRTH_STORAGE_YOCTO, nearUsdRate, REPEAT_BIRTH_STORAGE_YOCTO, STARTER_FOOD_YOCTO, yoctoToUsdMicros } from '../pricing';
import { track } from '../track';
import { opaquePlayerId, recordHatchEvent } from '../hatch/events';

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
  prior_token_id: string | null;
  birth_rate_usd_micros: number | null;
}

export async function finishBirth(env: Env, account: string, tokenId: string, txHash: string, burnt: string, priorToken: string | null, rateMicros?: number | null): Promise<void> {
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
  const rate = rateMicros === undefined || rateMicros === null ? nearUsdRate(env.NEAR_USD_RATE) : rateMicros / 1_000_000;
  if (rate === null) throw new ChainUnreachable('rate_missing');
  for (const [kind, yocto] of [
      ['starter_food', STARTER_FOOD_YOCTO],
      ['storage', priorToken === null ? BIRTH_STORAGE_YOCTO : REPEAT_BIRTH_STORAGE_YOCTO],
      ['gas', BigInt(burnt)],
    ] as const) {
      statements.push(env.DB.prepare('INSERT OR IGNORE INTO project_spend (at, kind, usd_micros, birth_token_id) VALUES (?, ?, ?, ?)')
        .bind(at, kind, yoctoToUsdMicros(yocto, rate), tokenId));
  }
  const jobId = crypto.randomUUID().replaceAll('-', '');
  statements.push(env.DB.prepare(
    "INSERT INTO jobs (id, token_id, kind, mode, payload, status, created_at, owner_account) SELECT ?1, ?2, 'greeting', NULL, '{}', 'queued', ?3, NULL WHERE NOT EXISTS (SELECT 1 FROM jobs WHERE token_id = ?2 AND kind = 'greeting')",
  ).bind(jobId, tokenId, at));
  const results = await env.DB.batch(statements);
  const petId = await publicPetId(env.DB, tokenId);
  const player = await env.DB.prepare('SELECT sub FROM players WHERE account_id = ?').bind(account).first<{ sub: string }>();
  await recordHatchEvent(env, { name: 'pet_born', petId, repeat: priorToken !== null,
    playerId: player === null ? null : await opaquePlayerId(player.sub) });
  if (results[0]?.meta.changes === 1) {
    track('pet_born', { pet: petId, repeat: priorToken !== null });
  }
  await desk(env, tokenId).arm(tokenId);
  // Keep the journal row as the cron's retry trigger until every part of finalization,
  // including the greeting alarm, has completed.
  if (txHash !== '') await env.DB.prepare("DELETE FROM item_sends WHERE token_id = ? AND kind = 'birth' AND item = 'birth'")
    .bind(account).run();
}

/** A flight's result. History never settles a signed hash; only its FINAL outcome does.
 * An unseen, expired hash is released only after a fresh read still shows the prior pointer. */
export async function birthFlight(env: Env, account: string, _hatch: HatchRecord, now = Date.now()): Promise<'none' | 'pending' | 'failed' | { status: 'born'; tokenId: string }> {
  const row = await env.DB.prepare('SELECT started_at, tx_hash, signed_bytes, rebroadcast_at, failed, prior_token_id, birth_rate_usd_micros FROM births_in_flight WHERE account = ?')
    .bind(account).first<BirthFlight>();
  if (row === null) return 'none';
  if (row.failed === 1) return 'failed';
  if (row.tx_hash === null) {
    if (now - row.started_at < UNSIGNED_STALE_MS) return 'pending';
    await env.DB.prepare('DELETE FROM births_in_flight WHERE account = ? AND started_at = ? AND tx_hash IS NULL')
      .bind(account, row.started_at).run();
    return 'failed';
  }

  const status = await finalBirthStatus(env, row.tx_hash, env.SERVER_ACCOUNT_ID, account);
  if (status?.status === 'ok') {
    if (status.value === null || status.value === row.prior_token_id) return 'pending';
    await finishBirth(env, account, status.value, row.tx_hash, status.burnt ?? '0', row.prior_token_id, row.birth_rate_usd_micros);
    await env.DB.prepare('DELETE FROM births_in_flight WHERE account = ? AND started_at = ? AND tx_hash = ?')
      .bind(account, row.started_at, row.tx_hash).run();
    return { status: 'born', tokenId: status.value };
  }
  if (status?.status === 'failed') {
    await markFailed(env, account, row, status.burnt);
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
    const latest = await finalBirthStatus(env, row.tx_hash, env.SERVER_ACCOUNT_ID, account);
    const fresh = await hatchView(env, account);
    if (latest?.status === 'ok') {
      if (latest.value === null || latest.value === row.prior_token_id) return 'pending';
      await finishBirth(env, account, latest.value, row.tx_hash, latest.burnt ?? '0', row.prior_token_id, row.birth_rate_usd_micros);
      await env.DB.prepare('DELETE FROM births_in_flight WHERE account = ? AND started_at = ? AND tx_hash = ?')
        .bind(account, row.started_at, row.tx_hash).run();
      return { status: 'born', tokenId: latest.value };
    }
    if (latest?.status === 'pending') return 'pending';
    if (fresh.token_id !== row.prior_token_id) return 'pending';
    await markFailed(env, account, row, latest?.status === 'failed' ? latest.burnt : undefined);
    return 'failed';
  }
  if (signed !== null && now - (row.rebroadcast_at ?? row.started_at) >= REBROADCAST_MS) {
    const claimed = await env.DB.prepare('UPDATE births_in_flight SET rebroadcast_at = ? WHERE account = ? AND started_at = ? AND tx_hash = ? AND failed = 0 AND (rebroadcast_at IS NULL OR rebroadcast_at <= ?)')
      .bind(now, account, row.started_at, row.tx_hash, now - REBROADCAST_MS).run();
    if (claimed.meta.changes === 1) {
      // A rebroadcast answer is not terminal evidence. The original FINAL status settles it.
      await sendSigned(env, signed);
      return birthFlight(env, account, _hatch, now);
    }
  }
  return 'pending';
}

async function markFailed(env: Env, account: string, row: BirthFlight, burnt?: string): Promise<void> {
  await releaseFailedBirth(env, account, row.started_at, row.tx_hash, burnt, row.birth_rate_usd_micros);
}

export async function releaseFailedBirth(env: Env, account: string, startedAt: number, txHash: string | null, burnt?: string, rateMicros?: number | null): Promise<void> {
  const statements = [];
  if (txHash !== null && burnt !== undefined) {
    const rate = rateMicros === undefined || rateMicros === null ? nearUsdRate(env.NEAR_USD_RATE) : rateMicros / 1_000_000;
    if (rate === null) throw new ChainUnreachable('rate_missing');
    statements.push(env.DB.prepare("INSERT OR IGNORE INTO project_spend (at, kind, usd_micros, birth_tx_hash) VALUES (?, 'gas', ?, ?)")
      .bind(Date.now(), yoctoToUsdMicros(BigInt(burnt), rate), txHash));
  }
  statements.push(
    env.DB.prepare('UPDATE births_in_flight SET failed = 1, reserved_usd_micros = 0 WHERE account = ? AND started_at = ? AND tx_hash = ?')
      .bind(account, startedAt, txHash),
    env.DB.prepare("DELETE FROM item_sends WHERE tx_hash = ? AND token_id = ? AND kind = 'birth' AND item = 'birth'")
      .bind(txHash, account),
  );
  await env.DB.batch(statements);
}
