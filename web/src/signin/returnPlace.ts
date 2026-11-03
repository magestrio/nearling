// ADR-001 › Action item 4: Privy gets only the home address `/` as the return address; the place the tab was at — its
// path with the query, the action the player tapped, and, for a sign-in from the ended-session line, the text typed in the
// field — waits in sessionStorage (add-pet › Sign-in return; add-account › Sign-in return data). After sign-in the client
// leads the tab back to it. The text never leaves the browser: Privy gets `/`, the link to a real browser has no place
// for it. The record lives in one tab only, for the time of a sign-in.
const KEY = 'nearling.returnPlace';

export interface ReturnPlace {
  /** the path with its query, e.g. `/hatch?from=2` */
  path: string;
  /** what the player tapped: «Sign in», «Feed {name}» (passed to the feeding slot), or the line of Skill sheet's ended session
   *  (the sheet opens again, `Skill writing flow` › «sheet after sign-in») */
  action?: 'signin' | 'feed' | 'skill';
  /** the text that was in the field when the session ended, for the time of the sign-in */
  text?: string;
  /** the record a cancel (or a failed sign-in) rewrote: the place and the action stay, the text is gone. It is what survives
   *  the full load of a Back from Google, which a value in memory would not. */
  cancelled?: boolean;
}

/** Where a sign-in began, for the events: `link` — on a pet's or a gift's address, `home` — anywhere else. */
export function fromOf(path: string): 'link' | 'home' {
  return /^\/(?:pet|gift)\//.test(path) ? 'link' : 'home';
}

function parse(raw: string | null): ReturnPlace | null {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null || !('path' in value) || typeof value.path !== 'string' || !value.path.startsWith('/')) return null;
    const action = 'action' in value && (value.action === 'signin' || value.action === 'feed' || value.action === 'skill') ? value.action : undefined;
    const text = 'text' in value && typeof value.text === 'string' && value.text !== '' ? value.text : undefined;
    const cancelled = 'cancelled' in value && value.cancelled === true;
    return { path: value.path, ...(action ? { action } : {}), ...(text !== undefined ? { text } : {}), ...(cancelled ? { cancelled } : {}) };
  } catch {
    return null;
  }
}

function read(): string | null {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

function erase(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // storage blocked: there is nothing to erase
  }
}

/** The text a return handed back, for the screen at its path to take once (`takeReturnText`). A value of the tab's memory. */
let held: { path: string; text: string } | null = null;

/** A tap called `login()` and has had no answer yet: Privy is loading, or Google is starting and the page has not left. The
 *  address can be `/` with the place still on the screen then, so a second tap must not read it, and `/` is no Back from
 *  Google. A value of the tab's memory: a load, which is what a Back from Google is, starts without it. */
let underWay = false;

export function signInUnderWay(): boolean {
  return underWay;
}

export function markSignInUnderWay(on: boolean): void {
  underWay = on;
}

export function rememberReturnPlace(place: ReturnPlace | string): void {
  const value: ReturnPlace = typeof place === 'string' ? { path: place } : place;
  held = null;
  heldSkill = null;
  try {
    sessionStorage.setItem(KEY, JSON.stringify(value));
  } catch {
    // storage blocked: the page just stays at `/`
  }
}

/** The remembered place, left where it is. */
export function peekReturnPlace(): ReturnPlace | null {
  return parse(read());
}

/** The remembered place, once: reading it clears it. */
export function takeReturnPlace(): ReturnPlace | null {
  const place = parse(read());
  erase();
  return place;
}

/** Nothing is remembered: the place, and the text on its way back, are gone (a tap on Home, a sign-out). */
export function clearReturnPlace(): void {
  erase();
  held = null;
  heldSkill = null;
}

/** A sign-in that never came back (the player typed another address at Google) leaves its record in the tab. The next start
 *  of the app on `here`, an address other than `/`, erases it — and the text in it — unless it is the record of a cancel for
 *  that same address, which a Back from Google needs. */
export function eraseLeftBehind(here: string): void {
  const record = parse(read());
  if (record && !(record.cancelled && record.path === here)) clearReturnPlace();
}

/** `ReturnToPlace` keeps the text of the record it took for the path it leads the tab to. */
export function holdReturnText(path: string, text: string): void {
  held = { path, text };
}

/** Both fields of Skill sheet, as typed (`{ label, instruction }` as JSON text in the record), for the sheet that opens again. Never
 *  the owner's line: a return with the action `skill` hands its text here and not to `takeReturnText`. */
let heldSkill: { path: string; fields: { label: string; instruction: string } } | null = null;

export function holdReturnSkill(path: string, text: string): void {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value === 'object' && value !== null && 'label' in value && 'instruction' in value && typeof value.label === 'string' && typeof value.instruction === 'string') {
      heldSkill = { path, fields: { label: value.label, instruction: value.instruction } };
    }
  } catch {
    // a record that is not both fields brings nothing back
  }
}

/** The fields a return handed back to the sheet at `path`, once. */
export function takeReturnSkill(path: string): { label: string; instruction: string } | null {
  if (heldSkill === null || heldSkill.path !== path) return null;
  const { fields } = heldSkill;
  heldSkill = null;
  return fields;
}

/** The screen at `path` calls it once its view is decided. A screen with the field gives the text back, unsent; one without
 *  takes it and drops it unseen. Taking it leaves nothing behind. */
export function takeReturnText(path: string): string | null {
  if (held === null || held.path !== path) return null;
  const { text } = held;
  held = null;
  return text;
}
