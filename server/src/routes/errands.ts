// The owner's errand: the quote the sheet shows before «Send» and the send itself (`Errand sheet screen`,
// `Errand flow`). Both read the owner from the contract with no cache (`Errand access data`); the errand then
// runs on the pet's desk (`errands/run.ts`) with the tab open or closed.
import { Hono } from 'hono';
import { decodeSignedTransaction } from 'near-api-js';
import { ChainUnreachable, petView, sendSigned, SHARED_JOB_OPEN_TGAS, transactionExpired, txHashOf, txStatus } from '../chain';
import { requireSession, TOKEN_ID, type AppEnv } from '../http';
import { hasVisible } from '../name/clean';
import { blocksOf } from '../errands/blocks';
import { FORMS, allowanceFor, fullRead, readCoefficients, searchQuote, typicalRead, upToFor, view, type ErrandForm } from '../errands/price';
import { codeForJob, eraseShared, hashCode, linkIsCurrent, randomJobHash, sharedForCode, sharedForToken, sharedUrl } from '../errands/shared';
import { closeSharedJob, recoverSharedClose, recoveryStatement, validCloseApproval } from '../errands/sharedClose';
import { askNetwork } from '../feeding/inflight';
import { FEEDINGS_COLUMNS, type FeedingRow } from '../pet/settle';
import { readErrand, sendErrand } from '../errands/store';
import { memoryEpoch } from '../pet/forget';
import { fullnessOf } from '../pet/view';
import { track } from '../track';
import { ownedPet, run } from './thoughts';

export const errandRoutes = new Hono<AppEnv>();

/** The job's limits in code points: a link or text to read, or a question or claim (`Errand sheet screen`). */
export const MAX_READ_CODE_POINTS = 30_000;
export const MAX_SEARCH_CODE_POINTS = 500;

const formOf = (raw: unknown): ErrandForm | null => (typeof raw === 'string' && (FORMS as readonly string[]).includes(raw) ? (raw as ErrandForm) : null);

errandRoutes.get('/api/pets/:id/errand', async (c) => {
  const owned = await ownedPet(c);
  if (owned instanceof Response) return owned;
  const form = formOf(c.req.query('form') ?? 'read');
  if (form === null) return c.json({ code: 'bad_request' }, 400);
  const session = requireSession(c);
  if (session instanceof Response) return session;
  // A failed errand of an earlier owner goes with the gift; this read is where the server sees it.
  await readErrand(c.env.DB, owned.id, owned.pet.owner_id);

  const { block, food, hasData } = await blocksOf(c.env, owned.id, owned.pet, form, Date.now());
  const quote = searchQuote(c.env, food.room, hasData);
  const labels = await c.env.DB.prepare('SELECT label FROM data_sources WHERE token_id = ? ORDER BY created_at, rowid').bind(owned.id).all<{ label: string }>();
  return c.json({
    form,
    paused: block?.reason === 'paused',
    read: { typical: view(typicalRead(c.env)), ...readCoefficients(c.env) },
    search: { upTo: view(quote.upTo), full: quote.full, short: !quote.full, searches: quote.searches, allowance: allowanceFor(c.env, hasData) },
    sharedNeeded: view(upToFor(c.env, 3)),
    block,
    labels: labels.results.map((r) => r.label),
  });
});

