/** These statements join the existing atomic Gift and Clear memory batches. */
export function giftDebateStatements(db: D1Database, tokenId: string, now: number, flightHash: string | null = null): D1PreparedStatement[] {
  const liveFlight = `(?3 IS NULL OR EXISTS (SELECT 1 FROM gift_flights WHERE token_id = ?1
    AND tx_hash = ?3 AND state IN ('prepared', 'sending', 'unknown')))`;
  return [
    db.prepare(`INSERT OR IGNORE INTO debate_ended_invites (id, first_pet, second_pet, reason, ended_at)
      SELECT id, first_pet, second_pet, 'gift', ?2 FROM debates
      WHERE status = 'invited' AND (first_pet = ?1 OR second_pet = ?1) AND ${liveFlight}`).bind(tokenId, now, flightHash),
    db.prepare(`DELETE FROM debates WHERE status = 'invited' AND (first_pet = ?1 OR second_pet = ?1)
      AND ${liveFlight}`).bind(tokenId, now, flightHash),
    db.prepare(`UPDATE debates SET status = 'gift', ended_at = ?2, lease_until = NULL
      WHERE status IN ('accepted', 'running') AND (first_pet = ?1 OR second_pet = ?1)
        AND ${liveFlight}`).bind(tokenId, now, flightHash),
    db.prepare(`DELETE FROM debate_lines WHERE debate_id IN
      (SELECT id FROM debates WHERE status = 'gift' AND (first_pet = ?1 OR second_pet = ?1))
      AND (status = 'pending' OR (status = 'receipt_pending' AND NOT EXISTS
        (SELECT 1 FROM debate_debit_operations op WHERE op.debate_id = debate_lines.debate_id
          AND op.line_order = debate_lines.line_order AND op.tx_hash IS NOT NULL)))
      AND ${liveFlight}`).bind(tokenId, now, flightHash),
  ];
}

export function clearDebateStatements(db: D1Database, tokenId: string, now: number): D1PreparedStatement[] {
  return [
    db.prepare(`INSERT OR IGNORE INTO debate_ended_invites
      (id, first_pet, second_pet, reason, ended_at, share_hash, clear_during_line)
      SELECT id, first_pet, second_pet, 'cleared', ?2, share_hash,
        EXISTS (SELECT 1 FROM debate_lines WHERE debate_id = debates.id AND status IN ('pending', 'receipt_pending'))
      FROM debates
      WHERE first_pet = ?1 OR second_pet = ?1`).bind(tokenId, now),
    db.prepare('DELETE FROM debates WHERE first_pet = ? OR second_pet = ?').bind(tokenId, tokenId),
  ];
}
