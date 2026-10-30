// GET /api/pets/:id and GET /api/me.
import { Hono } from 'hono';
import { ChainUnreachable, hatchView, ownedCount, petView, stageOf, type PetRecord } from '../chain';
import { requireSession, TOKEN_ID, type AppEnv } from '../http';
import { fullnessOf, ownerFields } from '../pet/view';
import { pauseReason } from '../servicePause';

export const petRoutes = new Hono<AppEnv>();

const unreachable = (c: { json: (body: unknown, status: 503) => Response }) => c.json({ code: 'chain_unreachable' }, 503);

// A pet. Without a session: the shared copy (<= 15 s). With a session: the network is read now,
// and the owner gets the owner's view; anyone else the guest's.
petRoutes.get('/api/pets/:id', async (c) => {
  const id = c.req.param('id');
  if (!TOKEN_ID.test(id)) return c.json({ code: 'no_pet' }, 404);
  const session = c.get('session');

  let pet: PetRecord | null;
  if (session === null) {
    const copy = await c.env.GUEST_VIEW.get(c.env.GUEST_VIEW.idFromName(`pet:${id}`)).readPet(id);
    if (!copy.ok) return unreachable(c);
    pet = copy.value;
  } else {
    try {
      pet = await petView(c.env, id);
    } catch (e) {
      if (e instanceof ChainUnreachable) return unreachable(c);
      throw e;
    }
  }
  if (pet === null) return c.json({ code: 'no_pet' }, 404);

  const base = { tokenId: id, name: pet.name, stage: stageOf(pet), fullness: await fullnessOf(c.env.DB, id, pet) };
  if (session === null) return c.json({ viewer: 'visitor', ...base });
  if (pet.owner_id !== session.accountId) return c.json({ viewer: 'guest', ...base });

  let owned: number;
  try {
    owned = await ownedCount(c.env, session.accountId);
  } catch (e) {
    if (e instanceof ChainUnreachable) return unreachable(c);
    throw e;
  }
  const fields = await ownerFields(c.env, id, pet, (await pauseReason(c.env.DB)) !== null);
  return c.json({ viewer: 'owner', ...base, ...fields, ownedCount: owned });
});

// The signed-in player: the pet they hatched, the one they have now, how many they own.
petRoutes.get('/api/me', async (c) => {
  const session = requireSession(c);
  if (session instanceof Response) return session;
  try {
    const [hatch, owned] = await Promise.all([hatchView(c.env, session.accountId), ownedCount(c.env, session.accountId)]);
    const hatchedPet = hatch.token_id === null ? null : await petView(c.env, hatch.token_id);
    const hatched = hatch.token_id !== null && hatchedPet !== null ? { tokenId: hatch.token_id, name: hatchedPet.name } : null;
    // Until `add-gift`, the current pet is the one the player hatched, if they still own it.
    const currentPet = hatched !== null && hatchedPet?.owner_id === session.accountId ? hatched : null;
    return c.json({ accountId: session.accountId, hatched, currentPet, ownedCount: owned });
  } catch (e) {
    if (e instanceof ChainUnreachable) return unreachable(c);
    throw e;
  }
});
