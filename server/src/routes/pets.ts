// GET /api/pets/:id and GET /api/me.
import { Hono } from 'hono';
import { ChainUnreachable, ownedCount, petView, stageOf, type PetRecord } from '../chain';
import { currentPet, lastGiftedPet, ownedPets, selectCurrentPet } from '../gift/current';
import { requireSession, TOKEN_ID, type AppEnv } from '../http';
import { wornOf } from '../pet/outfits';
import { fullnessOf, moodFor, ownerFields } from '../pet/view';
import { pauseReason } from '../servicePause';
import { skillLabel } from '../work/skill';
import { syncedWatch } from '../watch/target';

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

  const state = await fullnessOf(c.env.DB, id, pet);
  const watched = await syncedWatch(c.env.DB, id, pet);
  // The model's stage and the face's mood go to everyone; the stage as a word, the traits and the
  // energy only to the owner (`Pet life display rule`). The worn item and the skill's label go to everyone, read
  // from D1 on each request (`Outfit rule`, `Skill data` › «the label for any viewer»): the shared copy holds only
  // the chain's record. The instruction, its length and its ciphertext are in no answer of this route.
  const base = {
    tokenId: id,
    name: pet.name,
    stage: stageOf(pet),
    fullness: state,
    mood: await moodFor(c.env.DB, id, state.state, Date.now()),
    worn: await wornOf(c.env.DB, id),
    skill: await skillLabel(c.env.DB, id),
    watch: watched === null ? null : { target: watched.target, kind: watched.kind },
  };
  if (session === null) return c.json({ viewer: 'visitor', ...base });
  // The player's own meal or snack on its way for this pet, nobody else's (`Feeding transaction data` ›
  // «outcome with the sheet closed»): a reloaded tab starts to watch its outcome from this.
  const mine = await c.env.DB.prepare('SELECT id, source FROM feedings WHERE account = ? AND token_id = ?').bind(session.accountId, id).first<{ id: string; source: string }>();
  const myFeed = mine === null ? null : { id: mine.id, source: mine.source };
  if (pet.owner_id !== session.accountId) return c.json({ viewer: 'guest', ...base, myFeed });

  await selectCurrentPet(c.env, session.accountId, id);

  let owned: number;
  try {
    owned = await ownedCount(c.env, session.accountId);
  } catch (e) {
    if (e instanceof ChainUnreachable) return unreachable(c);
    throw e;
  }
  const fields = await ownerFields(c.env, id, pet, (await pauseReason(c.env.DB)) !== null);
  return c.json({ viewer: 'owner', ...base, ...fields, ownedCount: owned, myFeed });
});

// The signed-in player: the pet they hatched, the one they have now, how many they own.
petRoutes.get('/api/me', async (c) => {
  const session = requireSession(c);
  if (session instanceof Response) return session;
  try {
    const { pets, hatched } = await ownedPets(c.env, session.accountId);
    const current = await currentPet(c.env, session.accountId, pets);
    const lastGifted = pets.length === 0 && hatched !== null ? await lastGiftedPet(c.env, session.accountId) : null;
    return c.json({ accountId: session.accountId, hatched: hatched === null ? null : { tokenId: hatched.tokenId, name: hatched.name },
      currentPet: current === null ? null : { tokenId: current.tokenId, name: current.name }, ownedCount: pets.length,
      ...(lastGifted === null ? {} : { lastGifted: { tokenId: lastGifted.tokenId, name: lastGifted.name } }) });
  } catch (e) {
    if (e instanceof ChainUnreachable) return unreachable(c);
    throw e;
  }
});

petRoutes.get('/api/me/pets', async (c) => {
  const session = requireSession(c);
  if (session instanceof Response) return session;
  try {
    const { pets } = await ownedPets(c.env, session.accountId);
    return c.json({ pets, currentPet: await currentPet(c.env, session.accountId, pets) });
  } catch (e) {
    if (e instanceof ChainUnreachable) return unreachable(c);
    throw e;
  }
});