/** A prepared shared job has a chain hash before its URL can leave the server. */
errandRoutes.post('/api/pets/:id/shared-errands', async (c) => {
  const session = requireSession(c);
  if (session instanceof Response) return session;
  const body = await c.req.json<{ form?: unknown; job?: unknown }>().catch(() => null);
  if (body === null || (body.form !== 'find' && body.form !== 'check') || typeof body.job !== 'string'
    || !hasVisible(body.job) || [...body.job].length > MAX_SEARCH_CODE_POINTS) return c.json({ code: 'bad_request' }, 400);
  const owned = await ownedPet(c);
  if (owned instanceof Response) return owned;
  const { id, pet } = owned;
  const epoch = await memoryEpoch(c.env.DB, id);
  let existing = await sharedForToken(c.env.DB, id);
  if (existing !== null && existing.receipt_id !== null && pet.shared_job == null) {
    await eraseShared(c.env.DB, existing);
    existing = null;
  }
  if (existing !== null && (existing.owner_account !== pet.owner_id || existing.owner_generation !== pet.transfer_generation || existing.memory_epoch !== epoch)) {
    await eraseShared(c.env.DB, existing);
    existing = null;
  }
  if (existing !== null && linkIsCurrent(existing, pet, epoch)) {
    if (existing.state === 'opening') await c.env.DB.prepare("UPDATE shared_errands SET state = 'funding', open_signed_bytes = NULL WHERE token_id = ? AND job_hash = ? AND state = 'opening'").bind(id, existing.job_hash).run();
    const code = await codeForJob(c.env, existing.job_hash);
    return existing.form === body.form && existing.job === body.job
      ? c.json({ url: sharedUrl(id, code), code, needed: view(upToFor(c.env, 3)), form: existing.form, job: existing.job }, 200)
      : c.json({ code: 'shared_job_active', url: sharedUrl(id, code) }, 409);
  }
  let retryOpening = false;
  if (existing !== null && (pet.shared_job === null || pet.shared_job === undefined)) {
    if (existing.state === 'opening' && existing.owner_account === pet.owner_id && existing.memory_epoch === epoch
      && existing.form === body.form && existing.job === body.job) {
      if (existing.open_tx_hash !== null) {
        let outcome;
        try { outcome = await txStatus(c.env, existing.open_tx_hash, c.env.SERVER_ACCOUNT_ID); }
        catch (error) {
          if (error instanceof ChainUnreachable) return c.json({ code: 'chain_unreachable' }, 503);
          throw error;
        }
        if (outcome?.status === 'failed') {
          await eraseShared(c.env.DB, existing);
          return c.json({ code: 'prepare_failed' }, 503);
        }
        if (outcome?.status === 'ok') return c.json({ code: 'preparing' }, 409);
        if (Date.now() - (existing.open_rebroadcast_at ?? existing.created_at) < 10_000) return c.json({ code: 'preparing' }, 409);
        let signed;
        try {
          if (existing.open_signed_bytes === null) throw new Error('missing_signed_bytes');
          const bytes = existing.open_signed_bytes instanceof ArrayBuffer ? new Uint8Array(existing.open_signed_bytes) : Uint8Array.from(existing.open_signed_bytes);
          signed = decodeSignedTransaction(bytes);
          if (await txHashOf(signed) !== existing.open_tx_hash || signed.transaction.signerId !== c.env.SERVER_ACCOUNT_ID) throw new Error('bad_signed_bytes');
        } catch {
          if (Date.now() - existing.created_at >= 48 * 3_600_000) {
            await eraseShared(c.env.DB, existing);
            return c.json({ code: 'prepare_failed' }, 503);
          }
          return c.json({ code: 'preparing' }, 409);
        }
        try {
          if (await transactionExpired(c.env, signed.transaction.blockHash, existing.created_at)) {
            await eraseShared(c.env.DB, existing);
            return c.json({ code: 'prepare_failed' }, 503);
          }
          const now = Date.now();
          const claimed = await c.env.DB.prepare("UPDATE shared_errands SET open_rebroadcast_at = ? WHERE token_id = ? AND job_hash = ? AND state = 'opening' AND (open_rebroadcast_at IS NULL OR open_rebroadcast_at < ?)")
            .bind(now, id, existing.job_hash, now - 10_000).run();
          if (claimed.meta.changes === 1) await sendSigned(c.env, signed);
        } catch (error) {
          if (error instanceof ChainUnreachable) return c.json({ code: 'chain_unreachable' }, 503);
          throw error;
        }
        return c.json({ code: 'preparing' }, 409);
      }
      retryOpening = true; // no hash was kept before broadcast, so nothing was sent
    } else if (existing.state === 'opening') {
      return c.json({ code: 'preparing' }, 409);
    } else {
      await eraseShared(c.env.DB, existing);
    }
  } else if (existing !== null) {
    await eraseShared(c.env.DB, existing);
    return c.json({ code: 'shared_job_active' }, 409);
  }
  if (pet.shared_job !== null && pet.shared_job !== undefined) return c.json({ code: 'shared_job_active' }, 409);

  const allowance = upToFor(c.env, 3);
  if (allowance.yocto <= 0n || allowance.yocto > 5_000_000_000_000_000_000_000n) return c.json({ code: 'price_unavailable' }, 503);
  const jobHash = retryOpening ? existing!.job_hash : randomJobHash();
  const code = await codeForJob(c.env, jobHash);
  if (!retryOpening) {
    const codeHash = await hashCode(code);
    const now = Date.now();
    const inserted = await c.env.DB.prepare(
      `INSERT INTO shared_errands (token_id, code_hash, job_hash, owner_account, owner_generation, memory_epoch, form, job, allowance_yocto, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'opening', ?, ?) ON CONFLICT (token_id) DO NOTHING`,
    ).bind(id, codeHash, jobHash, pet.owner_id, pet.transfer_generation, epoch, body.form, body.job, allowance.yocto.toString(), now, now).run();
    if (inserted.meta.changes !== 1) return c.json({ code: 'preparing' }, 409);
  }

  const answer = await c.env.SERVER_KEY.get(c.env.SERVER_KEY.idFromName('server')).send({
    methodName: 'shared_job_open',
    args: { token_id: id, job_hash: jobHash, allowance_yocto: allowance.yocto.toString() },
    gas: (SHARED_JOB_OPEN_TGAS * 1_000_000_000_000n).toString(),
    writes: { kind: 'shared_open', tokenId: id, jobHash },
  });
  if (answer.status === 'failed') {
    await c.env.DB.prepare('DELETE FROM shared_errands WHERE token_id = ? AND job_hash = ?').bind(id, jobHash).run();
    if (answer.code === 'shared_job_active') return c.json({ code: 'shared_job_active' }, 409);
    return c.json({ code: 'prepare_failed' }, 503);
  }
  if (answer.status === 'unreachable') return c.json({ code: 'chain_unreachable' }, 503);
  let confirmed;
  try { confirmed = await petView(c.env, id); }
  catch (error) {
    if (error instanceof ChainUnreachable) return c.json({ code: 'chain_unreachable' }, 503);
    throw error;
  }
  if (confirmed?.shared_job?.hash !== jobHash || confirmed.owner_id !== pet.owner_id) return c.json({ code: 'preparing' }, 503);
  await c.env.DB.prepare("UPDATE shared_errands SET state = 'funding', open_signed_bytes = NULL, updated_at = ? WHERE token_id = ? AND job_hash = ? AND state = 'opening'").bind(Date.now(), id, jobHash).run();
  return c.json({ url: sharedUrl(id, code), code, needed: view(allowance), form: body.form, job: body.job }, 201);
});

