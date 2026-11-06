import { ChainUnreachable, petView } from '../chain';
import { debitSharedNow } from '../debit';
import { finishPaidShared } from './sharedSettle';

export interface CloseApproval { public_key: string; signature: string }
export type CloseOutcome = 'confirmed' | 'refused' | 'unknown';
type Recovery = { token_id: string; job_hash: string; approval: ArrayBuffer | Uint8Array | number[] | string; close_state: string };

const CLOSE_GAS = (15n * 1_000_000_000_000n).toString();
const bytes = (value: string) => Uint8Array.from(value.match(/../g) ?? [], (part) => Number.parseInt(part, 16));

/** Reject a malformed or another owner's approval before it can survive a memory clear. The contract
 * independently verifies the same digest and current owner when it releases the reserve. */
export async function validCloseApproval(env: Env, tokenId: string, jobHash: string, owner: string, value: unknown): Promise<CloseApproval | null> {
  if (typeof value !== 'object' || value === null) return null;
  const approval = value as Record<string, unknown>;
  if (typeof approval.public_key !== 'string' || typeof approval.signature !== 'string' ||
    !/^[0-9a-f]{64}$/.test(approval.public_key) || !/^[0-9a-f]{128}$/.test(approval.signature) || approval.public_key !== owner) return null;
  const message = `nearling:shared-job-close:v1:${env.CONTRACT_ID}:${tokenId}:${jobHash}:close`;
  try {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(message)));
    const key = await crypto.subtle.importKey('raw', bytes(approval.public_key), 'Ed25519', false, ['verify']);
    if (!await crypto.subtle.verify('Ed25519', key, bytes(approval.signature), digest)) return null;
  } catch { return null; }
  return { public_key: approval.public_key, signature: approval.signature };
}

/** A chain read resolves a lost response; an unknown outcome never licenses a D1 erasure. */
export async function closeSharedJob(env: Env, tokenId: string, jobHash: string, approval: CloseApproval | null): Promise<CloseOutcome> {
  try {
    const before = await petView(env, tokenId);
    if (before?.shared_job?.hash !== jobHash) return 'confirmed';
    const sent = await env.SERVER_KEY.get(env.SERVER_KEY.idFromName('server')).send({
      methodName: 'shared_job_close', args: { token_id: tokenId, job_hash: jobHash, owner_approval: approval }, gas: CLOSE_GAS,
    });
    if (sent.status === 'ok') return 'confirmed';
    const after = await petView(env, tokenId);
    if (after?.shared_job?.hash !== jobHash) return 'confirmed';
    return sent.status === 'failed' ? 'refused' : 'unknown';
  } catch (error) {
    if (error instanceof ChainUnreachable) return 'unknown';
    throw error;
  }
}

export function recoveryStatement(db: D1Database, tokenId: string, jobHash: string, approval: CloseApproval): D1PreparedStatement {
  const data = new TextEncoder().encode(JSON.stringify(approval));
  return db.prepare("INSERT INTO shared_job_close_recovery (token_id, job_hash, approval, close_state) VALUES (?, ?, ?, 'pending') ON CONFLICT (token_id, job_hash) DO UPDATE SET approval = excluded.approval, close_state = 'pending'")
    .bind(tokenId, jobHash, data.buffer);
}

/** A recovered row contains no job words or link code. The old signature is unusable after a gift. */
export async function recoverSharedClose(env: Env, row: Recovery): Promise<CloseOutcome> {
  const pet = await petView(env, row.token_id);
  if (pet?.shared_job?.hash !== row.job_hash) {
    await env.DB.prepare('DELETE FROM shared_job_close_recovery WHERE token_id = ? AND job_hash = ?').bind(row.token_id, row.job_hash).run();
    return 'confirmed';
  }
  const raw = row.approval instanceof ArrayBuffer ? new Uint8Array(row.approval)
    : typeof row.approval === 'string' ? new TextEncoder().encode(row.approval) : Uint8Array.from(row.approval);
  let approval: CloseApproval;
  try { approval = JSON.parse(new TextDecoder().decode(raw)) as CloseApproval; }
  catch { return 'refused'; }
  if (approval.public_key !== pet.owner_id) return 'refused';
  const away = await env.DB.prepare("SELECT 1 AS found FROM errands WHERE token_id = ? AND shared_job_hash = ? AND state = 'away' LIMIT 1")
    .bind(row.token_id, row.job_hash).first();
  if (away !== null) return 'unknown';
  let paid = await env.DB.prepare("SELECT status FROM thoughts WHERE token_id = ? AND shared_job_hash = ? AND price_yocto != '0' ORDER BY created_at DESC LIMIT 1")
    .bind(row.token_id, row.job_hash).first<{ status: string }>();
  if (paid?.status === 'unbilled') {
    await debitSharedNow(env, row.token_id, row.job_hash);
    paid = await env.DB.prepare("SELECT status FROM thoughts WHERE token_id = ? AND shared_job_hash = ? AND price_yocto != '0' ORDER BY created_at DESC LIMIT 1")
      .bind(row.token_id, row.job_hash).first<{ status: string }>();
    if (paid?.status === 'unbilled') return 'unknown';
  }
  if (paid?.status === 'billed') await finishPaidShared(env, row.token_id, row.job_hash);
  const outcome = await closeSharedJob(env, row.token_id, row.job_hash, pet.shared_job.state === 'Settled' ? null : approval);
  if (outcome === 'confirmed') await env.DB.prepare('DELETE FROM shared_job_close_recovery WHERE token_id = ? AND job_hash = ?').bind(row.token_id, row.job_hash).run();
  else await env.DB.prepare("UPDATE shared_job_close_recovery SET close_state = 'unknown', attempts = attempts + 1, retry_at = ? WHERE token_id = ? AND job_hash = ?")
    .bind(Date.now(), row.token_id, row.job_hash).run();
  return outcome;
}

export async function recoverDueSharedCloses(env: Env): Promise<void> {
  const rows = await env.DB.prepare('SELECT token_id, job_hash, approval, close_state FROM shared_job_close_recovery ORDER BY retry_at, token_id LIMIT 10').all<Recovery>();
  for (const row of rows.results) {
    try { await recoverSharedClose(env, row); }
    catch (error) { console.log(error instanceof ChainUnreachable ? 'shared_close_chain' : 'shared_close_failed'); }
  }
}
