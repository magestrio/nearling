import type { ExperienceNotes } from '../seams/worker-types';

/** A pending response belongs to the same pet and current transfer generation. */
export function acceptsNotes(reply: ExperienceNotes, tokenId: string, generation: number | null): boolean {
  return reply.tokenId === tokenId && (generation === null || reply.generation === generation);
}

export function publishableNotes(reply: ExperienceNotes | null): ExperienceNotes['notes'] {
  return reply?.notes.filter((note) => note.approved) ?? [];
}