const SHARED_CODE = /^[0-9a-f]{64}$/;

/** Anyone with the code reads words and chain funding; only owner and confirmed contributors read the result. */
errandRoutes.get('/api/pets/:id/errand/:code', async (c) => {
  const id = c.req.param('id') ?? '';
  const code = c.req.param('code') ?? '';
  if (!TOKEN_ID.test(id) || !SHARED_CODE.test(code)) return c.json({ code: 'shared_unavailable' }, 404);
  const row = await sharedForCode(c.env.DB, id, await hashCode(code));
  let pet;
  try { pet = await petView(c.env, id); }
  catch (error) {
    if (error instanceof ChainUnreachable) return c.json({ code: 'chain_unreachable' }, 503);
    throw error;
  }
  if (pet === null) return c.json({ code: 'no_pet' }, 404);
  const base = { tokenId: id, name: pet.name };
  if (row === null) return c.json({ ...base, state: 'empty' });
  if (!linkIsCurrent(row, pet, await memoryEpoch(c.env.DB, id))) {
    await eraseShared(c.env.DB, row);
    return c.json({ ...base, state: 'empty' });
  }
  // A successful chain call whose D1 write was interrupted still has its in-flight row.
  // Settle it before progress and sponsor access; the event, not the request, proves the amount.
  const pending = await c.env.DB.prepare(`SELECT ${FEEDINGS_COLUMNS} FROM feedings WHERE token_id = ? AND job_hash = ? AND tx_hash IS NOT NULL`)
    .bind(id, row.job_hash).all<FeedingRow>();
  try { for (const feeding of pending.results) await askNetwork(c.env, feeding); }
  catch (error) {
    if (error instanceof ChainUnreachable) return c.json({ code: 'chain_unreachable' }, 503);
    throw error;
  }
  const chainRunning = pet.shared_job?.state !== 'Funding';
  const state = (row.state === 'opening' || row.state === 'funding') && chainRunning ? 'running'
    : row.state === 'opening' ? 'funding' : row.state;
  if (state !== row.state) {
    await c.env.DB.prepare('UPDATE shared_errands SET state = ?, open_signed_bytes = NULL, updated_at = ? WHERE token_id = ? AND job_hash = ? AND state = ?')
      .bind(state, Date.now(), id, row.job_hash, row.state).run();
  }
  const session = c.get('session');
  const owner = session?.accountId === pet.owner_id;
  const sponsor = !owner && session !== null && (await c.env.DB.prepare(
    'SELECT 1 AS found FROM shared_errand_contributions WHERE token_id = ? AND job_hash = ? AND contributor_account = ? LIMIT 1',
  ).bind(id, row.job_hash, session.accountId).first()) !== null;
  const privateRead = owner || sponsor;
  const contributions = await c.env.DB.prepare('SELECT amount_yocto FROM shared_errand_contributions WHERE token_id = ? AND job_hash = ?')
    .bind(id, row.job_hash).all<{ amount_yocto: string }>();
  const funded = pet.shared_job == null
    ? contributions.results.reduce((sum, item) => sum + BigInt(item.amount_yocto), 0n)
    : BigInt(pet.shared_job.linked_near) + BigInt(pet.shared_job.linked_snack);
  return c.json({
    ...base, form: row.form, job: row.job, state, viewer: owner ? 'owner' : sponsor ? 'sponsor' : session === null ? 'signed-out' : 'visitor',
    funded: funded.toString(), needed: row.allowance_yocto, chainState: pet.shared_job?.state ?? 'Closed',
    fullness: await fullnessOf(c.env.DB, id, pet),
    ...(privateRead ? { report: row.report, sources: row.sources === null ? null : JSON.parse(row.sources), receiptId: row.receipt_id } : {}),
  });
});

