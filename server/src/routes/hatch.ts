// GET /api/hatch (is hatching open, did this player already hatch) and POST /api/hatch (Birth flow).
import { Hono } from 'hono';
import { ChainUnreachable, currentGasPrice, finalBirthStatus, hatchView, isNodeRefusal, ownedCount, PET_MINT_TGAS, petView, type HatchRecord } from '../chain';
import { assembleCharacter } from '../character/presets';
import { requireSession, type AppContext, type AppEnv } from '../http';
import { cleanName, hasVisible } from '../name/clean';
import { hasInsult } from '../name/insult';
import { MAX_BIRTH_COST_YOCTO, nearUsdRate, yoctoToUsdMicros } from '../pricing';
import { birthFlight, finishBirth, releaseFailedBirth, type BirthFlight } from '../pet/birth';
import { gasIsLow, pauseReason } from '../servicePause';
import { track } from '../track';
import { currentPet, lastGiftedPet, ownedPets } from '../gift/current';
import { knownPets } from '../pet/known';

export const hatchRoutes = new Hono<AppEnv>();

/** The pet's name, in UTF-8 bytes, as the raw input (the contract's `MAX_NAME_BYTES`). */
const MAX_NAME_BYTES = 32;
/** Births a UTC day (the contract's `BIRTHS_PER_DAY`). */
const BIRTHS_PER_DAY = 50;
/** New births close when the project's own spend reaches $100 (PRODUCT.md §4, in micro-dollars). */
const BUDGET_USD_MICROS = 100_000_000;
const PROJECT_CEILING_USD_MICROS = 120_000_000;
/** A row without a signed hash may be reclaimed after the sender has stopped. */
const IN_FLIGHT_STALE_MS = 60_000;
const IN_FLIGHT_WAIT_MS = 30_000;
const IN_FLIGHT_STEP_MS = 500;

type Reason = 'service' | 'budget' | 'pool' | 'daily';

interface Open {
  open: boolean;
  reason?: Reason;
  until?: string;
}

/** Why hatching is closed, if it is. Several reasons at once: the longest wins, so that «back at
 * 02:00» is never promised while the pool is empty. `until` only for the day's 50 alone. */
export async function openness(env: Env, hatch: HatchRecord): Promise<Open> {
  const causes = new Set<Reason>();
  if ((await pauseReason(env.DB)) !== null) causes.add('service');
  const spent = await env.DB.prepare('SELECT COALESCE(SUM(usd_micros), 0) AS total FROM project_spend').first<{ total: number }>();
  if ((spent?.total ?? 0) >= BUDGET_USD_MICROS) causes.add('budget');
  if (BigInt(hatch.pool) < MAX_BIRTH_COST_YOCTO) causes.add('pool');
  if (hatch.born_today >= BIRTHS_PER_DAY) causes.add('daily');
  const reason = (['service', 'budget', 'pool', 'daily'] as const).find((r) => causes.has(r));
  if (reason === undefined) return { open: true };
  if (reason === 'daily') return { open: false, reason, until: new Date((hatch.day + 1) * 86_400_000).toISOString() };
  return { open: false, reason };
}

const unreachable = (c: { json: (body: unknown, status: 503) => Response }) => c.json({ code: 'chain_unreachable' }, 503);

async function already(c: AppContext): Promise<Response> {
  const account = c.get('session')!.accountId;
  try {
    const { pets } = await ownedPets(c.env, account);
    const pet = await currentPet(c.env, account, pets);
    if (pet === null) return unreachable(c);
    return c.json({ code: 'already', currentPet: { tokenId: pet.tokenId, name: pet.name } }, 409);
  } catch (e) {
    if (e instanceof ChainUnreachable) return unreachable(c);
    throw e;
  }
}

