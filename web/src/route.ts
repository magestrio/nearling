import { useSyncExternalStore } from 'react';

const EVENT = 'nearling:navigate';

function subscribe(onChange: () => void): () => void {
  window.addEventListener('popstate', onChange);
  window.addEventListener(EVENT, onChange);
  return () => {
    window.removeEventListener('popstate', onChange);
    window.removeEventListener(EVENT, onChange);
  };
}

/** The current path. The client has few routes; a router library is not worth a dependency yet. */
export function usePath(): string {
  return useSyncExternalStore(subscribe, () => window.location.pathname);
}

/** The current path with its query, e.g. `/hatch?from=2`. */
export function useLocation(): string {
  return useSyncExternalStore(subscribe, () => window.location.pathname + window.location.search);
}

/** Replaces the current history entry (the return after sign-in: the tab is where it began). */
export function navigate(path: string): void {
  window.history.replaceState(null, '', path);
  window.dispatchEvent(new Event(EVENT));
}

/** Loads the address afresh, replacing the history entry: a page restored from the back-forward cache has its old state in
 *  memory, and a full load is what drops it. */
export function replaceLocation(path: string): void {
  window.location.replace(path);
}

/** Follows a link inside the app: a new history entry, so Back works. */
export function go(path: string): void {
  window.history.pushState(null, '', path);
  window.dispatchEvent(new Event(EVENT));
}

export type Route =
  | { name: 'home' }
  | { name: 'hatch'; from: string | null }
  | { name: 'pet'; tokenId: string; from: string | null }
  /** `/pet` or `/pet/<x>` with no token_id in it: a cut or mangled link */
  | { name: 'pet-broken' }
  | { name: 'day1' }
  | { name: 'unknown' };

const TOKEN_ID = /^\d{1,20}$/;

/** `from` is the token_id of the friend's pet the player came from (`/hatch?from=2`, and back to `/pet/9?from=2`);
 *  anything that is not a token_id is no pet. */
export function parseRoute(location: string): Route {
  const url = new URL(location, 'http://local');
  const from = url.searchParams.get('from');
  const friend = from !== null && TOKEN_ID.test(from) ? from : null;
  const path = url.pathname.replace(/\/+$/, '') || '/';
  if (path === '/') return { name: 'home' };
  if (path === '/hatch') return { name: 'hatch', from: friend };
  if (path === '/__day1') return { name: 'day1' };
  const pet = /^\/pet\/(\d{1,20})$/.exec(path);
  if (pet) return { name: 'pet', tokenId: pet[1]!, from: friend };
  if (/^\/pet(\/[^/]*)?$/.test(path)) return { name: 'pet-broken' };
  return { name: 'unknown' };
}

export const petPath = (tokenId: string, from?: string | null) => `/pet/${tokenId}${from ? `?from=${from}` : ''}`;
export const hatchPath = (from?: string | null) => `/hatch${from ? `?from=${from}` : ''}`;
