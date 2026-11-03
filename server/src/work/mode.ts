// The hire mode of a pet (`Hire mode rule`): by token id, so it goes with the pet at a gift and stays through a
// clear of the memory. A pet with no row is in Auto (OD-20).
export type HireMode = 'auto' | 'manual';

export async function hireModeOf(db: D1Database, tokenId: string): Promise<HireMode> {
  const row = await db.prepare('SELECT mode FROM hire_modes WHERE token_id = ?').bind(tokenId).first<{ mode: string }>();
  return row?.mode === 'manual' ? 'manual' : 'auto';
}