hatchRoutes.get('/api/hatch', async (c) => {
  const session = c.get('session');
  if (session !== null) {
    // The POST claims this account before its first chain read. An unsigned, live claim is
    // enough to keep a remounted Hatch screen pending while that read is still in progress.
    const claim = await c.env.DB.prepare('SELECT started_at, tx_hash FROM births_in_flight WHERE account = ?')
      .bind(session.accountId).first<{ started_at: number; tx_hash: string | null }>();
    if (claim !== null && claim.tx_hash === null && Date.now() - claim.started_at < IN_FLIGHT_STALE_MS) {
      try { return c.json({ open: true, pending: true, knownPets: await knownPets(c.env, session.accountId) }); }
      catch (e) {
        if (e instanceof ChainUnreachable) return unreachable(c);
        throw e;
      }
    }
  }
  let hatch: HatchRecord;
  if (session === null) {
    const copy = await c.env.GUEST_VIEW.get(c.env.GUEST_VIEW.idFromName('hatch')).readHatch();
    if (!copy.ok) return unreachable(c);
    hatch = copy.value;
  } else {
    try {
      hatch = await hatchView(c.env, session.accountId);
    } catch (e) {
      if (e instanceof ChainUnreachable) return unreachable(c);
      throw e;
    }
  }
  let flight: Awaited<ReturnType<typeof birthFlight>> = 'none';
  if (session !== null) {
    try {
      flight = await birthFlight(c.env, session.accountId, hatch);
    } catch (e) {
      if (e instanceof ChainUnreachable) return unreachable(c);
      throw e;
    }
  }
  let ownership: { ownedCount: number; latestBirth: { tokenId: string; name: string } | null;
    currentPet: { tokenId: string; name: string } | null; knownPets: Awaited<ReturnType<typeof knownPets>> } | null = null;
  if (session !== null) {
    try {
      const [{ pets, hatched }, known] = await Promise.all([ownedPets(c.env, session.accountId), knownPets(c.env, session.accountId)]);
      const current = await currentPet(c.env, session.accountId, pets);
      ownership = { ownedCount: pets.length,
        latestBirth: hatched === null ? null : { tokenId: hatched.tokenId, name: hatched.name },
        currentPet: current === null ? null : { tokenId: current.tokenId, name: current.name }, knownPets: known };
    } catch (e) {
      if (e instanceof ChainUnreachable) return unreachable(c);
      throw e;
    }
  }
  if (flight === 'pending') return c.json({ open: true, pending: true, ...ownership });
  if (flight === 'failed') return c.json({ open: true, failed: true, ...ownership });
  if (typeof flight === 'object') return c.json({ open: true, tokenId: flight.tokenId, ...ownership });
  const state = await openness(c.env, hatch);
  if (state.open && ownership !== null && ownership.currentPet !== null) {
    return c.json({ ...state, ...ownership, already: ownership.currentPet });
  }
  if (!state.open) {
    // A player with no pet of their own has no way out of a closed screen (`add-pet` › Hatch screen ›
    // «no exit»): what they own now, one count of the chain, also for `?look=1`.
    const noPets = ownership !== null && ownership.ownedCount === 0;
    // `?look=1`: the screen's own repeat on a closed hatch; the event is for opening it or a tap.
    if (c.req.query('look') !== '1') track('birth_blocked', { reason: state.reason! });
    let lastGifted = null;
    try {
      lastGifted = noPets && session !== null && hatch.token_id !== null ? await lastGiftedPet(c.env, session.accountId) : null;
    } catch (e) {
      if (e instanceof ChainUnreachable) return unreachable(c);
      throw e;
    }
    return c.json(noPets ? { ...state, ...ownership, noPets: true, ...(lastGifted === null ? {} : { lastGifted }) } : { ...state, ...ownership });
  }
  if (session === null) return c.json(state);
  try {
    const lastGifted = await lastGiftedPet(c.env, session.accountId);
    return c.json({ ...state, ...ownership, noPets: true, ...(lastGifted === null ? {} : { lastGifted }) });
  } catch (e) {
    if (e instanceof ChainUnreachable) return unreachable(c);
    throw e;
  }
});

