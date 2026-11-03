// What a worker did, as its own side reads it (`Work record data`, `Worker rule`, `Work diary rule`): the work records the
// hirer's batch wrote, names and amounts only, never a question or an answer.

export interface WorkOfDay {
  /** The hirer pets' names, each once, in the order of the first record. */
  hirers: string[];
  /** What the day's work put into the worker's food (fee minus answer), in cents, two significant digits. */
  cents: number;
}

/** USD micros as cents with two significant digits, the way every price of the game is told. */
export const centsOf = (micros: number): number => Number((micros / 10_000).toPrecision(2));

/** The work recorded for the UTC `day` of the network's batch: null when there is none (`Work diary rule` › «не
 * нанимали»). */
export async function workOfDay(db: D1Database, tokenId: string, day: number): Promise<WorkOfDay | null> {
  const rows = await db
    .prepare('SELECT hirer_name, earned_usd_micros FROM work_records WHERE worker_id = ? AND day = ? ORDER BY recorded_at, rowid')
    .bind(tokenId, day)
    .all<{ hirer_name: string; earned_usd_micros: number }>();
  if (rows.results.length === 0) return null;
  return {
    hirers: [...new Set(rows.results.map((r) => r.hirer_name))],
    cents: centsOf(rows.results.reduce((sum, r) => sum + r.earned_usd_micros, 0)),
  };
}

/** The newest records of the worker, for the layer of its own replies. */
export async function recentWork(db: D1Database, tokenId: string, limit: number): Promise<{ hirer: string; cents: number }[]> {
  const rows = await db
    .prepare('SELECT hirer_name, earned_usd_micros FROM work_records WHERE worker_id = ? ORDER BY recorded_at DESC, rowid DESC LIMIT ?')
    .bind(tokenId, limit)
    .all<{ hirer_name: string; earned_usd_micros: number }>();
  return rows.results.map((r) => ({ hirer: r.hirer_name, cents: centsOf(r.earned_usd_micros) }));
}
