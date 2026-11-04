import { Hono } from 'hono';
import { ChainUnreachable, petView, type PetRecord } from '../chain';
import { acceptLink, cancelLink, createLink, invalidateMovedLink, linkForCode, linkForToken, type GiftLink } from '../gift/link';
import { giftOutcome, prepareGift, reconcileGiftToken, sendGift } from '../gift/flight';
import { requireSession, TOKEN_ID, type AppContext, type AppEnv } from '../http';
import { fullnessOf } from '../pet/view';

export const giftRoutes = new Hono<AppEnv>();
const CODE = /^[0-9a-f]{48}$/;

async function owner(c: AppContext): Promise<{ id: string; pet: PetRecord; account: string } | Response> {
  const session = requireSession(c);
  if (session instanceof Response) return session;
  const id = c.req.param('id') ?? '';
  if (!TOKEN_ID.test(id)) return c.json({ code: 'no_pet' }, 404);
  let pet: PetRecord | null;
  try {
    pet = await petView(c.env, id);
  } catch (error) {
    if (error instanceof ChainUnreachable) return c.json({ code: 'chain_unreachable' }, 503);
    throw error;
  }
  if (pet === null) return c.json({ code: 'no_pet' }, 404);
  if (pet.owner_id !== session.accountId) return c.json({ code: 'not_owner' }, 403);
  return { id, pet, account: session.accountId };
}

const sheet = (link: GiftLink) => ({
  code: link.code,
  status: link.status,
  acceptedName: link.accepted_name,
  acceptedAccount: link.accepted_account,
  version: link.version,
});

// The code read is public. It carries neither the giver's address/name nor the errand's words.
giftRoutes.get('/api/gifts/:code', async (c) => {
  const code = c.req.param('code');
  if (!CODE.test(code)) return c.json({ code: 'gift_unavailable' }, 404);
  let link = await linkForCode(c.env.DB, code);
  if (link === null || link.status === 'cancelled') return c.json({ code: 'gift_unavailable' }, 404);
  let unresolvedGift = false;
  if (link.status === 'accepted') {
    try {
      const outcome = await reconcileGiftToken(c.env, link.token_id);
      unresolvedGift = outcome?.body.status === 'unknown';
      link = await linkForCode(c.env.DB, code);
    } catch (error) {
      if (error instanceof ChainUnreachable) return c.json({ code: 'chain_unreachable' }, 503);
      throw error;
    }
    if (link === null || link.status === 'cancelled') return c.json({ code: 'gift_unavailable' }, 404);
  }
  let pet: PetRecord | null;
  try {
    pet = await petView(c.env, link.token_id);
  } catch (error) {
    if (error instanceof ChainUnreachable) return c.json({ code: 'chain_unreachable' }, 503);
    throw error;
  }
  if (pet === null) return c.json({ code: 'gift_unavailable' }, 404);
  const expectedOwner = link.status === 'transferred' ? link.accepted_account : link.giver_account;
  const transferVisible = unresolvedGift && pet.owner_id === link.accepted_account;
  if (pet.owner_id !== expectedOwner && !transferVisible) {
    await invalidateMovedLink(c.env.DB, link);
    return c.json({ code: 'gift_unavailable' }, 404);
  }
  const session = c.get('session');
  const allowedAfterAcceptance = session?.accountId === link.accepted_account || (link.status === 'accepted' && session?.accountId === link.giver_account);
  if (session !== null && link.status !== 'waiting' && !allowedAfterAcceptance) {
    return c.json({ code: 'gift_unavailable' }, 404);
  }
  const viewer = session?.accountId === link.giver_account && link.status !== 'transferred'
    ? 'giver'
    : session?.accountId === link.accepted_account
      ? 'receiver'
      : 'visitor';
  const errand = await c.env.DB.prepare(
    "SELECT display_max_cents FROM errands WHERE token_id = ? AND owner = ? AND state = 'away' AND display_max_cents IS NOT NULL",
  ).bind(link.token_id, pet.owner_id).first<{ display_max_cents: number }>();
  return c.json({
    tokenId: link.token_id,
    name: pet.name,
    fullness: await fullnessOf(c.env.DB, link.token_id, pet),
    status: transferVisible ? 'transferred' : link.status,
    viewer,
    errand: errand === null ? null : { running: true, maxCents: errand.display_max_cents },
  });
});