/** Browser events carry only the declared dimensions; a code or job never reaches the sink. */
errandRoutes.post('/api/pets/:id/errand/:code/events', async (c) => {
  const id = c.req.param('id') ?? '';
  const code = c.req.param('code') ?? '';
  if (!TOKEN_ID.test(id) || !SHARED_CODE.test(code)) return c.json({ code: 'shared_unavailable' }, 404);
  const body = await c.req.json<{ kind?: unknown; device?: unknown; inApp?: unknown }>().catch(() => null);
  if (body === null || (body.kind !== 'shared' && body.kind !== 'opened')) return c.json({ code: 'bad_request' }, 400);
  if (body.kind === 'opened' && ((body.device !== 'desktop' && body.device !== 'phone') || !['x', 'telegram', 'none'].includes(String(body.inApp)))) return c.json({ code: 'bad_request' }, 400);
  const row = await sharedForCode(c.env.DB, id, await hashCode(code));
  if (row === null) return c.json({ code: 'shared_unavailable' }, 404);
  let pet;
  try { pet = await petView(c.env, id); }
  catch (error) {
    if (error instanceof ChainUnreachable) return c.json({ code: 'chain_unreachable' }, 503);
    throw error;
  }
  if (pet === null || !linkIsCurrent(row, pet, await memoryEpoch(c.env.DB, id))) return c.json({ code: 'shared_unavailable' }, 404);
  if (body.kind === 'shared') {
    const session = requireSession(c);
    if (session instanceof Response) return session;
    if (session.accountId !== pet.owner_id) return c.json({ code: 'not_owner' }, 403);
    track('errand_link_shared', { form: row.form });
  } else {
    track('errand_link_opened', { device: body.device as 'desktop' | 'phone', in_app: body.inApp as 'x' | 'telegram' | 'none' });
  }
  return c.body(null, 204);
});

