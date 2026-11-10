import { petView } from '../chain';
import { fullnessOf } from './view';

export interface KnownPet {
  tokenId: string;
  name: string;
  asleep: boolean;
}

/** Private navigation pointers. Names and current state come from the public chain record. */
export async function knownPets(env: Env, account: string): Promise<KnownPet[]> {
  const rows = await env.DB.prepare('SELECT token_id FROM known_pets WHERE account_id = ? ORDER BY interacted_at DESC, token_id DESC')
    .bind(account).all<{ token_id: string }>();
  const pets = await Promise.all(rows.results.map(async ({ token_id }) => {
    const pet = await petView(env, token_id);
    if (pet === null) return null;
    return { tokenId: token_id, name: pet.name, asleep: (await fullnessOf(env.DB, token_id, pet)).state === 'asleep' };
  }));
  return pets.filter((pet): pet is KnownPet => pet !== null);
}
