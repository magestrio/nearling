import { useLayoutEffect, type RefObject } from 'react';

/** What an action just made, scrolled into view inside its sheet's body: its bottom to the body's bottom (the sheet's foot stays
 *  where it is). DS 0.29 · design/ds/components.js › useReveal. */
export function useReveal(ref: RefObject<HTMLElement | null>, on: boolean | undefined): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!on || !el) return;
    const body = el.closest('.ds-sheet__body');
    if (!body) return;
    const below = el.getBoundingClientRect().bottom - body.getBoundingClientRect().bottom;
    if (below > 0) body.scrollTop += below;
  }, [ref, on]);
}