// spec: add-pet-errands › Friend-funded errand flow › owner confirms closing an unsettled job
// spec: add-pet-errands › Friend-funded errand flow › owner close fails
errandRoutes.post('/api/pets/:id/errand/:code/close', async (c) => {
  const owned = await ownedPet(c);
  if (owned instanceof Response) return owned;
  const code = c.req.param('code') ?? '';
  if (!SHARED_CODE.test(code)) return c.json({ code: 'shared_unavailable' }, 404);
  const row = await sharedForCode(c.env.DB, owned.id, await hashCode(code));
  if (row === null) return owned.pet.shared_job == null ? c.json({ ok: true }) : c.json({ code: 'shared_unavailable' }, 404);
  if (owned.pet.shared_job?.hash !== row.job_hash) {
    await eraseShared(c.env.DB, row);
    return c.json({ ok: true });
  }
  if (!linkIsCurrent(row, owned.pet, await memoryEpoch(c.env.DB, owned.id))) return c.json({ code: 'shared_unavailable' }, 404);
  if (row.state !== 'funding' && !(row.state === 'failed' && row.receipt_id === null)) return c.json({ code: 'shared_close_unavailable' }, 409);
  const inFlight = await c.env.DB.prepare("SELECT 1 AS found FROM thoughts WHERE token_id = ? AND shared_job_hash = ? AND status IN ('unbilled', 'billed') LIMIT 1")
    .bind(owned.id, row.job_hash).first();
  if (inFlight !== null) return c.json({ code: 'close_unknown' }, 409);
  const body = await c.req.json<{ approval?: unknown }>().catch(() => null);
  const approval = await validCloseApproval(c.env, owned.id, row.job_hash, owned.pet.owner_id, body?.approval);
  if (approval === null) return c.json({ code: 'close_refused' }, 400);
  const outcome = await closeSharedJob(c.env, owned.id, row.job_hash, approval);
  if (outcome === 'confirmed') {
    await eraseShared(c.env.DB, row);
    return c.json({ ok: true });
  }
  return c.json({ code: outcome === 'refused' ? 'close_refused' : 'close_unknown' }, outcome === 'refused' ? 409 : 503);
});

// spec: add-gift › Gift ownership data › cleared running job after transfer
errandRoutes.post('/api/pets/:id/shared-close', async (c) => {
  const owned = await ownedPet(c);
  if (owned instanceof Response) return owned;
  const job = owned.pet.shared_job;
  if (job == null) return c.json({ code: 'no_shared_job' }, 404);
  const recovery = await c.env.DB.prepare('SELECT token_id, job_hash, approval, close_state FROM shared_job_close_recovery WHERE token_id = ? AND job_hash = ?')
    .bind(owned.id, job.hash).first<{ token_id: string; job_hash: string; approval: ArrayBuffer | number[] | string; close_state: string }>();
  if (recovery === null) return c.json({ code: 'shared_close_unavailable' }, 409);
  const body = await c.req.json<{ approval?: unknown }>().catch(() => null);
  const approval = await validCloseApproval(c.env, owned.id, job.hash, owned.pet.owner_id, body?.approval);
  if (approval === null) return c.json({ code: 'close_refused' }, 400);
  await c.env.DB.batch([recoveryStatement(c.env.DB, owned.id, job.hash, approval)]);
  const outcome = await recoverSharedClose(c.env, { ...recovery, approval: new TextEncoder().encode(JSON.stringify(approval)) });
  if (outcome === 'confirmed') return c.json({ ok: true });
  return c.json({ code: outcome === 'refused' ? 'close_refused' : 'close_retry' }, outcome === 'refused' ? 409 : 202);
});

errandRoutes.post('/api/pets/:id/errand', async (c) => {
  const session = requireSession(c);
  if (session instanceof Response) return session;
  const body = await c.req.json<{ form?: unknown; job?: unknown }>().catch(() => null);
  const form = formOf(body?.form);
  if (body === null || form === null || typeof body.job !== 'string') return c.json({ code: 'bad_request' }, 400);
  const limit = form === 'read' ? MAX_READ_CODE_POINTS : MAX_SEARCH_CODE_POINTS;
  if ([...body.job].length > limit || !hasVisible(body.job)) return c.json({ code: 'bad_request' }, 400);

  const owned = await ownedPet(c);
  if (owned instanceof Response) return owned;

  // The blocks are read again now: a page that is stale, or another tab's spend, must not start what it cannot pay.
  const { block, food, hasData } = await blocksOf(c.env, owned.id, owned.pet, form, Date.now());
  if (block !== null) return c.json({ code: 'blocked', block }, 409);

  const displayMax = view(form === 'read' ? fullRead(c.env) : searchQuote(c.env, food.room, hasData).upTo);
  const sent = await sendErrand(c.env.DB, { tokenId: owned.id, owner: owned.pet.owner_id, form, job: body.job, now: Date.now(), displayMax });
  if (sent === null) return c.json({ code: 'away' }, 409);
  track('errand_given', { form });
  run(c, owned.id);
  return c.json({ job: sent.job }, 202);
});
