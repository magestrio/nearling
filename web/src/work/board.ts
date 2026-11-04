import type { HireBoard } from '../seams/worker-types';

/** A label search changes this tab's list only. Names, prices and status are never search keys. */
export function boardMatches(pets: HireBoard['pets'], query: string): HireBoard['pets'] {
  const needle = query.toLocaleLowerCase();
  return needle ? pets.filter((pet) => pet.label.toLocaleLowerCase().includes(needle)) : pets;
}