giftRoutes.post('/api/pets/:id/gift', async (c) => {
  const own = await owner(c);
  if (own instanceof Response) return own;
  try {
    const flight = await reconcileGiftToken(c.env, own.id);
    if (flight?.body.status === 'unknown') return c.json({ code: 'pending' }, 409);
    return c.json(sheet(await createLink(c.env.DB, own.id, own.account, Date.now())));
  } catch (error) {
    if (error instanceof ChainUnreachable) return c.json({ code: 'chain_unreachable' }, 503);
    if (error instanceof Error && error.message === 'gift_create_race') return c.json({ code: 'pending' }, 409);
    throw error;
  }
});

giftRoutes.get('/api/pets/:id/gift', async (c) => {
  const own = await owner(c);
  if (own instanceof Response) return own;
  const link = await linkForToken(c.env.DB, own.id);
  if (link === null || link.giver_account !== own.account || link.status === 'cancelled' || link.status === 'transferred') return c.json({ status: 'none' });
  return c.json(sheet(link));
});

giftRoutes.delete('/api/pets/:id/gift', async (c) => {
  const own = await owner(c);
  if (own instanceof Response) return own;
  const cancelled = await cancelLink(c.env.DB, own.id, own.account);
  if (cancelled === null) return c.json({ code: 'gift_unavailable' }, 409);
  return c.json({ status: 'cancelled' });
});

giftRoutes.post('/api/gifts/:code/accept', async (c) => {
  const session = requireSession(c);
  if (session instanceof Response) return session;
  const code = c.req.param('code');
  if (!CODE.test(code)) return c.json({ code: 'gift_unavailable' }, 404);
  const link = await linkForCode(c.env.DB, code);
  if (link === null || link.status === 'cancelled' || link.status === 'transferred') return c.json({ code: 'gift_unavailable' }, 404);
  let pet: PetRecord | null;
  try {
    pet = await petView(c.env, link.token_id);
  } catch (error) {
    if (error instanceof ChainUnreachable) return c.json({ code: 'chain_unreachable' }, 503);
    throw error;
  }
  if (pet === null || pet.owner_id !== link.giver_account) {
    await invalidateMovedLink(c.env.DB, link);
    return c.json({ code: 'gift_unavailable' }, 404);
  }
  if (session.accountId === pet.owner_id) return c.json({ code: 'not_receiver' }, 403);
  const player = await c.env.DB.prepare('SELECT first_name FROM players WHERE sub = ?').bind(session.sub).first<{ first_name: string | null }>();
  const accepted = await acceptLink(c.env.DB, code, session.accountId, player?.first_name ?? null, Date.now());
  if (accepted === null) return c.json({ code: 'gift_unavailable' }, 409);
  return c.json({ status: 'accepted', tokenId: accepted.token_id });
});

giftRoutes.post('/api/pets/:id/gift/prepare', async (c) => {
  const own = await owner(c);
  if (own instanceof Response) return own;
  const result = await prepareGift(c.env, c.get('session')!, own.id);
  return c.json(result.body, result.status);
});

giftRoutes.post('/api/pets/:id/gift/send', async (c) => {
  const own = await owner(c);
  if (own instanceof Response) return own;
  const body = await c.req.json<{ tx?: unknown; signature?: unknown }>().catch(() => null);
  if (body === null) return c.json({ code: 'bad_request' }, 400);
  const result = await sendGift(c.env, c.get('session')!, own.id, body);
  return c.json(result.body, result.status);
});

giftRoutes.get('/api/pets/:id/gift/outcome', async (c) => {
  const session = requireSession(c);
  if (session instanceof Response) return session;
  const id = c.req.param('id') ?? '';
  if (!TOKEN_ID.test(id)) return c.json({ code: 'no_pet' }, 404);
  const result = await giftOutcome(c.env, session, id);
  return c.json(result.body, result.status);
});
