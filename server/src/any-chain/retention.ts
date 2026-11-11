export const PAYMENT_RETENTION_MS = 30 * 86_400_000;

/** Payment evidence survives memory clear and every unresolved outcome. */
export async function cleanResolvedPayments(db: D1Database, now = Date.now()): Promise<void> {
  const before = now - PAYMENT_RETENTION_MS;
  const routes = await db.prepare(`SELECT s.route_id FROM any_chain_route_status s
    WHERE s.resolved_at IS NOT NULL AND s.resolved_at <= ?
      AND NOT EXISTS (SELECT 1 FROM any_chain_held_returns h
        JOIN any_chain_delivery_evidence d ON d.receipt_id = h.receipt_id
        WHERE d.route_id = s.route_id AND h.reverse_state IS NOT 'refunded')
      AND NOT EXISTS (SELECT 1 FROM any_chain_delivery_evidence d
        LEFT JOIN any_chain_credit_evidence c ON c.credit_id = d.credit_id
        WHERE d.route_id = s.route_id AND d.kind = 'pending' AND c.credit_id IS NULL)
    ORDER BY s.resolved_at LIMIT 20`).bind(before).all<{ route_id: string }>();
  for (const { route_id } of routes.results) await db.batch([
    db.prepare(`DELETE FROM any_chain_retry_attempts WHERE credit_id IN
      (SELECT credit_id FROM any_chain_delivery_evidence WHERE route_id = ? AND credit_id IS NOT NULL)`).bind(route_id),
    db.prepare(`DELETE FROM any_chain_retry_operations WHERE credit_id IN
      (SELECT credit_id FROM any_chain_delivery_evidence WHERE route_id = ? AND credit_id IS NOT NULL)`).bind(route_id),
    db.prepare(`DELETE FROM any_chain_credit_evidence WHERE credit_id IN
      (SELECT credit_id FROM any_chain_delivery_evidence WHERE route_id = ? AND credit_id IS NOT NULL)`).bind(route_id),
    db.prepare(`DELETE FROM any_chain_operator_nonces WHERE held_id IN
      (SELECT h.held_id FROM any_chain_held_returns h JOIN any_chain_delivery_evidence d
        ON d.receipt_id = h.receipt_id WHERE d.route_id = ?)`).bind(route_id),
    db.prepare(`DELETE FROM any_chain_held_attempts WHERE held_id IN
      (SELECT h.held_id FROM any_chain_held_returns h JOIN any_chain_delivery_evidence d
        ON d.receipt_id = h.receipt_id WHERE d.route_id = ?)`).bind(route_id),
    db.prepare(`DELETE FROM any_chain_held_returns WHERE receipt_id IN
      (SELECT receipt_id FROM any_chain_delivery_evidence WHERE route_id = ?)`).bind(route_id),
    db.prepare('DELETE FROM any_chain_delivery_evidence WHERE route_id = ?').bind(route_id),
    db.prepare('DELETE FROM any_chain_expense_links WHERE route_id = ?').bind(route_id),
    db.prepare('DELETE FROM any_chain_route_status WHERE route_id = ?').bind(route_id),
    db.prepare('DELETE FROM any_chain_routes WHERE id = ?').bind(route_id),
  ]);

  // A dry quote never exposed a payable address, so its own deadline resolves it.
  await db.prepare(`DELETE FROM any_chain_routes WHERE id IN (
    SELECT id FROM any_chain_routes r WHERE r.state = 'draft' AND r.request_deadline <= ?
      AND NOT EXISTS (SELECT 1 FROM any_chain_route_status s WHERE s.route_id = r.id)
      AND NOT EXISTS (SELECT 1 FROM any_chain_delivery_evidence d WHERE d.route_id = r.id)
    LIMIT 20)`).bind(new Date(before).toISOString()).run();

  const deposits = await db.prepare(`SELECT d.id FROM any_chain_deposits d
    WHERE d.resolved_at IS NOT NULL AND d.resolved_at <= ?
      AND d.state IN ('food', 'refunded')
      AND NOT EXISTS (SELECT 1 FROM any_chain_sweeps s WHERE s.deposit_id = d.id
        AND s.state NOT IN ('food', 'refunded', 'failed', 'approval_rejected', 'sign_failed'))
      AND NOT EXISTS (SELECT 1 FROM any_chain_held_returns h
        JOIN any_chain_delivery_evidence e ON e.receipt_id = h.receipt_id
        JOIN any_chain_sweeps s ON s.route_id = e.route_id
        WHERE s.deposit_id = d.id AND h.reverse_state IS NOT 'refunded')
      AND (SELECT COALESCE(SUM(CAST(s.amount_units AS INTEGER)), 0) FROM any_chain_sweeps s
        WHERE s.deposit_id = d.id AND s.state = 'food') >= CAST(d.amount_units AS INTEGER)
    ORDER BY d.resolved_at LIMIT 20`).bind(before).all<{ id: string }>();
  for (const { id } of deposits.results) await db.batch([
    db.prepare(`DELETE FROM any_chain_retry_attempts WHERE credit_id IN
      (SELECT credit_id FROM any_chain_delivery_evidence WHERE route_id IN
        (SELECT route_id FROM any_chain_sweeps WHERE deposit_id = ?) AND credit_id IS NOT NULL)`).bind(id),
    db.prepare(`DELETE FROM any_chain_retry_operations WHERE credit_id IN
      (SELECT credit_id FROM any_chain_delivery_evidence WHERE route_id IN
        (SELECT route_id FROM any_chain_sweeps WHERE deposit_id = ?) AND credit_id IS NOT NULL)`).bind(id),
    db.prepare(`DELETE FROM any_chain_credit_evidence WHERE credit_id IN
      (SELECT credit_id FROM any_chain_delivery_evidence WHERE route_id IN
        (SELECT route_id FROM any_chain_sweeps WHERE deposit_id = ?) AND credit_id IS NOT NULL)`).bind(id),
    db.prepare(`DELETE FROM any_chain_operator_nonces WHERE held_id IN
      (SELECT h.held_id FROM any_chain_held_returns h JOIN any_chain_delivery_evidence e
        ON e.receipt_id = h.receipt_id WHERE e.route_id IN
        (SELECT route_id FROM any_chain_sweeps WHERE deposit_id = ?))`).bind(id),
    db.prepare(`DELETE FROM any_chain_held_attempts WHERE held_id IN
      (SELECT h.held_id FROM any_chain_held_returns h JOIN any_chain_delivery_evidence e
        ON e.receipt_id = h.receipt_id WHERE e.route_id IN
        (SELECT route_id FROM any_chain_sweeps WHERE deposit_id = ?))`).bind(id),
    db.prepare(`DELETE FROM any_chain_held_returns WHERE receipt_id IN
      (SELECT receipt_id FROM any_chain_delivery_evidence WHERE route_id IN
        (SELECT route_id FROM any_chain_sweeps WHERE deposit_id = ?))`).bind(id),
    db.prepare(`DELETE FROM any_chain_expense_links WHERE route_id IN
      (SELECT route_id FROM any_chain_sweeps WHERE deposit_id = ?)`).bind(id),
    db.prepare(`DELETE FROM any_chain_delivery_evidence WHERE route_id IN
      (SELECT route_id FROM any_chain_sweeps WHERE deposit_id = ?)`).bind(id),
    db.prepare('DELETE FROM any_chain_sweeps WHERE deposit_id = ?').bind(id),
    db.prepare('DELETE FROM any_chain_deposits WHERE id = ?').bind(id),
  ]);
}
