// The riddle answer typed and not sent (`Ritual data` › «typed riddle answer»): `{ day, text }` in the tab's session memory, with
// the UTC day it was typed for. A reload in that day brings it back, a reload after it does not; sending, a sign-out and a gift of
// the pet erase it. It never goes in a request except as the send. Every access is guarded: a browser with storage blocked just
// has no draft.
const PREFIX = 'nearling.riddleDraft.';

export interface RiddleDraft {
  day: number;
  text: string;
}

const keyOf = (tokenId: string) => `${PREFIX}${tokenId}`;

function parse(raw: string | null): RiddleDraft | null {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null || !('day' in value) || !('text' in value)) return null;
    if (!Number.isInteger(value.day) || typeof value.text !== 'string' || value.text === '') return null;
    return { day: value.day as number, text: value.text };
  } catch {
    return null;
  }
}

/** The draft of this pet for `day`, the diary's. A draft of another day is removed and not returned. */
export function loadRiddleDraft(tokenId: string, day: number): RiddleDraft | null {
  try {
    const draft = parse(sessionStorage.getItem(keyOf(tokenId)));
    if (draft !== null && draft.day === day) return draft;
    sessionStorage.removeItem(keyOf(tokenId));
  } catch {
    // storage blocked: there is no draft to bring back
  }
  return null;
}

/** Keeps the draft; an empty one is no draft. */
export function saveRiddleDraft(tokenId: string, draft: RiddleDraft | null): void {
  try {
    if (draft === null || draft.text === '') sessionStorage.removeItem(keyOf(tokenId));
    else sessionStorage.setItem(keyOf(tokenId), JSON.stringify(draft));
  } catch {
    // storage blocked: the draft stays in the page's memory only
  }
}

export function eraseRiddleDraft(tokenId: string): void {
  saveRiddleDraft(tokenId, null);
}

/** Every pet's draft of this tab: a sign-out, and a gift of the pet (`Sign-out flow`). */
export function clearRiddleDrafts(): void {
  try {
    for (const key of Object.keys(sessionStorage)) if (key.startsWith(PREFIX)) sessionStorage.removeItem(key);
  } catch {
    // storage blocked: there is nothing to erase
  }
}
