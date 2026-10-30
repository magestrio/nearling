// GET /api/hatch (is hatching open, did this player already hatch) and POST /api/hatch (Birth flow).
import { Hono } from 'hono';
import { ChainUnreachable, hatchView, ownedCount, PET_MINT_TGAS, petView, type HatchRecord } from '../chain';
import { assembleCharacter } from '../character/presets';
import { requireSession, type AppContext, type AppEnv } from '../http';
import { cleanName, hasVisible } from '../name/clean';
import { hasInsult } from '../name/insult';
import { BIRTH_STORAGE_YOCTO, MAX_BIRTH_COST_YOCTO, nearUsdRate, STARTER_FOOD_YOCTO, yoctoToUsdMicros } from '../pricing';
import { desk, enqueueJob } from '../pet/desk';
import { gasIsLow, pauseReason } from '../servicePause';
import { track } from '../track';

export const hatchRoutes = new Hono<AppEnv>();

/** The pet's name, in UTF-8 bytes, as the raw input (the contract's `MAX_NAME_BYTES`). */
const MAX_NAME_BYTES = 32;
/** Births a UTC day (the contract's `BIRTHS_PER_DAY`). */
const BIRTHS_PER_DAY = 50;
/** New births close when the project's own spend reaches $100 (PRODUCT.md §4, in micro-dollars). */
const BUDGET_USD_MICROS = 100_000_000;
/** A birth row older than this belongs to an isolate that is gone; it is taken over. */
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
async function openness(env: Env, hatch: HatchRecord): Promise<Open> {
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

hatchRoutes.get('/api/hatch', async (c) => {
  const session = c.get('session');
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
  const state = await openness(c.env, hatch);
  if (!state.open) {
    // A player with no pet of their own has no way out of a closed screen (`add-pet` › Hatch screen ›
    // «no exit»): what they own now, one count of the chain, also for `?look=1`.
    let noPets = false;
    if (session !== null) {
      try {
        noPets = (await ownedCount(c.env, session.accountId)) === 0;
      } catch (e) {
        if (e instanceof ChainUnreachable) return unreachable(c);
        throw e;
      }
    }
    // `?look=1`: the screen's own repeat on a closed hatch; the event is for opening it or a tap.
    if (c.req.query('look') !== '1') track('birth_blocked', { reason: state.reason! });
    return c.json(noPets ? { ...state, noPets: true } : state);
  }
  if (session === null || hatch.token_id === null) return c.json(state);
  // Hatched before: «already» only while they still own that pet; one given away does not count.
  try {
    const pet = await petView(c.env, hatch.token_id);
    if (pet !== null && pet.owner_id === session.accountId) {
      return c.json({ ...state, already: { tokenId: hatch.token_id, name: pet.name } });
    }
  } catch (e) {
    if (e instanceof ChainUnreachable) return unreachable(c);
    throw e;
  }
  return c.json(state);
});

hatchRoutes.post('/api/hatch', async (c) => {
  const session = requireSession(c);
  if (session instanceof Response) return session;

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
    // The server's gas is read before a birth: a low balance closes hatching now, not at the next minute.
    await gasIsLow(c.env, Date.now());
    hatch = await hatchView(c.env, session.accountId);
  } catch (e) {
    if (e instanceof ChainUnreachable) return unreachable(c);
    throw e;
  }
  const state = await openness(c.env, hatch);
  if (!state.open) {
    track('birth_blocked', { reason: state.reason! });
    return c.json({ code: 'closed', reason: state.reason, until: state.until }, 409);
  }
  if (hatch.token_id !== null) {
    // The network has this player's pet. If a birth reached the chain but its row did not reach
    // D1 (the Worker died between the two), the row is written now: the network is the truth.
    await c.env.DB.prepare('INSERT OR IGNORE INTO pets (token_id, hatched_by, born_at, birth_tx) VALUES (?, ?, ?, ?)')
      .bind(hatch.token_id, session.accountId, Date.now(), '')
      .run();
    return c.json({ code: 'already' }, 409);
  }

  // One birth in flight per account. A second request waits for the first one's outcome and
  // answers the same: it never mints a second pet.
  const now = Date.now();
  const claimed = await c.env.DB.prepare(
    'INSERT INTO births_in_flight (account, started_at) VALUES (?, ?) ON CONFLICT (account) DO UPDATE SET started_at = excluded.started_at WHERE started_at < ?',
  )
    .bind(session.accountId, now, now - IN_FLIGHT_STALE_MS)
    .run();
  if (claimed.meta.changes === 0) return waitForTheOtherBirth(c.env, session.accountId, c);

  try {
    return await mint(c.env, session.accountId, name, c);
  } finally {
    await c.env.DB.prepare('DELETE FROM births_in_flight WHERE account = ?').bind(session.accountId).run();
  }
});

