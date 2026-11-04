// The Hire board's D1 snapshot. One set read replaces the per-pet quote, food, life and
// public-id queries; yocto amounts stay as strings in SQLite and are summed as BigInt here.
export interface BoardFact {
  tokenId: string;
  label: string;
  opaqueId: string;
  count: number;
  energyDay: number | null;
  energyUsed: number;
  unbilled: bigint;
}

type Db = Pick<D1Database, 'prepare'>;
type FactRow = {
  token_id: string;
  label: string;
  opaque_id: string;
  count: number;
  energy_day: number | null;
  energy_used: number;
};

/** The index is skills itself. Older skilled pets get the same stable 128-bit public id as a
 * newly hatched pet, in one statement no matter how many skills there are. */
export async function loadBoardFacts(db: Db, day: number): Promise<Map<string, BoardFact>> {
  await db.prepare(`INSERT OR IGNORE INTO pet_public_ids (token_id, opaque_id)
    SELECT s.token_id, lower(hex(randomblob(16))) FROM skills s
    LEFT JOIN pet_public_ids p ON p.token_id = s.token_id
    WHERE p.token_id IS NULL`).run();
  const rows = await db.prepare(`SELECT s.token_id, s.label, p.opaque_id,
      COALESCE(w.n, 0) + COALESCE(w.held, 0) AS count,
      l.energy_day, COALESCE(l.energy_used, 0) AS energy_used
    FROM skills s
    JOIN pet_public_ids p ON p.token_id = s.token_id
    LEFT JOIN worker_answers w ON w.token_id = s.token_id AND w.day = ?
    LEFT JOIN pet_life l ON l.token_id = s.token_id
    ORDER BY s.token_id`).bind(day).all<FactRow>();
  const facts = new Map<string, BoardFact>(rows.results.map((row) => [row.token_id, {
    tokenId: row.token_id,
    label: row.label,
    opaqueId: row.opaque_id,
    count: row.count,
    energyDay: row.energy_day,
    energyUsed: row.energy_used,
    unbilled: 0n,
  }]));
  const unpaid = await db.prepare(`SELECT s.token_id, t.price_yocto AS yocto FROM skills s
      JOIN thoughts t ON t.token_id = s.token_id AND t.status = 'unbilled'
      WHERE NOT EXISTS (SELECT 1 FROM hires h WHERE h.answer_thought_id = t.id AND h.status = 'unbilled')
    UNION ALL
    SELECT s.token_id, h.fee_yocto AS yocto FROM skills s
      JOIN hires h ON h.hirer_id = s.token_id AND h.status = 'unbilled'
      WHERE EXISTS (SELECT 1 FROM thoughts t WHERE t.id = h.answer_thought_id AND t.status = 'unbilled')`)
    .all<{ token_id: string; yocto: string }>();
  for (const row of unpaid.results) {
    const fact = facts.get(row.token_id);
    if (fact) fact.unbilled += BigInt(row.yocto);
  }
  return facts;
}
