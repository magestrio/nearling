import { useEffect, useState } from 'react';

// The pet this tab just hatched: its first show on the Pet screen is its birth (`Birth flow` › «вылупился»). The tab's
// memory: a reload shows the pet standing.
let newborn: string | null = null;

export function markNewborn(tokenId: string): void {
  newborn = tokenId;
}

/** True for the first Pet screen of the pet this tab just hatched. */
export function useBirth(tokenId: string): boolean {
  const [birth] = useState(() => newborn === tokenId);
  useEffect(() => {
    if (newborn === tokenId) newborn = null;
  }, [tokenId]);
  return birth;
}
