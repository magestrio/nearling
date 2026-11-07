// `POST /api/pets/:id/memory/clear`: the owner erases the pet's memory (Memory deletion data). The
// owner is read from the contract on this request, without a cache (`ownedPet`); the erasing is one
// D1 batch, whole or nothing. It spends nothing and writes nothing to the network, so a sleeping pet
// and a pause of the services do not stop it.
import { Hono } from 'hono';
import type { AppEnv } from '../http';
import { forgetStatements } from '../pet/forget';
import { sharedForToken } from '../errands/shared';
import { closeSharedJob, recoverSharedClose, recoveryStatement, validCloseApproval } from '../errands/sharedClose';
import { debitSharedNow } from '../debit';
import { finishPaidShared } from '../errands/sharedSettle';
import { ownedPet, settleLater } from './thoughts';
import { processWishRelease, requestWishRelease } from '../will/purchase';
import { petView, ChainUnreachable } from '../chain';

export const memoryRoutes = new Hono<AppEnv>();

memoryRoutes.post('/api/pets/:id/memory/clear', async (c) => {
  const owned = await ownedPet(c);
  if (owned instanceof Response) return owned;
  const row = await sharedForToken(c.env.DB, owned.id);
  const shared = owned.pet.shared_job;
  if (shared != null && await c.env.DB.prepare('SELECT 1 AS found FROM shared_job_close_recovery WHERE token_id = ? AND job_hash = ?')
    .bind(owned.id, shared.hash).first() !== null) return c.json({ code: 'close_retry' }, 202);
  if (shared != null && row?.job_hash !== shared.hash) return c.json({ code: 'close_unknown' }, 503);
  let approval: Awaited<ReturnType<typeof validCloseApproval>> = null;
  let running = false;
  if (row !== null && shared?.hash === row.job_hash) {
    if (shared.state !== 'Settled') {
      const body = await c.req.json<{ approval?: unknown }>().catch(() => null);
      approval = await validCloseApproval(c.env, owned.id, row.job_hash, owned.pet.owner_id, body?.approval);
      if (approval === null) return c.json({ code: 'close_refused' }, 400);
    }
    const unpaid = await c.env.DB.prepare("SELECT 1 AS found FROM thoughts WHERE token_id = ? AND shared_job_hash = ? AND status IN ('unbilled', 'billed') LIMIT 1")
      .bind(owned.id, row.job_hash).first();
    if (shared.state === 'Settled' && unpaid !== null) {
      try {
        await debitSharedNow(c.env, owned.id, row.job_hash);
        if (!await finishPaidShared(c.env, owned.id, row.job_hash)) return c.json({ code: 'close_unknown' }, 503);
      } catch { return c.json({ code: 'close_unknown' }, 503); }
    }
    running = shared.state !== 'Settled' && (row.state === 'running' || unpaid !== null || shared.state === 'Running' || shared.state === 'Transferred');
    if (!running) {
      const outcome = await closeSharedJob(c.env, owned.id, row.job_hash, approval);
      if (outcome !== 'confirmed') return c.json({ code: outcome === 'refused' ? 'close_refused' : 'close_unknown' }, outcome === 'refused' ? 409 : 503);
    }
  }
  if (row !== null) {
    const stillOwned = await ownedPet(c);
    if (stillOwned instanceof Response) return stillOwned;
    if (stillOwned.pet.transfer_generation !== owned.pet.transfer_generation) return c.json({ code: 'not_owner' }, 403);
  }
  // spec: add-pet-will › Will memory clear flow › release fails
  // spec: add-pet-will › Will memory clear flow › deletion fails after release
  try {
    if (owned.pet.wish_active || BigInt(owned.pet.wish_reserve ?? '0') > 0n) {
      await requestWishRelease(c.env, owned.id, 'clear');
      await processWishRelease(c.env, owned.id);
    }
    const fresh = await petView(c.env, owned.id);
    if (fresh === null || fresh.owner_id !== c.get('session')?.accountId ||
      BigInt(fresh.wish_reserve ?? '0') > 0n || fresh.wish_active) return c.json({ code: 'clear_failed' }, 503);
  } catch (error) {
    if (error instanceof ChainUnreachable) return c.json({ code: 'chain_unreachable' }, 503);
    return c.json({ code: 'clear_failed' }, 503);
  }
  try {
    await c.env.DB.batch([
      ...(running && row !== null && approval !== null ? [recoveryStatement(c.env.DB, owned.id, row.job_hash, approval)] : []),
      ...forgetStatements(c.env.DB, owned.id, Date.now()),
    ]);
  } catch {
    // The batch is one transaction: nothing was erased.
    console.log('clear_failed');
    return c.json({ code: 'clear_failed' }, 500);
  }
  console.log('memory_cleared');
  // An entry erased with its question leaves nothing to answer: the day's ritual may have ended with it
  // (`Ritual data` › «удаление памяти»); the settle runs after the response.
  settleLater(c, owned.id);
  if (running && row !== null && approval !== null) {
    const outcome = await recoverSharedClose(c.env, {
      token_id: owned.id, job_hash: row.job_hash,
      approval: new TextEncoder().encode(JSON.stringify(approval)), close_state: 'pending',
    }).catch(() => 'unknown' as const);
    if (outcome !== 'confirmed') return c.json({ code: 'close_retry' }, 202);
  }
  return c.json({ ok: true });
});