hatchRoutes.post('/api/hatch', async (c) => {
  const session = requireSession(c);
  if (session instanceof Response) return session;

  // Claim before parsing the name, reading the chain or checking whether births are open.
  // This gives every status read a durable pending answer as soon as the POST starts.
  let startedAt = Date.now();
  let claimed = await c.env.DB.prepare(
    'INSERT INTO births_in_flight (account, started_at) VALUES (?, ?) ON CONFLICT (account) DO UPDATE SET started_at = excluded.started_at WHERE started_at < ? AND tx_hash IS NULL',
  ).bind(session.accountId, startedAt, startedAt - IN_FLIGHT_STALE_MS).run();
  let ownsClaim = claimed.meta.changes === 1;
  let keepClaim = false;
  let mintResponse: Response | null = null;
  try {
    const body = await c.req.json<{ name?: unknown }>().catch(() => null);
    if (body === null || typeof body.name !== 'string') return c.json({ code: 'bad_request' }, 400);
    const raw = body.name;
    if (new TextEncoder().encode(raw).length > MAX_NAME_BYTES) return c.json({ code: 'name_too_long' }, 400);

    // Nothing leaves the Worker before the name is accepted; a refusal writes and logs nothing of it.
    const name = cleanName(raw);
    if (!hasVisible(name) || hasInsult(name, c.env.INSULT_LIST)) {
      console.log('name_rejected');
      return c.json({ code: 'name_rejected' }, 422);
    }

    let hatch: HatchRecord;
    try {
      hatch = await hatchView(c.env, session.accountId);
    } catch (e) {
      if (e instanceof ChainUnreachable) return unreachable(c);
      throw e;
    }
    try {
      if (!ownsClaim) {
        const flight = await birthFlight(c.env, session.accountId, hatch);
        if (flight === 'pending') {
          const signed = await c.env.DB.prepare('SELECT tx_hash FROM births_in_flight WHERE account = ?')
            .bind(session.accountId).first<{ tx_hash: string | null }>();
          return signed?.tx_hash === null ? waitForTheOtherBirth(c.env, session.accountId, name, c) : c.json({ pending: true }, 202);
        }
        if (flight === 'failed') {
          const old = await c.env.DB.prepare('SELECT started_at, tx_hash, signed_bytes, rebroadcast_at, failed, prior_token_id, birth_rate_usd_micros FROM births_in_flight WHERE account = ?')
            .bind(session.accountId).first<BirthFlight>();
          if (old !== null) {
            const [cleared] = await c.env.DB.batch([
              c.env.DB.prepare('DELETE FROM births_in_flight WHERE account = ? AND started_at = ? AND tx_hash IS ?')
                .bind(session.accountId, old.started_at, old.tx_hash),
              c.env.DB.prepare('DELETE FROM item_sends WHERE tx_hash = ?').bind(old.tx_hash ?? ''),
            ]);
            if (cleared.meta.changes === 0) return waitForTheOtherBirth(c.env, session.accountId, name, c);
          }
        }
        // A status read may have finalized the signed birth while the first hatch_view was
        // one block behind. Never apply new-birth checks to that already completed mint.
        if (typeof flight === 'object') return c.json({ tokenId: flight.tokenId });
      }
    } catch (e) {
      if (e instanceof ChainUnreachable) return unreachable(c);
      throw e;
    }

    try {
      // Only a new attempt needs the current gas and openness checks. An older signed birth
      // remains pending even when another birth closes today's allowance.
      await gasIsLow(c.env, Date.now());
    } catch (e) {
      if (e instanceof ChainUnreachable) return unreachable(c);
      throw e;
    }
    const state = await openness(c.env, hatch);
    if (!state.open) {
      track('birth_blocked', { reason: state.reason! });
      return c.json({ code: 'closed', reason: state.reason, until: state.until }, 409);
    }

    // Birth history is not ownership. A gifted-in pet vetoes even a first hatch.
    try {
      if (await ownedCount(c.env, session.accountId) > 0) return already(c);
    } catch (e) {
      if (e instanceof ChainUnreachable) return unreachable(c);
      throw e;
    }

    // Reserve the worst pool debit and all prepaid mint gas at the current protocol price.

    // One birth in flight per account. A second request waits for the first one's outcome and
    // answers the same: it never mints a second pet.
    if (!ownsClaim) {
      startedAt = Date.now();
      claimed = await c.env.DB.prepare(
        'INSERT INTO births_in_flight (account, started_at) VALUES (?, ?) ON CONFLICT (account) DO UPDATE SET started_at = excluded.started_at WHERE started_at < ? AND tx_hash IS NULL',
      ).bind(session.accountId, startedAt, startedAt - IN_FLIGHT_STALE_MS).run();
      if (claimed.meta.changes === 0) return waitForTheOtherBirth(c.env, session.accountId, name, c);
      ownsClaim = true;
    }
    mintResponse = await mint(c.env, session.accountId, name, startedAt, hatch.token_id, c);
    keepClaim = mintResponse.status === 202;
    return mintResponse;
  } finally {
    if (ownsClaim && !keepClaim) {
      // A thrown error may happen after the signer persisted the hash. In that case the
      // original transaction still needs its journal for later reconciliation.
      await c.env.DB.prepare('DELETE FROM births_in_flight WHERE account = ? AND started_at = ? AND tx_hash IS NULL')
        .bind(session.accountId, startedAt).run();
    }
  }
});

