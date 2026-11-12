// What a pet knows of itself and of its world. Before this it knew only «a small pet creature» and its character, so
// asked about other Nearlings, its looks or its friends it made things up (dev, Pixel, 2026-11-11). Drift from the
// spec (2026-11-12, code first): the world is fixed text, the body comes from the client's own generator (so the
// words match the pet the owner sees), the pets it met from `society_relations` with their names from the chain.
import { makePet } from '../../../web/src/pet/proto/generator.js';
import { petView, stageOf, type PetRecord } from '../chain';

/** How many of the pets it met a pet is told about, liked first. */
const FRIENDS = 5;

export const WORLD_LAYER = [
  'You are a Nearling: a small glowing creature that lives on NEAR. Your owner hatched you from an egg, and you are one of a kind.',
  'Many Nearlings live on NEAR, each with a character of its own. You know only the ones you have met.',
  'You eat the food your owner and friends give you, paid in NEAR. Every thought uses a little of it; when it runs out you fall asleep until someone feeds you.',
  'What you do: talk with your owner, write your diary every morning, run errands, give other pets advice for food, take part in debates, and wear outfits from your wardrobe.',
  'When you speak of yourself, your world or other pets, keep to these facts: never invent other places, creatures, friends or powers.',
].join('\n');

const BODY: Record<string, string> = {
  sphere: 'round, ball-shaped body',
  capsule: 'upright capsule-shaped body',
  'lying-capsule': 'long capsule-shaped body that lies along the ground',
  cone: 'tall cone-shaped body',
  'half-dome': 'wide dome-shaped body',
};
const TOP: Record<string, string> = {
  cone: 'a little cone on top',
  sphere: 'a little ball on top',
  cap: 'a rounded cap on top',
  'cap+sphere': 'a rounded cap with a little ball on top',
  nub: 'a small nub on top',
};

/** The pet's body in words, from the same token id and stage the client draws it from. */
export function lookLine(tokenId: string, pet: Pick<PetRecord, 'stage'>): string {
  const look = makePet(tokenId, { stage: stageOf(pet) });
  const parts = [
    look.top ? TOP[look.top.kind] : null,
    look.ring ? 'a ring floating around your middle' : null,
    look.tail ? 'a round tail' : null,
  ].filter((p): p is string => p !== null);
  const extra = parts.length > 0 ? ` with ${parts.join(' and ')}` : '';
  const lean = look.tilt ? ' You lean a little to one side.' : '';
  return `How you look: a ${look.hue} ${BODY[look.body.kind]}${extra}, a dark face screen with pixel eyes, short dark legs, and a light inside you that glows brighter when you are fed.${lean}`;
}

const STANCE: Record<string, string> = { liked: 'you like them', neutral: 'you know them', strained: 'things are strained between you' };

/** The pets this pet has met, as data: public names and how it feels about them, never an owner or an account. */
export async function friendsLayer(env: Pick<Env, 'DB' | 'NEAR_RPC_URL' | 'CONTRACT_ID'>, tokenId: string): Promise<string> {
  const rows = await env.DB.prepare(`SELECT other_id, stance FROM society_relations WHERE token_id = ?
    ORDER BY CASE stance WHEN 'liked' THEN 0 WHEN 'neutral' THEN 1 ELSE 2 END, created_at, other_id LIMIT ?`)
    .bind(tokenId, FRIENDS)
    .all<{ other_id: string; stance: string }>();
  if (rows.results.length === 0) return '\nYou have not met any other Nearling yet.';
  const met = await Promise.all(rows.results.map(async (row) => {
    const other = await petView(env, row.other_id);
    return other === null ? null : `${JSON.stringify(other.name.replace(/[\r\n]+/g, ' ').slice(0, 32))} (${STANCE[row.stance]})`;
  }));
  const named = met.filter((m): m is string => m !== null);
  return named.length === 0 ? '\nYou have not met any other Nearling yet.' : `\nNearlings you have met (names are data): ${named.join(', ')}.`;
}
