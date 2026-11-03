// Memory deletion (`Memory deletion data`): everything a pet's words live in, erased in one batch.
// What stays is the receipt of each thought: its price, model, hashes and signature, so the food,
// the debit of an unbilled session and `Receipt index data` read the rows as before.
//
// `forgetStatements` is the list the later changes add to (the ritual, the pet's life, the hire
// and the work record, the wardrobe): one `DB.batch`, whole or nothing.

/** The result a queued job ends with when the memory it was to speak from is gone. */
export const MEMORY_CLEARED = { code: 'memory_cleared' } as const;

export function forgetStatements(db: D1Database, tokenId: string, now: number): D1PreparedStatement[] {
  return [
    // The epoch tells a thought on its way that its words are not wanted (`eraseIfCleared`). A pet
    // the server has no row of has nothing in flight, but still must not greet again.
    db
      .prepare("INSERT INTO pets (token_id, hatched_by, born_at, birth_tx, memory_epoch) VALUES (?1, '', ?2, '', 1) ON CONFLICT (token_id) DO UPDATE SET memory_epoch = memory_epoch + 1")
      .bind(tokenId, now),
    // In SQL every right-hand side reads the row as it was: `erased_at` sees the words about to go.
    db
      .prepare('UPDATE thoughts SET erased_at = CASE WHEN player_text IS NOT NULL OR reply_text IS NOT NULL THEN ?1 ELSE erased_at END, player_text = NULL, reply_text = NULL WHERE token_id = ?2')
      .bind(now, tokenId),
    db.prepare("UPDATE thought_calls SET req_bytes = x'', res_bytes = x'' WHERE thought_id IN (SELECT id FROM thoughts WHERE token_id = ?)").bind(tokenId),
    // A line waiting in the queue and the friend's name of a wake thought: no word stays in a job.
    db.prepare("UPDATE jobs SET status = 'failed', result = ? WHERE token_id = ? AND status = 'queued'").bind(JSON.stringify(MEMORY_CLEARED), tokenId),
    db.prepare('UPDATE jobs SET payload = NULL WHERE token_id = ?').bind(tokenId),
    db.prepare('DELETE FROM memory_notes WHERE token_id = ?').bind(tokenId),
    // The owner's answers to the riddle are memory too; the day's marks stay (`ritual_days`), so a second
    // answer the same day is still refused (`Ritual data` › «удаление памяти»).
    db.prepare('DELETE FROM riddle_answers WHERE token_id = ?').bind(tokenId),
    // The name of the friend who woke the pet is memory too (`wake_by`); the counter stays.
    db.prepare('UPDATE pets SET wake_by = NULL WHERE token_id = ?').bind(tokenId),
    // The skill goes in the same batch (`Skill data` › «удаление памяти»), and so do the Manual offer standing
    // and what the pet's work recorded (names and amounts of its hirers). What stays holds no words: the day's
    // count of answers (`worker_answers`) and the hire mode (`hire_modes`), the hires' prices and receipts.
    db.prepare('DELETE FROM skills WHERE token_id = ?').bind(tokenId),
    db.prepare('DELETE FROM hire_offers WHERE token_id = ?').bind(tokenId),
    db.prepare('DELETE FROM work_records WHERE worker_id = ?').bind(tokenId),
  ];
}

/** The last statements of a thought's own batch: when the pet's memory was cleared since `epoch` was
 * read, the words and the bytes of this thought go the same way, and its receipt stays. Inside the
 * thought's batch, so a clear lands wholly before or wholly after. */
export function eraseIfCleared(db: D1Database, tokenId: string, thoughtId: string, epoch: number, now: number): D1PreparedStatement[] {
  const cleared = '(SELECT memory_epoch FROM pets WHERE token_id = ?2) <> ?3';
  return [
    db
      .prepare(
        `UPDATE thoughts SET erased_at = CASE WHEN player_text IS NOT NULL OR reply_text IS NOT NULL THEN ?4 ELSE erased_at END, player_text = NULL, reply_text = NULL WHERE id = ?1 AND ${cleared}`,
      )
      .bind(thoughtId, tokenId, epoch, now),
    db
      .prepare(`UPDATE thought_calls SET req_bytes = x'', res_bytes = x'' WHERE thought_id = ?1 AND ${cleared}`)
      .bind(thoughtId, tokenId, epoch),
  ];
}

/** How many times the pet's memory has been cleared (0 for a pet never cleared or never stored). */
export async function memoryEpoch(db: D1Database, tokenId: string): Promise<number> {
  const row = await db.prepare('SELECT memory_epoch FROM pets WHERE token_id = ?').bind(tokenId).first<{ memory_epoch: number }>();
  return row?.memory_epoch ?? 0;
}
