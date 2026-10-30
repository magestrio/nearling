// ADR-001 › Action item 4: Privy gets only the home address `/` as the return address; the place the tab was at —
// its path with the query, and the action the player tapped — waits in sessionStorage (add-pet › Sign-in return;
// add-account › Sign-in return data owns the rest). After sign-in the client leads the tab back to it.
const KEY = 'nearling.returnPlace';

export interface ReturnPlace {
  /** the path with its query, e.g. `/hatch?from=2` */
  path: string;
  /** what the player tapped: «Sign in», or «Feed {name}» (passed to the feeding slot) */
  action?: 'signin' | 'feed';
}

export function rememberReturnPlace(place: ReturnPlace | string): void {
  const value: ReturnPlace = typeof place === 'string' ? { path: place } : place;
  try {
    sessionStorage.setItem(KEY, JSON.stringify(value));
  } catch {
    // storage blocked: the page just stays at `/`
  }
}

/** The remembered place, once: reading it clears it. */
export function takeReturnPlace(): ReturnPlace | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (raw === null) return null;
    sessionStorage.removeItem(KEY);
    const value: unknown = JSON.parse(raw);
    if (typeof value === 'object' && value !== null && 'path' in value && typeof value.path === 'string' && value.path.startsWith('/')) {
      const action = 'action' in value && (value.action === 'signin' || value.action === 'feed') ? value.action : undefined;
      return { path: value.path, ...(action ? { action } : {}) };
    }
    return null;
  } catch {
    return null;
  }
}
