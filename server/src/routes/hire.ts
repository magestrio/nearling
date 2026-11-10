// The public Hire board. Membership comes directly from saved skills on each read;
// search stays in the browser and this route never receives or stores search words.
import { Hono } from 'hono';
import { ChainUnreachable, ownedCount, petView } from '../chain';
import { fullness, MAX_JOBS_PER_DAY, workerPrice } from '../pricing';
import { utcDay, type AppEnv } from '../http';
import { energyLeft } from '../pet/life';
import { publicVisits } from '../pet/publicVisits';
import { isPaused } from '../servicePause';
import { loadBoardFacts } from '../work/boardFacts';
import { publicFields, publicWorkLabels } from '../experience/publicFacts';
import { priceView } from '../work/quote';
import { track } from '../track';
import { opaquePlayerId, recordHatchEvent } from '../hatch/events';

export const hireRoutes = new Hono<AppEnv>();

// The public chain copy is one Durable Object read per card. Keep the number of live RPC
// reads bounded while allowing a large board to finish without a serial 15-second fan-out.
async function mapBounded<T, U>(items: T[], limit: number, read: (item: T) => Promise<U>): Promise<U[]> {
  const result = new Array<U>(items.length);
  let next = 0;
  let failed = false;
  let failure: unknown;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (!failed && next < items.length) {
      const index = next++;
      try {
        result[index] = await read(items[index]!);
      } catch (e) {
        failed = true;
        failure = e;
      }
    }
  }));
  if (failed) throw failure;
  return result;
}

hireRoutes.get('/api/hire', async (c) => {
  const now = Date.now();
  const today = utcDay(now);
  const [facts, paused, fields] = await Promise.all([loadBoardFacts(c.env.DB, today), isPaused(c.env.DB, 'thought'), publicFields(c.env.DB)]);
  const session = c.get('session');
  let cards;
  try {
    cards = await mapBounded([...facts.values()], 8, async (fact) => {
      const { tokenId, label, opaqueId, count, energyDay, energyUsed, unbilled } = fact;
      const copy = await c.env.GUEST_VIEW.get(c.env.GUEST_VIEW.idFromName(`pet:${tokenId}`)).readPet(tokenId);
      if (!copy.ok) throw new ChainUnreachable();
      if (copy.value === null) return null;
      const pet = copy.value;
      // The card's food copy may be 15 seconds old. A published field must use fresh
      // ownership so a gift hides it on the next board read.
      const fieldOwner = fields.has(tokenId) ? await petView(c.env, tokenId) : pet;
      if (fieldOwner === null) return null;
      const experience = await publicWorkLabels(c.env, tokenId, fieldOwner, fields);
      // A gift changes the signed-in viewer's mark at once, even while the public
      // availability snapshot remains inside its allowed 15-second copy.
      const yours = session !== null && (await petView(c.env, tokenId))?.owner_id === session.accountId;
      const eff = BigInt(pet.project_food) + BigInt(pet.given_food) - unbilled;
      const asleep = fullness(eff).state === 'asleep';
      const resting = energyLeft({ energyDay, energyUsed }, today) === 0 || (pet.jobs_today ?? 0) >= 10 || count >= MAX_JOBS_PER_DAY;
      const status = paused ? 'paused' : asleep ? 'asleep' : resting ? 'resting' : 'available';
      return { tokenId, opaqueId, name: pet.name, label,
        price: priceView(c.env, workerPrice(true, count)), status,
        ...(status === 'resting' ? { until: new Date((today + 1) * 86_400_000).toISOString() } : {}),
        yours, experience };
    });
  } catch (e) {
    if (e instanceof ChainUnreachable) return c.json({ code: 'chain_unreachable' }, 503);
    throw e;
  }
  const pets = cards.filter((card) => card !== null);
  const visits = pets.length === 0 ? await publicVisits(c.env) : [];
  if (visits === null) return c.json({ code: 'chain_unreachable' }, 503);
  let hasOwnedPet: boolean | undefined;
  if (session !== null) {
    try { hasOwnedPet = (await ownedCount(c.env, session.accountId)) > 0; }
    catch (e) {
      if (e instanceof ChainUnreachable) return c.json({ code: 'chain_unreachable' }, 503);
      throw e;
    }
  }
  console.log(`hire_board_read:${pets.length}`);
  return c.json({ pets, visits, ...(hasOwnedPet === undefined ? {} : { hasOwnedPet }) });
});

// A browser sends only the player's board intent and coded device. The server supplies
// ownership from the chain; guests stay unclassified. The pet id is the board's opaque id.
hireRoutes.post('/api/hire/event', async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (body === null || (body.intent !== 'opened' && body.intent !== 'pet_opened') ||
    (body.device !== 'desktop' && body.device !== 'phone') ||
    typeof body.tabId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.tabId) ||
    Object.keys(body).sort().join(',') !== (body.intent === 'opened' ? 'device,intent,tabId' : 'device,intent,petId,tabId'))
    return c.json({ code: 'bad_request' }, 400);
  if (body.intent === 'pet_opened') {
    if (typeof body.petId !== 'string' || !/^[0-9a-f]{32}$/.test(body.petId)) return c.json({ code: 'bad_request' }, 400);
    const pet = await c.env.DB.prepare('SELECT 1 AS found FROM pet_public_ids WHERE opaque_id = ?').bind(body.petId).first();
    if (pet === null) return c.json({ code: 'bad_request' }, 400);
  }
  const session = c.get('session');
  let hasOwnedPet: boolean | undefined;
  if (session !== null) {
    try { hasOwnedPet = (await ownedCount(c.env, session.accountId)) > 0; }
    catch (e) {
      if (e instanceof ChainUnreachable) return c.json({ code: 'chain_unreachable' }, 503);
      throw e;
    }
  }
  await recordHatchEvent(c.env, { name: body.intent === 'opened' ? 'hire_board_opened' : 'hire_board_pet_opened',
    tabId: body.tabId as string, playerId: session === null ? null : await opaquePlayerId(session.sub),
    device: body.device as 'desktop' | 'phone', ...(body.intent === 'pet_opened' ? { petId: body.petId as string } : {}),
    ...(hasOwnedPet === undefined ? {} : { hasOwnedPet }) });
  track(body.intent === 'opened' ? 'hire_board_opened' : 'hire_board_pet_opened', {
    device: body.device,
    ...(body.intent === 'pet_opened' ? { pet: body.petId as string } : {}),
    ...(hasOwnedPet === undefined ? {} : { has_owned_pet: hasOwnedPet }),
  });
  return c.body(null, 204);
});
