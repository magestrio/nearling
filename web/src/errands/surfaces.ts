import { useEffect, useSyncExternalStore } from 'react';

// The four surfaces of add-pet-errands the New outfit notice waits for (Errand sheet, Adapter sheet, Skill code sheet, Verdict card):
// each marks itself while it is open, and `useNotice` reads whether any is. The Diary's self-open needs no mark — it already waits for
// any dialog on the page.
let open = 0;
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((l) => l());
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

/** The surface that calls this stands while `on` is true. */
export function useMarkErrandSurface(on: boolean): void {
  useEffect(() => {
    if (!on) return undefined;
    open += 1;
    changed();
    return () => {
      open -= 1;
      changed();
    };
  }, [on]);
}

/** Errand sheet, Adapter sheet, Skill code sheet or Verdict card is open. */
export function useErrandSurfaceOpen(): boolean {
  return useSyncExternalStore(subscribe, () => open > 0);
}
