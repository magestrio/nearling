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
  | { name: 'gift'; code: string }
  /** Diary screen: the ritual of the day, inside the Pet screen's own state (`add-daily-ritual` › `Diary screen`) */
  | { name: 'diary'; tokenId: string }
  /** Wardrobe screen: the pet's outfits, inside the Pet screen's own state (`add-wardrobe` › `Wardrobe screen`) */
  | { name: 'wardrobe'; tokenId: string }
  /** Adapter catalog screen: `/adapters`, or `/adapters?pet=<token_id>` from the skill of that pet (`add-pet-errands`) */
  | { name: 'adapters'; pet: string | null }
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
  const gift = /^\/gift\/([0-9a-f]{48})$/.exec(path);
  if (gift) return { name: 'gift', code: gift[1]! };
  if (path === '/gift' || path.startsWith('/gift/')) return { name: 'gift', code: '' };
  if (path === '/__day1') return { name: 'day1' };
  if (path === '/adapters') {
    const pet = url.searchParams.get('pet');
    return { name: 'adapters', pet: pet !== null && TOKEN_ID.test(pet) ? pet : null };
  }
  const pet = /^\/pet\/(\d{1,20})$/.exec(path);
  if (pet) return { name: 'pet', tokenId: pet[1]!, from: friend };
  const diary = /^\/pet\/(\d{1,20})\/diary$/.exec(path);
  if (diary) return { name: 'diary', tokenId: diary[1]! };
  const wardrobe = /^\/pet\/(\d{1,20})\/wardrobe$/.exec(path);
  if (wardrobe) return { name: 'wardrobe', tokenId: wardrobe[1]! };
  if (/^\/pet(\/[^/]*)?$/.test(path)) return { name: 'pet-broken' };
  return { name: 'unknown' };
}

export const petPath = (tokenId: string, from?: string | null) => `/pet/${tokenId}${from ? `?from=${from}` : ''}`;
export const diaryPath = (tokenId: string) => `/pet/${tokenId}/diary`;
export const wardrobePath = (tokenId: string) => `/pet/${tokenId}/wardrobe`;
export const adaptersPath = (pet?: string | null) => `/adapters${pet ? `?pet=${pet}` : ''}`;
export const hatchPath =(from?: string | null) => `/hatch${from ? `?from=${from}` : ''}`;
