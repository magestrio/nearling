import { useEffect, useState } from 'react';

// The pet this tab just hatched: its first show on the Pet screen is its birth (`Birth flow` › «вылупился»). The tab's
// memory: a reload shows the pet standing.
let newborn: string | null = null;

export function markNewborn(tokenId: string): void {
  newborn = tokenId;
}

/** A sign-out leaves no pet of the player's in the tab (`Sign-out flow` › «вышел»). */
export function clearNewborn(): void {
  newborn = null;
}

/** True for the first Pet screen of the pet this tab just hatched. */
export function useBirth(tokenId: string): boolean {
  const [birth] = useState(() => newborn === tokenId);
  useEffect(() => {
    if (newborn === tokenId) newborn = null;
  }, [tokenId]);
  return birth;
}
