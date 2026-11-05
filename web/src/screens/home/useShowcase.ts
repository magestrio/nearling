import { useEffect, useState } from 'react';
import { workerApi, type ShowcaseCopy } from '../../seams/worker';

export type ShowcaseState = { kind: 'loading' } | { kind: 'unavailable' } | { kind: 'ready'; copy: ShowcaseCopy };

// The public meadow settles independently of sign-in admission and the player's session.
export function useShowcase(enabled = true): ShowcaseState {
  const [state, setState] = useState<ShowcaseState>({ kind: 'loading' });
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    workerApi.showcase().then((copy) => {
      if (live) setState(copy.pets.length && copy.numbers ? { kind: 'ready', copy } : { kind: 'unavailable' });
    }).catch(() => { if (live) setState({ kind: 'unavailable' }); });
    return () => { live = false; };
  }, [enabled]);
  return state;
}
