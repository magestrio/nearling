// Memory deletion (`Memory deletion data`): everything a pet's words live in, erased in one batch.
// What stays is the receipt of each thought: its price, model, hashes and signature, so the food,
// the debit of an unbilled session and `Receipt index data` read the rows as before.
//
// `forgetStatements` is the list the later changes add to (the ritual, the pet's life, the hire
// and the work record, the wardrobe): one `DB.batch`, whole or nothing.
import { clearDebateStatements } from '../debates/cancel';

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
    db.prepare('UPDATE receipt_links SET revoked_at = ?1 WHERE paying_token_id = ?2 AND revoked_at IS NULL').bind(now, tokenId),
    ...clearDebateStatements(db, tokenId, now),
    db.prepare("UPDATE thought_calls SET req_bytes = x'', res_bytes = x'' WHERE thought_id IN (SELECT id FROM thoughts WHERE token_id = ?)").bind(tokenId),
    // An errand that came back without a report goes, and so does one whose job has not started (nothing was spent,
    // nothing is on its way); one away keeps its row, without its words, so it still ends or times out
    // (`Errand flow` › «memory cleared on the way»). Before the queued jobs are failed below, which they read.
    db
      .prepare("DELETE FROM errands WHERE token_id = ?1 AND (state <> 'away' OR EXISTS (SELECT 1 FROM jobs WHERE token_id = ?1 AND kind = 'errand' AND status = 'queued'))")
      .bind(tokenId),
    db.prepare('UPDATE errands SET job = NULL WHERE token_id = ?').bind(tokenId),
    // A line waiting in the queue and the friend's name of a wake thought: no word stays in a job.
    db.prepare("UPDATE jobs SET status = 'failed', result = ? WHERE token_id = ? AND status = 'queued'").bind(JSON.stringify(MEMORY_CLEARED), tokenId),
    db.prepare('UPDATE jobs SET payload = NULL WHERE token_id = ?').bind(tokenId),
    db.prepare('DELETE FROM memory_notes WHERE token_id = ?').bind(tokenId),
    // Active and staged experience, its approvals and its public field vanish in the same batch.
    // The on-chain counts and billed receipt pointers are deliberately outside pet memory.
    db.prepare('DELETE FROM experience_field WHERE token_id = ?').bind(tokenId),
    db.prepare('DELETE FROM experience_notes WHERE token_id = ?').bind(tokenId),
    // Society is directed: clear this pet's side and pending social words, never the
    // counterparty's own side. Processed hire markers remain to prevent replay.
    db.prepare('DELETE FROM society_relations WHERE token_id = ?').bind(tokenId),
    db.prepare('DELETE FROM society_encounters WHERE token_id = ?').bind(tokenId),
    db.prepare('DELETE FROM society_diary_lines WHERE token_id = ?').bind(tokenId),
    db.prepare('DELETE FROM pet_wishes WHERE token_id = ?').bind(tokenId),
    db.prepare('DELETE FROM will_operations WHERE token_id = ?').bind(tokenId),
    db.prepare('DELETE FROM will_diary_lines WHERE token_id = ?').bind(tokenId),
    db.prepare('DELETE FROM will_refusals WHERE payer_token = ? OR worker_token = ?').bind(tokenId, tokenId),
    db.prepare('DELETE FROM work_invitations WHERE sender_token = ? OR recipient_token = ?').bind(tokenId, tokenId),
    // No invitation survives a confirmed clear, including one addressed to this pet.
    db.prepare("UPDATE work_invitations SET status = 'expired' WHERE status = 'open' AND (sender_token = ? OR recipient_token = ?)")
      .bind(tokenId, tokenId),
    // The owner's answers to the riddle are memory too; the day's marks stay (`ritual_days`), so a second
    // answer the same day is still refused (`Ritual data` › «удаление памяти»).
    db.prepare('DELETE FROM riddle_answers WHERE token_id = ?').bind(tokenId),
    // The name of the friend who woke the pet is memory too (`wake_by`); the counter stays.
    db.prepare('UPDATE pets SET wake_by = NULL, wake_source = NULL WHERE token_id = ?').bind(tokenId),
    // The skill goes in the same batch (`Skill data` › «удаление памяти»), and so do the Manual offer standing
    // and what the pet's work recorded (names and amounts of its hirers). What stays holds no words: the day's
    // count of answers (`worker_answers`) and the hire mode (`hire_modes`), the hires' prices and receipts.
    db.prepare('DELETE FROM skills WHERE token_id = ?').bind(tokenId),
    db.prepare('DELETE FROM hire_offers WHERE token_id = ?').bind(tokenId),
    db.prepare('DELETE FROM work_records WHERE worker_id = ?').bind(tokenId),
    // A skill's data sources and code go with it, and so do the pet's entries in the catalog
    // (`Data source data` › «memory cleared»). Copies in other pets' skills keep their own sealed address.
    // The day's test-run count stays, so clearing memory cannot renew the 20-run allowance;
    // the game-wide count of loaded versions is no pet's memory.
    db.prepare('DELETE FROM data_sources WHERE token_id = ?').bind(tokenId),
    db.prepare('DELETE FROM catalog_entries WHERE token_id = ?').bind(tokenId),
    db.prepare('DELETE FROM skill_code WHERE token_id = ?').bind(tokenId),
    // The link owns contributor access; its delete trigger removes every sponsor in this batch.
    // Receipts and the word-free close recovery live outside pet memory.
    db.prepare('DELETE FROM shared_errands WHERE token_id = ?').bind(tokenId),
    db.prepare('DELETE FROM watch_targets WHERE token_id = ?').bind(tokenId),
    db.prepare('UPDATE watch_checks SET pending_content = NULL, pending_sources = NULL, pending_result = NULL WHERE token_id = ?').bind(tokenId),
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