async function waitForTheOtherBirth(env: Env, account: string, name: string, c: AppContext): Promise<Response> {
  const deadline = Date.now() + IN_FLIGHT_WAIT_MS;
  while (Date.now() < deadline) {
    const row = await env.DB.prepare('SELECT 1 AS busy FROM births_in_flight WHERE account = ?').bind(account).first();
    if (row === null) break;
    await new Promise((resolve) => setTimeout(resolve, IN_FLIGHT_STEP_MS));
  }
  try {
    const hatch = await hatchView(env, account);
    const flight = await birthFlight(env, account, hatch);
    if (flight === 'pending') return c.json({ pending: true }, 202);
    if (typeof flight === 'object') return c.json({ tokenId: flight.tokenId });
    // The other request may have rejected its name before signing. A valid request must
    // compete for a fresh claim and mint; a missing pet alone is not a failed transaction.
    const released = flight === 'failed' && await env.DB.prepare('SELECT 1 AS busy FROM births_in_flight WHERE account = ?')
      .bind(account).first() === null;
    if (flight === 'none' || released) {
      await gasIsLow(env, Date.now());
      const state = await openness(env, hatch);
      if (!state.open) return c.json({ code: 'closed', reason: state.reason, until: state.until }, 409);
      if (await ownedCount(env, account) > 0) return already(c);
      const startedAt = Date.now();
      const claimed = await env.DB.prepare(
        'INSERT INTO births_in_flight (account, started_at) VALUES (?, ?) ON CONFLICT (account) DO UPDATE SET started_at = excluded.started_at WHERE started_at < ? AND tx_hash IS NULL',
      ).bind(account, startedAt, startedAt - IN_FLIGHT_STALE_MS).run();
      if (claimed.meta.changes === 0) return c.json({ pending: true }, 202);
      let response: Response | null = null;
      try {
        response = await mint(env, account, name, startedAt, hatch.token_id, c);
        return response;
      } finally {
        if (response?.status !== 202) {
          await env.DB.prepare('DELETE FROM births_in_flight WHERE account = ? AND started_at = ? AND tx_hash IS NULL')
            .bind(account, startedAt).run();
        }
      }
    }
  } catch (e) {
    if (e instanceof ChainUnreachable) return unreachable(c);
    throw e;
  }
  return c.json({ code: 'not_hatched' }, 502);
}

async function reserveNextMint(env: Env, account: string, startedAt: number, priorToken: string | null): Promise<number | null> {
  const rate = nearUsdRate(env.NEAR_USD_RATE);
  if (rate === null) return null;
  let gasPrice: bigint;
  try { gasPrice = await currentGasPrice(env); }
  catch (e) {
    if (e instanceof ChainUnreachable) return null;
    throw e;
  }
  const projected = yoctoToUsdMicros(MAX_BIRTH_COST_YOCTO + PET_MINT_TGAS * 1_000_000_000_000n * gasPrice, rate);
  const result = await env.DB.prepare(`UPDATE births_in_flight SET prior_token_id = ?1, reserved_usd_micros = ?2, birth_rate_usd_micros = ?7
    WHERE account = ?3 AND started_at = ?4 AND tx_hash IS NULL
      AND (SELECT COALESCE(SUM(usd_micros), 0) FROM project_spend) < ?5
      AND (SELECT COALESCE(SUM(usd_micros), 0) FROM project_spend)
        + (SELECT COALESCE(SUM(reserved_usd_micros), 0) FROM births_in_flight WHERE account <> ?3 AND (tx_hash IS NOT NULL OR started_at >= ?8))
        + ?2 <= ?6`)
    .bind(priorToken, projected, account, startedAt, BUDGET_USD_MICROS, PROJECT_CEILING_USD_MICROS, Math.round(rate * 1_000_000), Date.now() - IN_FLIGHT_STALE_MS).run();
  return result.meta.changes === 1 ? Math.round(rate * 1_000_000) : null;
}

