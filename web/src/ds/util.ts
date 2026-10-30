import { useSyncExternalStore } from 'react';

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

/** `var(--space-n)`; undefined when no step is given. */
export function gap(n: number | undefined): string | undefined {
  return n == null ? undefined : `var(--space-${n})`;
}

/** The viewport the DS's breakpoint puts us in (components.css sets --ds-viewport on :root, from the same 768px
 *  media query this reads). */
const DESKTOP = '(min-width: 768px)';

export function isDesktop(): boolean {
  return window.matchMedia(DESKTOP).matches;
}

function subscribe(onChange: () => void): () => void {
  const query = window.matchMedia(DESKTOP);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

/** isDesktop that re-renders when the viewport crosses the breakpoint (a rotation, a resize, a zoom). */
export function useIsDesktop(): boolean {
  return useSyncExternalStore(subscribe, isDesktop, () => false);
}
