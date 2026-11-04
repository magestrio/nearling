import { allTokenIdsOf, hatchView, petView } from '../chain';

export interface OwnedPet {
  tokenId: string;
  name: string;
  born: boolean;
}

/** The chain owns the list; D1 remembers only the player's choice. */
export async function ownedPets(env: Env, accountId: string): Promise<{ pets: OwnedPet[]; hatched: OwnedPet | null }> {
  const [ids, birth] = await Promise.all([allTokenIdsOf(env, accountId), hatchView(env, accountId)]);
  const records = await Promise.all(ids.map(async (tokenId) => ({ tokenId, pet: await petView(env, tokenId) })));
  const pets = records
    .filter((item): item is { tokenId: string; pet: NonNullable<typeof item.pet> } => item.pet !== null && item.pet.owner_id === accountId)
    .map(({ tokenId, pet }) => ({ tokenId, name: pet.name, born: tokenId === birth.token_id }));
  pets.sort((a, b) => Number(b.born) - Number(a.born) || a.name.localeCompare(b.name) || a.tokenId.localeCompare(b.tokenId));
  const born = birth.token_id === null ? null : await petView(env, birth.token_id);
  return { pets, hatched: born === null || birth.token_id === null ? null : { tokenId: birth.token_id, name: born.name, born: true } };
}

export async function currentPet(env: Env, accountId: string, pets: OwnedPet[]): Promise<OwnedPet | null> {
  const row = await env.DB.prepare('SELECT current_pet FROM players WHERE account_id = ? ORDER BY created_at DESC LIMIT 1')
    .bind(accountId).first<{ current_pet: string | null }>();
  const current = pets.find((pet) => pet.tokenId === row?.current_pet);
  if (current !== undefined) return current;
  const fallback = pets[0] ?? null;
  if ((row?.current_pet ?? null) !== (fallback?.tokenId ?? null)) {
    await env.DB.prepare('UPDATE players SET current_pet = ? WHERE account_id = ?').bind(fallback?.tokenId ?? null, accountId).run();
  }
  return fallback;
}

export async function selectCurrentPet(env: Env, accountId: string, tokenId: string): Promise<void> {
  await env.DB.prepare('UPDATE players SET current_pet = ? WHERE account_id = ?').bind(tokenId, accountId).run();
}

export async function lastGiftedPet(env: Env, accountId: string): Promise<OwnedPet | null> {
  const row = await env.DB.prepare('SELECT last_gifted_pet FROM players WHERE account_id = ? ORDER BY created_at DESC LIMIT 1')
    .bind(accountId).first<{ last_gifted_pet: string | null }>();
  if (row?.last_gifted_pet == null) return null;
  const pet = await petView(env, row.last_gifted_pet);
  return pet === null ? null : { tokenId: row.last_gifted_pet, name: pet.name, born: false };
}
