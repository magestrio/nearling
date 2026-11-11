import { utcDay } from '../http';
import type { Reaction } from '../society/relations';

interface Completed {
  id: string;
  first_pet: string;
  second_pet: string;
  first_epoch: number;
  second_epoch: number;
  ended_at: number;
}

interface FinalLine {
  speaker_pet: string;
  social_reaction: Reaction | null;
}

/** A four-receipt outcome is claimed with its relationship writes in one D1 batch. */
export async function applyDebateOutcome(env: Env, id: string, now: number = Date.now()): Promise<void> {
  const debate = await env.DB.prepare("SELECT id, first_pet, second_pet, first_epoch, second_epoch, ended_at FROM debates WHERE id = ? AND status = 'completed'")
    .bind(id).first<Completed>();
  if (debate === null) return;
  const lines = (await env.DB.prepare("SELECT speaker_pet, social_reaction FROM debate_lines WHERE debate_id = ? AND status = 'settled' AND line_order IN (3, 4) ORDER BY line_order")
    .bind(id).all<FinalLine>()).results;
  if (lines.length !== 2) return;
  const attempt = crypto.randomUUID();
  const at = debate.ended_at ?? now;
  const day = utcDay(at);
  const source = `debate:${id}`;
  const claimed = 'EXISTS (SELECT 1 FROM society_processed_hires WHERE hire_id = ? AND attempt_id = ?)';
  const statements: D1PreparedStatement[] = [env.DB.prepare(`INSERT OR IGNORE INTO society_processed_hires (hire_id, attempt_id, settled_at)
    SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM debates d WHERE d.id = ? AND d.status = 'completed'
      AND (SELECT COUNT(*) FROM debate_lines l WHERE l.debate_id = d.id AND l.status = 'settled') = 4
      AND d.first_epoch = COALESCE((SELECT memory_epoch FROM pets WHERE token_id = d.first_pet), 0)
      AND d.second_epoch = COALESCE((SELECT memory_epoch FROM pets WHERE token_id = d.second_pet), 0))`)
    .bind(source, attempt, at, id)];

  for (const line of lines) {
    if (line.social_reaction === null) continue;
    const subject = line.speaker_pet;
    if (subject !== debate.first_pet && subject !== debate.second_pet) continue;
    const other = subject === debate.first_pet ? debate.second_pet : debate.first_pet;
    const reaction = line.social_reaction;
    statements.push(env.DB.prepare(`INSERT OR IGNORE INTO society_relations (token_id, other_id, created_at)
      SELECT ?, ?, ? WHERE ${claimed}`).bind(subject, other, at, source, attempt));
    const stance = reaction === 'respectful'
      ? "CASE WHEN stance = 'strained' THEN 'neutral' WHEN good_days >= 1 THEN 'liked' ELSE 'neutral' END"
      : "CASE WHEN stance = 'liked' THEN 'neutral' ELSE 'strained' END";
    const good = reaction === 'respectful' ? 'MIN(good_days + 1, 2)' : '0';
    const rude = reaction === 'rude' ? 'MIN(rude_days + 1, 2)' : '0';
    const breakUntil = reaction === 'rude' ? 'CASE WHEN rude_days >= 1 THEN ? ELSE break_until END' : 'NULL';
    const kind = reaction === 'rude' ? "'quarrel'"
      : "CASE WHEN stance = 'strained' THEN 'reconcile' WHEN good_days >= 1 THEN 'bond' ELSE 'help' END";
    const extra = reaction === 'rude' ? [at + 86_400_000] : [];
    statements.push(env.DB.prepare(`UPDATE society_relations SET stance = ${stance}, good_days = ${good},
      rude_days = ${rude}, break_until = ${breakUntil}, last_kind = ${kind}, last_hire_id = ?,
      last_move_day = ?, last_settled_day = ? WHERE token_id = ? AND other_id = ?
      AND (last_move_day IS NULL OR last_move_day < ?) AND ${claimed}`)
      .bind(...extra, source, day, day, subject, other, day, source, attempt));
    // Society's relationship event is defined for settled hires. Debate events have their
    // own names; do not mislabel a debate reaction as paid help in that event path.
    statements.push(env.DB.prepare(`INSERT OR IGNORE INTO society_encounters (hire_id, token_id, other_id, day, kind, state, event_recorded)
      SELECT ?, token_id, other_id, ?, last_kind, stance, 1 FROM society_relations
      WHERE token_id = ? AND other_id = ? AND last_hire_id = ? AND ${claimed}`)
      .bind(source, day, subject, other, source, source, attempt));
  }
  await env.DB.batch(statements);
}

/** The cron repairs a crash after the fourth receipt settled but before outcome application. */
export async function settlePendingDebateOutcomes(env: Env, now: number = Date.now()): Promise<void> {
  const rows = await env.DB.prepare(`SELECT d.id FROM debates d WHERE d.status = 'completed'
    AND NOT EXISTS (SELECT 1 FROM society_processed_hires p WHERE p.hire_id = 'debate:' || d.id)
    ORDER BY d.ended_at LIMIT 20`).all<{ id: string }>();
  for (const row of rows.results) await applyDebateOutcome(env, row.id, now);
}
