/** Directed, private relationship rows. Only a confirmed feed or a recorded paid hire calls these. */

export type Reaction = 'respectful' | 'rude';
export type Stance = 'neutral' | 'liked' | 'strained';
export interface ReactionResult { processed: boolean; moved: string[] }
export interface SettlementGuard { payerEpoch: number; workerEpoch: number }

export interface Relation {
  token_id: string;
  other_id: string;
  stance: Stance;
  good_days: number;
  rude_days: number;
  last_move_day: number | null;
  break_until: number | null;
  created_at: number;
}

/** Directed introductions after a confirmed feed; duplicate retries do nothing. */
export function feedIntroductionStatements(db: D1Database, targetId: string,
  feederPets: readonly string[], at: number): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];
  for (const otherId of new Set(feederPets)) {
    if (otherId === targetId) continue;
    for (const [subject, other] of [[targetId, otherId], [otherId, targetId]]) {
      statements.push(db.prepare(
        'INSERT OR IGNORE INTO society_relations (token_id, other_id, created_at) VALUES (?, ?, ?)',
      ).bind(subject, other, at));
    }
  }
  return statements;
}

export async function relation(db: D1Database, tokenId: string, otherId: string): Promise<Relation | null> {
  return db.prepare(
    `SELECT token_id, other_id, stance, good_days, rude_days, last_move_day, break_until, created_at
     FROM society_relations WHERE token_id = ? AND other_id = ?`,
  ).bind(tokenId, otherId).first<Relation>();
}

/** This is called only by the later settlement stage after its on-chain hire is accepted. The
 * processed marker and all directed movements are one D1 transaction. A replay has a different
 * attempt id, so its conditional statements cannot touch the original rows. */
export async function applySettledReaction(db: D1Database, hireId: string, payerId: string,
  workerId: string, reaction: Reaction, at: number, guard?: SettlementGuard, settledDay?: number): Promise<ReactionResult> {
  if (payerId === workerId) throw new Error('society_same_pet');
  const attempt = crypto.randomUUID();
  const day = settledDay ?? Math.floor(at / 86_400_000);
  const directions = reaction === 'respectful'
    ? [[payerId, workerId], [workerId, payerId]]
    : [[workerId, payerId]];
  const ownAttempt = 'EXISTS (SELECT 1 FROM society_processed_hires WHERE hire_id = ? AND attempt_id = ?)';
  const statements: D1PreparedStatement[] = [db.prepare(
    `INSERT INTO society_processed_hires (hire_id, attempt_id, settled_at)
     VALUES (?, ?, ?) ON CONFLICT(hire_id) DO NOTHING`,
  ).bind(hireId, attempt, at)];
  for (const [subject, other] of directions) {
    const epoch = subject === payerId ? guard?.payerEpoch : guard?.workerEpoch;
    const memoryGuard = epoch === undefined ? '' : ` AND EXISTS (SELECT 1 FROM hires h JOIN thoughts t ON t.id = h.answer_thought_id
      WHERE h.id = ? AND h.status = 'recorded' AND t.erased_at IS NULL
      AND COALESCE((SELECT memory_epoch FROM pets WHERE token_id = ?), 0) = ?)`;
    const memoryArgs = epoch === undefined ? [] : [hireId, subject, epoch];
    statements.push(db.prepare(
      `INSERT OR IGNORE INTO society_relations (token_id, other_id, created_at)
       SELECT ?, ?, ? WHERE ${ownAttempt}${memoryGuard}`,
    ).bind(subject, other, at, hireId, attempt, ...memoryArgs));
    const nextStance = reaction === 'respectful'
      ? "CASE WHEN stance = 'strained' THEN 'neutral' WHEN good_days >= 1 THEN 'liked' ELSE 'neutral' END"
      : "CASE WHEN stance = 'liked' THEN 'neutral' ELSE 'strained' END";
    const nextGood = reaction === 'respectful' ? 'MIN(good_days + 1, 2)' : '0';
    const nextRude = reaction === 'rude' ? 'MIN(rude_days + 1, 2)' : '0';
    const breakUntil = reaction === 'rude'
      ? 'CASE WHEN rude_days >= 1 THEN ? ELSE break_until END'
      : 'NULL';
    const params = reaction === 'rude' ? [at + 86_400_000] : [];
    const kind = reaction === 'rude' ? "'quarrel'"
      : "CASE WHEN stance = 'strained' THEN 'reconcile' WHEN good_days >= 1 THEN 'bond' ELSE 'help' END";
    statements.push(db.prepare(
      `UPDATE society_relations SET stance = ${nextStance}, good_days = ${nextGood},
       rude_days = ${nextRude}, break_until = ${breakUntil}, last_kind = ${kind}, last_hire_id = ?,
       last_move_day = ?, last_settled_day = ?
       WHERE token_id = ? AND other_id = ? AND (last_move_day IS NULL OR last_move_day < ?)
       AND ${ownAttempt}${memoryGuard}`,
    ).bind(...params, hireId, day, day, subject, other, day, hireId, attempt, ...memoryArgs));
    statements.push(db.prepare(
      `INSERT OR IGNORE INTO society_encounters (hire_id, token_id, other_id, day, kind, state)
       SELECT ?, token_id, other_id, ?, last_kind, stance FROM society_relations
       WHERE token_id = ? AND other_id = ? AND last_hire_id = ? AND ${ownAttempt}`,
    ).bind(hireId, day, subject, other, hireId, hireId, attempt));
  }
  const result = await db.batch(statements);
  return {
    processed: result[0]!.meta.changes > 0,
    moved: directions.filter((_, index) => result[2 + index * 3]!.meta.changes > 0).map(([subject]) => subject),
  };
}
