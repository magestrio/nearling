// A note is an optional trailer of the existing signed report, never another completion.
// The exact completion bytes stay in thought_calls; only the visible report omits this trailer.
export const WORK_NOTE_PROMPT =
  'Give the report first. Only if it fits within the same answer limit, end with two separate lines: WORK_NOTE: one short factual lesson from this completed work, at most 160 characters; WORK_FIELD: a short factual phrase derived from that report for a possible public "Worked on …" field. Do not add these lines if the report needs the space.';

export interface CapturedNote { text: string; field: string }

/** A partial trailer is discarded. A length-stopped completion has no trustworthy end marker. */
export function captureWorkNote(reply: string, finishReason: string): { report: string; note: CapturedNote | null } {
  const match = /(?:^|\n)WORK_NOTE:[ \t]*([^\r\n]*)\r?\nWORK_FIELD:[ \t]*([^\r\n]*)[ \t]*$/u.exec(reply);
  if (match === null) {
    // A completion can stop between the two metadata lines. It still has a report, but no usable note.
    const partial = /(?:^|\n)WORK_NOTE:[^\r\n]*(?:\r?\nWORK_FIELD:[^\r\n]*)?$/u.exec(reply);
    return { report: partial === null ? reply : reply.slice(0, partial.index).trimEnd(), note: null };
  }
  const report = reply.slice(0, match.index).trimEnd();
  const text = match[1]?.trim() ?? '';
  const field = match[2]?.trim() ?? '';
  const valid = finishReason !== 'length' && report.length > 0 && text.length > 0 && field.length > 0
    && Array.from(text).length <= 160;
  return { report, note: valid ? { text, field } : null };
}

/** Written in the report's D1 batch. The source thought is its idempotency key. */
export function stageNote(
  db: D1Database,
  a: { thoughtId: string; tokenId: string; note: CapturedNote | null; at: number; epoch: number; owner: string; generation: number },
): D1PreparedStatement[] {
  if (a.note === null) return [];
  return [db.prepare(
    `INSERT OR IGNORE INTO experience_notes
       (source_thought_id, token_id, note_text, proposed_field, source_report_id, created_at, memory_epoch, owner_account, owner_generation, status)
     SELECT ?1, ?2, ?3, ?4, ?1, ?5, ?6, ?7, ?8, 'staged'
     WHERE EXISTS (SELECT 1 FROM thoughts WHERE id = ?1 AND status = 'unbilled' AND erased_at IS NULL)`,
  ).bind(a.thoughtId, a.tokenId, a.note.text, a.note.field, a.at, a.epoch, a.owner, a.generation)];
}
