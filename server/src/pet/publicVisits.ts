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
  const visits: PublicVisit[] = [];
  for (const { token_id: tokenId } of rows.results) {
    const copy = await env.GUEST_VIEW.get(env.GUEST_VIEW.idFromName(`pet:${tokenId}`)).readPet(tokenId);
    if (!copy.ok) return null;
    if (copy.value === null) continue;
    const pet = copy.value;
    visits.push({ tokenId, name: pet.name, stage: stageOf(pet), fullness: (await fullnessOf(env.DB, tokenId, pet)).state, worn: await wornOf(env.DB, tokenId) });
  }
  return visits;
}