async function waitForTheOtherBirth(env: Env, account: string, c: AppContext): Promise<Response> {
  const deadline = Date.now() + IN_FLIGHT_WAIT_MS;
  while (Date.now() < deadline) {
    const row = await env.DB.prepare('SELECT 1 AS busy FROM births_in_flight WHERE account = ?').bind(account).first();
    if (row === null) break;
    await new Promise((resolve) => setTimeout(resolve, IN_FLIGHT_STEP_MS));
  }
  try {
    const hatch = await hatchView(env, account);
    if (hatch.token_id !== null) return c.json({ tokenId: hatch.token_id });
  } catch (e) {
    if (e instanceof ChainUnreachable) return unreachable(c);
    throw e;
  }
  return c.json({ code: 'not_hatched' }, 502);
}

async function mint(env: Env, account: string, name: string, c: AppContext): Promise<Response> {
  const character = assembleCharacter();
  const answer = await env.SERVER_KEY.get(env.SERVER_KEY.idFromName('server')).send({
    methodName: 'pet_mint',
    args: { receiver: account, name, character },
    gas: (PET_MINT_TGAS * 1_000_000_000_000n).toString(),
  });
  if (answer.status === 'unreachable') return unreachable(c);

  let tokenId: string | null = null;
  let txHash = '';
  if (answer.status === 'ok') {
    tokenId = String(answer.value);
    txHash = answer.txHash;
  } else {
    txHash = answer.txHash;
    if (answer.status === 'failed') {
      console.log(`mint_failed:${answer.code}`);
      if (answer.code === 'already_hatched') return c.json({ code: 'already' }, 409);
      // The day's 50 or the pool ran out between the check and the mint: the same closed answer.
      if (answer.code === 'daily_births') return c.json({ code: 'closed', reason: 'daily' }, 409);
      if (answer.code === 'pool_empty') return c.json({ code: 'closed', reason: 'pool' }, 409);
    } else {
      console.log('mint_unknown');
    }
    // The outcome of a failed or unheard transaction is the network's word, not ours: the
    // contract says whether the pet was born.
    try {
      const after = await hatchView(env, account);
      tokenId = after.token_id;
    } catch (e) {
      if (e instanceof ChainUnreachable) return unreachable(c);
      throw e;
    }
  }
  if (tokenId === null) return c.json({ code: 'not_hatched' }, 502);

  const at = Date.now();
  const statements = [
    env.DB.prepare('INSERT OR IGNORE INTO pets (token_id, hatched_by, born_at, birth_tx) VALUES (?, ?, ?, ?)').bind(tokenId, account, at, txHash),
  ];
  // The starter food and the storage of the birth come out of the project's pocket (Траты проекта).
  const rate = nearUsdRate(env.NEAR_USD_RATE);
  if (rate === null) {
    console.log('rate_missing');
  } else {
    for (const [kind, yocto] of [['starter_food', STARTER_FOOD_YOCTO], ['storage', BIRTH_STORAGE_YOCTO]] as const) {
      statements.push(env.DB.prepare('INSERT INTO project_spend (at, kind, usd_micros) VALUES (?, ?, ?)').bind(at, kind, yoctoToUsdMicros(yocto, rate)));
    }
  }
  await env.DB.batch(statements);
  track('pet_born');
  // The greeting is queued at birth and runs by the desk's alarm, with no request from the client
  // (First thought flow); the empty Pet screen asks again and gets the same job.
  await enqueueJob(env.DB, tokenId, { kind: 'greeting' });
  await desk(env, tokenId).arm(tokenId);
  return c.json({ tokenId });
}
