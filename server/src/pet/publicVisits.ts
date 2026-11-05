// A public sample of pets known to have hatched. The full Showcase can reuse this source;
// no owner, memory or private skill field leaves it.
import { stageOf } from '../chain';
import { fullnessOf } from './view';
import { wornOf } from './outfits';

export interface PublicVisit {
  tokenId: string;
  name: string;
  stage: string;
  fullness: string;
  worn: string | null;
}

export async function publicVisits(env: Env): Promise<PublicVisit[] | null> {
  const rows = await env.DB.prepare('SELECT token_id FROM pets ORDER BY RANDOM() LIMIT 10').all<{ token_id: string }>();
  const sampled = await Promise.all(rows.results.map(async ({ token_id: tokenId }) => {
    const copy = await env.GUEST_VIEW.get(env.GUEST_VIEW.idFromName(`pet:${tokenId}`)).readPet(tokenId);
    if (!copy.ok) return { ok: false as const };
    if (copy.value === null) return { ok: true as const, visit: null };
    const pet = copy.value;
    return { ok: true as const, visit: { tokenId, name: pet.name, stage: stageOf(pet), fullness: (await fullnessOf(env.DB, tokenId, pet)).state, worn: await wornOf(env.DB, tokenId) } };
  }));
  if (sampled.some((result) => !result.ok)) return null;
  return sampled.flatMap((result) => result.ok && result.visit !== null ? [result.visit] : []);
}
