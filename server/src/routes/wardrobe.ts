// The wardrobe of the owner's pet (`add-wardrobe`): the read the Wardrobe screen draws from, «Wear» and
// «Take off», and a notice shown. The order of a route's checks (design.md › Worker): the request
// limit (`gate`) -> the input -> the owner from the contract, uncached (`ownedPet`) -> the write. Only
// the item's name reaches the server (`Wardrobe data`); nothing is logged.
import { Hono } from 'hono';
import { ChainUnreachable } from '../chain';
import { requireSession, type AppEnv } from '../http';
import { queueBuy } from '../pet/buy';
import { BOUGHT_IDS, idOf, isOutfitSlug, OUTFITS, readWardrobe, slugsOf, type OutfitSlug } from '../pet/outfits';
import { foodState, outfitPrice } from '../pet/view';
import { fullness, OUTFIT_PRICE_YOCTO } from '../pricing';
import { gasIsLow, isPaused, pauseReason } from '../servicePause';
import { ownedPet, run } from './thoughts';

export const wardrobeRoutes = new Hono<AppEnv>();

/** A settled purchase is shown as the outcome for this long (`Outfit purchase flow` › «куплено»: a reload never
 * brings back an old line). */
const OUTCOME_WINDOW_MS = 10 * 60_000;

const isBought = (slug: OutfitSlug): boolean => (BOUGHT_IDS as readonly number[]).includes(idOf(slug));

// What only this screen needs. `owned` and `worn` are repeated from the owner's view so that one
// answer draws a screen. `short`: after the price the pet would not stay «Full». `shopPaused`: the gas
// pause only, a purchase works on the pause of NEAR AI (`Outfit purchase flow` › «покупки на паузе»).
wardrobeRoutes.get('/api/pets/:id/wardrobe', async (c) => {
  const owned = await ownedPet(c);
  if (owned instanceof Response) return owned;
  const { pet, id } = owned;
  const wardrobe = await readWardrobe(c.env.DB, id);
  const now = Date.now();
  const food = await foodState(c.env.DB, id, pet, now);
  // The pet's oldest open purchase, and its newest settled one of the last minutes: a tab that watched
  // that id draws the outcome, any other only the result (`Outfit purchase flow` › «куплено»).
  const buying = await c.env.DB.prepare("SELECT id, item FROM outfit_buys WHERE token_id = ? AND status IN ('queued', 'sending', 'unknown') ORDER BY created_at, rowid LIMIT 1")
    .bind(id)
    .first<{ id: string; item: OutfitSlug }>();
  const outcome = await c.env.DB.prepare("SELECT id, item, status, code FROM outfit_buys WHERE token_id = ? AND status IN ('bought', 'failed') AND settled_at > ? ORDER BY settled_at DESC, rowid DESC LIMIT 1")
    .bind(id, now - OUTCOME_WINDOW_MS)
    .first<{ id: string; item: OutfitSlug; status: 'bought' | 'failed'; code: string | null }>();
  return c.json({
    owned: slugsOf(pet.outfits),
    worn: wardrobe.worn,
    price: outfitPrice(c.env),
    // Room, not food: a purchase on its way is held against the price of the next.
    short: fullness(food.room - OUTFIT_PRICE_YOCTO).state !== 'full',
    shopPaused: (await pauseReason(c.env.DB)) === 'gas',
    buying,
    outcome,
  });
});

// «Buy · {price}»: one tap, one row. A second tap of the same item, from any tab, gets the open row's id.
// The refusals that need the pet's food and cap are the desk's, so that they are decided in the one line
// of the pet's spends; here only what is known at once.
wardrobeRoutes.post('/api/pets/:id/wardrobe/buy', async (c) => {
  const session = requireSession(c);
  if (session instanceof Response) return session;
  const body = await c.req.json<{ item?: unknown }>().catch(() => null);
  if (body === null || !isOutfitSlug(body.item) || !isBought(body.item)) return c.json({ code: 'bad_request' }, 400);
  const item: OutfitSlug = body.item;

  const owned = await ownedPet(c);
  if (owned instanceof Response) return owned;
  if (owned.pet.outfits.includes(idOf(item))) return c.json({ code: 'owned' }, 409);
  // Gas only: a purchase works on the pause of NEAR AI.
  try {
    if ((await isPaused(c.env.DB, 'outfit')) || (await gasIsLow(c.env, Date.now()))) return c.json({ code: 'paused' }, 409);
  } catch (e) {
    if (e instanceof ChainUnreachable) return c.json({ code: 'chain_unreachable' }, 503);
    throw e;
  }
  const id = await queueBuy(c.env.DB, owned.id, item);
  run(c, owned.id);
  return c.json({ id }, 202);
});

// «Wear» / «Take off»: no chain write, no pause, no food read; asleep or awake alike.
wardrobeRoutes.post('/api/pets/:id/wardrobe/wear', async (c) => {
  const session = requireSession(c);
  if (session instanceof Response) return session;
  const body = await c.req.json<{ item?: unknown }>().catch(() => null);
  if (body === null || !('item' in body) || (body.item !== null && !isOutfitSlug(body.item))) return c.json({ code: 'bad_request' }, 400);
  const item: OutfitSlug | null = body.item;

  const owned = await ownedPet(c);
  if (owned instanceof Response) return owned;
  // «Wear» only for an item the pet has on the chain.
  if (item !== null && !owned.pet.outfits.includes(idOf(item))) return c.json({ code: 'not_owned' }, 409);

  await c.env.DB.prepare('INSERT INTO wardrobe (token_id, worn) VALUES (?1, ?2) ON CONFLICT (token_id) DO UPDATE SET worn = excluded.worn')
    .bind(owned.id, item)
    .run();
  return c.json({ worn: item });
});

// A notice shown: the item's bit goes into `seen`, once. An item the chain does not hold yet is not
// marked, so its notice is not swallowed before it exists.
wardrobeRoutes.post('/api/pets/:id/wardrobe/seen', async (c) => {
  const session = requireSession(c);
  if (session instanceof Response) return session;
  const body = await c.req.json<{ item?: unknown }>().catch(() => null);
  const earned = OUTFITS.filter((o) => o.kind !== 'bought').map((o) => o.slug) as string[];
  if (body === null || typeof body.item !== 'string' || !earned.includes(body.item)) return c.json({ code: 'bad_request' }, 400);

  const owned = await ownedPet(c);
  if (owned instanceof Response) return owned;
  const bit = 1 << idOf(body.item);
  if (owned.pet.outfits.includes(idOf(body.item))) {
    await c.env.DB.prepare('INSERT INTO wardrobe (token_id, seen) VALUES (?1, ?2) ON CONFLICT (token_id) DO UPDATE SET seen = seen | ?2')
      .bind(owned.id, bit)
      .run();
  }
  return c.json({ ok: true });
});
