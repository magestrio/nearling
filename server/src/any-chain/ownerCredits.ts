/** Confirmed credits still within their route's retention window. Public payment ids, no payer data. */
export async function ownerCredits(db: D1Database, tokenId: string): Promise<Array<{ id: string; creditId: number; wasAsleep: boolean; route: 'quote' | 'pet_address' }>> {
  const rows = await db.prepare(`SELECT d.route_id AS id, e.credit_id AS creditId, e.was_asleep AS wasAsleep,
      CASE WHEN r.id IS NOT NULL THEN 'quote' ELSE 'pet_address' END AS route
    FROM any_chain_delivery_evidence d
    JOIN any_chain_credit_evidence e ON e.credit_id = d.credit_id
    LEFT JOIN any_chain_routes r ON r.id = d.route_id
    LEFT JOIN any_chain_sweeps s ON s.route_id = d.route_id
    WHERE d.token_id = ? AND (r.id IS NOT NULL OR s.route_id IS NOT NULL)
    ORDER BY e.recorded_at DESC, e.credit_id DESC`)
    .bind(tokenId).all<{ id: string; creditId: number; wasAsleep: number; route: 'quote' | 'pet_address' }>();
  return rows.results.map((row) => ({ id: row.id, creditId: row.creditId, wasAsleep: row.wasAsleep === 1, route: row.route }));
}
