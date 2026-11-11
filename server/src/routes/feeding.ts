// Feeding. Every route needs a session and reads the session's account, never the request's. The
// order of a route: session (`gate`) -> input -> `pet_view` -> the in-flight row -> the pause (the snack
// only; a signed portion goes on any pause) -> work (design.md › Worker).
//  - GET  /api/pets/:id/feed          what Feed sheet shows; settles the player's own row when it finds one
//  - POST /api/pets/:id/feed          builds the unsigned `pet_feed` for the browser to check and sign
//  - POST /api/pets/:id/feed/send     sends what the browser signed
//  - POST /api/pets/:id/feed/outcome  the outcome for a tab that has no signed bytes
//  - POST /api/pets/:id/snack         the free snack, sent by the server
//  - GET  /api/wallet                 the address and the balance of the player's game wallet
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { ChainUnreachable, petView } from '../chain';
import { askNetwork, rowOfPlayer } from '../feeding/inflight';
import { buildPortion, sendPortion, type Reply } from '../feeding/portion';
import { readSheet } from '../feeding/read';
import { feedOutcome, giveSnack } from '../feeding/snack';
import { readWallet } from '../feeding/wallet';
import { ownerCredits } from '../any-chain/ownerCredits';
import { requireSession, TOKEN_ID, type AppContext, type AppEnv } from '../http';
import { isPaused } from '../servicePause';
import { FEED_PORTIONS, nearUsdRate } from '../pricing';

export const feedingRoutes = new Hono<AppEnv>();

const reply = (c: AppContext, r: Reply) => c.json(r.body, r.status as ContentfulStatusCode);

/** Work that sends a transaction or settles one runs to its end when the tab goes: the runtime cancels
 * a request with its client, and a send it cut off would leave a claim with no transfer, or a row with
 * no hash for a snack that landed. The grace after a disconnect, 30 s, covers `SEND_TIMEOUT_MS`. */
function outlive<T>(c: AppContext, work: Promise<T>): Promise<T> {
  c.executionCtx.waitUntil(work.catch(() => undefined));
  return work;
}

// Feed sheet. The pet is read from the network now (never a copy), so the viewer is who owns it at
// this moment: a pet given away turns the sheet of its old owner into a guest's. `chain: false`
// when the pet, the wallet or the pool cannot be read (`Feeding connection rule`): the client shows
// «We can't feed {name} right now» and nothing can be tapped.
feedingRoutes.get('/api/pets/:id/feed', async (c) => {
  const id = c.req.param('id');
  if (!TOKEN_ID.test(id)) return c.json({ code: 'no_pet' }, 404);
  const session = requireSession(c);
  if (session instanceof Response) return session;
  // An empty rate is a config error: the sheet's error state, not a sheet without prices.
  const rate = nearUsdRate(c.env.NEAR_USD_RATE);
  if (rate === null) return c.json({ code: 'rate_missing' }, 500);

  try {
    const pet = await petView(c.env, id);
    if (pet === null) return c.json({ code: 'no_pet' }, 404);
    // A meal or snack of the player's on its way is asked after first: when the network has an answer
    // it is settled here (its consequences run once, whoever gets there first), and the sheet is read
    // after it - the wallet's funding is not counted while a row stands, nor right after a meal.
    let own = await rowOfPlayer(c.env.DB, session.accountId);
    if (own !== null && (await outlive(c, askNetwork(c.env, own))) !== null) own = null;
    const { sheet } = await readSheet(c.env, session, id, pet, rate);
    // New cross-chain quote addresses are closed while project service spending is paused (`Cross-chain availability rule`).
    return c.json({ chain: true, ...sheet, crossChainPaused: await isPaused(c.env.DB, 'thought'),
      ...(pet.owner_id === session.accountId ? { crossChainCredits: await ownerCredits(c.env.DB, id) } : {}),
      pending: own === null ? null : { id: own.id, source: own.source, tokenId: own.token_id } });
  } catch (e) {
    if (e instanceof ChainUnreachable) return c.json({ chain: false });
    throw e;
  }
});

// The portion, built for the browser to check and sign (`Feeding transaction data`).
feedingRoutes.post('/api/pets/:id/feed', async (c) => {
  const id = c.req.param('id');
  if (!TOKEN_ID.test(id)) return c.json({ code: 'no_pet' }, 404);
  const session = requireSession(c);
  if (session instanceof Response) return session;
  const body = await c.req.json<{ portion?: unknown; code?: unknown }>().catch(() => null);
  const portion = FEED_PORTIONS.find((p) => p.near === body?.portion);
  if (portion === undefined) return c.json({ code: 'bad_request' }, 400);
  const rate = nearUsdRate(c.env.NEAR_USD_RATE);
  if (rate === null) return c.json({ code: 'rate_missing' }, 500);
  return reply(c, await outlive(c, buildPortion(c.env, session, id, portion.near, rate, body?.code)));
});

feedingRoutes.post('/api/pets/:id/feed/send', async (c) => {
  const id = c.req.param('id');
  if (!TOKEN_ID.test(id)) return c.json({ code: 'no_pet' }, 404);
  const session = requireSession(c);
  if (session instanceof Response) return session;
  const body = await c.req.json<{ tx?: unknown; signature?: unknown; code?: unknown }>().catch(() => null);
  if (body === null) return c.json({ code: 'bad_request' }, 400);
  return reply(c, await outlive(c, sendPortion(c.env, session, id, body)));
});

feedingRoutes.post('/api/pets/:id/feed/outcome', async (c) => {
  const id = c.req.param('id');
  if (!TOKEN_ID.test(id)) return c.json({ code: 'no_pet' }, 404);
  const session = requireSession(c);
  if (session instanceof Response) return session;
  const body = await c.req.json<{ id?: unknown; source?: unknown }>().catch(() => null);
  if (body === null) return c.json({ code: 'bad_request' }, 400);
  return reply(c, await outlive(c, feedOutcome(c.env, session, id, body)));
});

feedingRoutes.post('/api/pets/:id/snack', async (c) => {
  const id = c.req.param('id');
  if (!TOKEN_ID.test(id)) return c.json({ code: 'no_pet' }, 404);
  const session = requireSession(c);
  if (session instanceof Response) return session;
  const body = await c.req.json<{ code?: unknown }>().catch(() => null);
  const rate = nearUsdRate(c.env.NEAR_USD_RATE);
  if (rate === null) return c.json({ code: 'rate_missing' }, 500);
  return reply(c, await outlive(c, giveSnack(c.env, session, id, rate, body?.code)));
});

// The player's game wallet (Add NEAR sheet): its address, shown to its own player only, the balance
// and whether NEAR arrived since the last read (`wallet_funded`).
feedingRoutes.get('/api/wallet', async (c) => {
  const session = requireSession(c);
  if (session instanceof Response) return session;
  try {
    const wallet = await readWallet(c.env, session);
    return c.json({ address: session.accountId, balance: wallet.balance.toString(), funded: wallet.funded });
  } catch (e) {
    if (e instanceof ChainUnreachable) return c.json({ code: 'chain_unreachable' }, 503);
    throw e;
  }
});
