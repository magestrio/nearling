// The Pet screen a player is led back to from the catalog opens Skill sheet (`Adapter catalog screen`: «Back to {name}» returns to its
// Pet screen with Skill sheet open; a saved connect lands there with «Connected. …»). The catalog page leaves the note here, in the
// tab's memory, and the Pet screen of that pet takes it once, when its owner view is first drawn. A reload loses it, as it loses every
// sheet: the page then opens as it always does.
let held: { tokenId: string; line?: string } | null = null;

export function holdSkillArrival(tokenId: string, line?: string): void {
  held = { tokenId, ...(line !== undefined ? { line } : {}) };
}

/** The note for the page of `tokenId`, once; a note for another pet is dropped. */
export function takeSkillArrival(tokenId: string): { line?: string } | null {
  const note = held;
  held = null;
  if (note === null || note.tokenId !== tokenId) return null;
  return note.line !== undefined ? { line: note.line } : {};
}