async function mint(env: Env, account: string, name: string, startedAt: number, priorToken: string | null, c: AppContext): Promise<Response> {
  const rateMicros = await reserveNextMint(env, account, startedAt, priorToken);
  if (rateMicros === null) return c.json({ code: 'closed', reason: 'budget' }, 409);
  const character = assembleCharacter();
  const answer = await env.SERVER_KEY.get(env.SERVER_KEY.idFromName('server')).send({
    methodName: 'pet_mint',
    args: { receiver: account, name, character },
    gas: (PET_MINT_TGAS * 1_000_000_000_000n).toString(),
    writes: { kind: 'birth', receiver: account, startedAt },
  });
  if (answer.status === 'unreachable') {
    // The send can lose its answer after the signer saved the hash. That outcome is still
    // unknown and must be resolved through the original hash, never offered as a new birth.
    const signed = await env.DB.prepare('SELECT tx_hash FROM births_in_flight WHERE account = ? AND started_at = ?')
      .bind(account, startedAt).first<{ tx_hash: string | null }>();
    return signed?.tx_hash === null || signed === null ? unreachable(c) : c.json({ pending: true }, 202);
  }

  if (answer.status !== 'ok') {
    if (answer.status === 'failed') {
      if (isNodeRefusal(answer.code)) {
        await releaseFailedBirth(env, account, startedAt, answer.txHash);
        console.log(`mint_failed:${answer.code}`);
        return c.json({ code: 'not_hatched' }, 502);
      }
      let final;
      try { final = await finalBirthStatus(env, answer.txHash, env.SERVER_ACCOUNT_ID, account); }
      catch (e) {
        if (e instanceof ChainUnreachable) return unreachable(c);
        throw e;
      }
      if (final?.status !== 'failed') return c.json({ pending: true }, 202);
      await releaseFailedBirth(env, account, startedAt, answer.txHash, final.burnt, rateMicros);
      console.log(`mint_failed:${final.code}`);
      if (final.code === 'already_owns_pet' || final.code === 'already_hatched') return already(c);
      // The day's 50 or the pool ran out between the check and the mint: the same closed answer.
      if (final.code === 'daily_births') return c.json({ code: 'closed', reason: 'daily' }, 409);
      if (final.code === 'pool_empty' || final.code === 'birth_cost_limit') return c.json({ code: 'closed', reason: 'pool' }, 409);
    } else {
      console.log('mint_unknown');
    }
    if (answer.status === 'unknown') {
      let seen;
      try { seen = await finalBirthStatus(env, answer.txHash, env.SERVER_ACCOUNT_ID, account); }
      catch (e) {
        if (e instanceof ChainUnreachable) return unreachable(c);
        throw e;
      }
      if (seen?.status === 'ok' && seen.value !== null && seen.value !== priorToken) {
        await finishBirth(env, account, seen.value, answer.txHash, seen.burnt ?? '0', priorToken, rateMicros);
        await env.DB.prepare('DELETE FROM births_in_flight WHERE account = ? AND started_at = ? AND tx_hash = ?')
          .bind(account, startedAt, answer.txHash).run();
        return c.json({ tokenId: seen.value });
      }
      return c.json({ pending: true }, 202);
    }
    return c.json({ code: 'not_hatched' }, 502);
  }
  let final;
  try { final = await finalBirthStatus(env, answer.txHash, env.SERVER_ACCOUNT_ID, account); }
  catch (e) {
    if (e instanceof ChainUnreachable) return unreachable(c);
    throw e;
  }
  if (final?.status !== 'ok' || final.value === null || final.value === priorToken) return c.json({ pending: true }, 202);
  await finishBirth(env, account, final.value, answer.txHash, final.burnt ?? '0', priorToken, rateMicros);
  await env.DB.prepare('DELETE FROM births_in_flight WHERE account = ? AND started_at = ? AND tx_hash = ?')
    .bind(account, startedAt, answer.txHash).run();
  return c.json({ tokenId: final.value });
}
