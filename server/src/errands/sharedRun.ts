import { ChainUnreachable, petView } from '../chain';
import { memoryEpoch } from '../pet/forget';
import { energyLeft, readLife } from '../pet/life';
import { desk } from '../pet/desk';
import { foodState, isTired } from '../pet/view';
import { gasIsLow, isPaused } from '../servicePause';
import { utcDay } from '../http';
import { sendErrand } from './store';
import { eraseShared, linkIsCurrent, sharedForToken, type SharedErrandRow } from './shared';

const START_GAS = (5n * 1_000_000_000_000n).toString();

/** Funding is immutable after this chain transition. An interrupted enqueue is restored from Running. */
export async function startShared(env: Env, tokenId: string): Promise<'waiting' | 'paused' | 'started' | 'unavailable'> {
  const row = await sharedForToken(env.DB, tokenId);
  if (row === null || (row.state !== 'funding' && row.state !== 'running')) return 'unavailable';
  let pet = await petView(env, tokenId);
  if (pet === null) return 'unavailable';
  if (!linkIsCurrent(row, pet, await memoryEpoch(env.DB, tokenId))) {
    if (pet.shared_job?.hash !== row.job_hash) await eraseShared(env.DB, row);
    return 'unavailable';
  }
  const job = pet.shared_job!;
  if (job.state === 'Funding') {
    if (BigInt(job.linked_near) + BigInt(job.linked_snack) < BigInt(row.allowance_yocto)) return 'waiting';
    const state = await env.DB.prepare('SELECT slept_at FROM pets WHERE token_id = ?').bind(tokenId).first<{ slept_at: number | null }>();
    const now = Date.now();
    const food = await foodState(env.DB, tokenId, pet, now);
    if (state?.slept_at != null || BigInt(pet.project_food) + BigInt(pet.given_food) === 0n ||
      (await isPaused(env.DB, 'thought')) || (await gasIsLow(env, now)) ||
      energyLeft(await readLife(env.DB, tokenId), utcDay(now)) === 0 ||
      await isTired(env, tokenId, food, now) || food.capLeft < BigInt(row.allowance_yocto)) return 'paused';
    const sent = await env.SERVER_KEY.get(env.SERVER_KEY.idFromName('server')).send({
      methodName: 'shared_job_start', args: { token_id: tokenId, job_hash: row.job_hash }, gas: START_GAS,
    });
    if (sent.status === 'failed') return 'paused';
    if (sent.status !== 'ok') {
      pet = await petView(env, tokenId);
      if (pet?.shared_job?.hash !== row.job_hash || pet.shared_job.state !== 'Running') return 'waiting';
    }
  } else if (job.state !== 'Running') return 'unavailable';
  // Clear memory can commit while the start transaction is in flight. Its batch deletes the
  // public words and increments the epoch; never enqueue a stale copy after that boundary.
  const current = await sharedForToken(env.DB, tokenId);
  if (current === null || current.job_hash !== row.job_hash || current.memory_epoch !== await memoryEpoch(env.DB, tokenId)) return 'unavailable';
  // The queued errand and shared state move in one batch, so a lost response cannot queue twice.
  const made = await sendErrand(env.DB, { tokenId, owner: current.owner_account, form: current.form, job: current.job, now: Date.now(), sharedHash: current.job_hash });
  if (made !== null) await desk(env, tokenId).arm(tokenId);
  return 'started';
}

/** The cron retries funding that became ready after sleep, energy, cap or a service pause. */
export async function startReadyShared(env: Env): Promise<void> {
  const cursor = await env.DB.prepare('SELECT updated_at, token_id FROM shared_retry_cursor WHERE id = 1')
    .first<{ updated_at: number; token_id: string }>();
  const after = async (updatedAt: number, tokenId: string) => env.DB.prepare(`SELECT token_id, updated_at FROM shared_errands
    WHERE state IN ('funding', 'running') AND (updated_at > ? OR (updated_at = ? AND token_id > ?))
    ORDER BY updated_at, token_id LIMIT 10`).bind(updatedAt, updatedAt, tokenId)
    .all<Pick<SharedErrandRow, 'token_id' | 'updated_at'>>();
  let rows = await after(cursor?.updated_at ?? 0, cursor?.token_id ?? '');
  if (rows.results.length === 0) rows = await after(0, '');
  const last = rows.results.at(-1);
  if (last !== undefined) await env.DB.prepare('UPDATE shared_retry_cursor SET updated_at = ?, token_id = ? WHERE id = 1')
    .bind(last.updated_at, last.token_id).run();
  for (const row of rows.results) {
    try { await startShared(env, row.token_id); }
    catch (error) { console.log(error instanceof ChainUnreachable ? 'shared_start_chain' : 'shared_start_failed'); }
  }
}
