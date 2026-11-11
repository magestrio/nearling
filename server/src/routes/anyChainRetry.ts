import { Hono } from 'hono';
import { type AppEnv } from '../http';
import { retryOutcome } from '../any-chain/status';
import { track } from '../track';
import { recordCreditEvents } from '../any-chain/events';
import { contractReason } from '../any-chain/reasons';

export const anyChainRetryRoutes = new Hono<AppEnv>();
const ID = /^(?:0|[1-9]\d{0,15})$/;
interface CreditRow {
  credit_id: number; route_id: string; token_id: string; amount_yocto: string;
  unwrap_failed: number; credited_amount: string | null;
}
interface RetryRow { state: string; tx_hash: string | null }

async function credit(db: D1Database, id: number): Promise<CreditRow | null> {
  return db.prepare(`SELECT d.credit_id, d.route_id, d.token_id, d.amount_yocto, d.unwrap_failed,
    c.amount_yocto AS credited_amount FROM any_chain_delivery_evidence d
    LEFT JOIN any_chain_credit_evidence c ON c.credit_id = d.credit_id WHERE d.credit_id = ?`)
    .bind(id).first<CreditRow>();
}

// spec: add-any-chain-feed › wNEAR recovery contract › retry failed route
// spec: add-any-chain-feed › wNEAR recovery contract › route already settled
// spec: add-any-chain-feed › wNEAR recovery contract › route not recoverable
anyChainRetryRoutes.post('/api/any-chain/credits/:id/retry', async (c) => {
  if (!ID.test(c.req.param('id'))) return c.json({ code: 'bad_request' }, 400);
  const id = Number(c.req.param('id'));
  const item = await credit(c.env.DB, id);
  if (!item) return c.json({ code: 'credit_missing', reason: 'route_not_recoverable' }, 404);
  if (item.credited_amount !== null) return c.json({ code: 'already_settled', reason: 'route_not_recoverable' }, 409);
  if (item.unwrap_failed !== 1 || !item.route_id || !item.token_id)
    return c.json({ code: 'not_recoverable', reason: 'route_not_recoverable' }, 409);
  let prior = await c.env.DB.prepare('SELECT state, tx_hash FROM any_chain_retry_operations WHERE credit_id = ?')
    .bind(id).first<RetryRow>();
  if (prior?.tx_hash) {
    const outcome = await retryOutcome(c.env, prior.tx_hash, id, item.route_id, item.token_id, item.amount_yocto);
    if (outcome === 'settled') {
      const written = await c.env.DB.batch([
        c.env.DB.prepare(`INSERT OR IGNORE INTO any_chain_credit_evidence
          (credit_id, near_tx_hash, amount_yocto, recorded_at, was_asleep)
          VALUES (?, ?, ?, ?, CASE WHEN EXISTS
            (SELECT 1 FROM pets WHERE token_id = ? AND slept_at IS NOT NULL) THEN 1 ELSE 0 END)`)
          .bind(id, prior.tx_hash, item.amount_yocto, Date.now(), item.token_id),
        c.env.DB.prepare("UPDATE any_chain_retry_operations SET state = 'settled', updated_at = ? WHERE credit_id = ?")
          .bind(Date.now(), id),
      ]);
      if (written[0]?.meta.changes === 1) track('pet_fed', { source: 'cross_chain', via: 'link' });
      await recordCreditEvents(c.env, item.route_id, id);
      return c.json({ state: 'food', creditId: id, nearTxHash: prior.tx_hash });
    }
    if (outcome === 'pending') return c.json({ state: 'retry_pending', creditId: id, nearTxHash: prior.tx_hash });
    if (prior.state !== 'failed') {
      await c.env.DB.prepare("UPDATE any_chain_retry_operations SET state = 'failed', rejection_reason = 'retry_failed_route', updated_at = ? WHERE credit_id = ?")
        .bind(Date.now(), id).run();
      return c.json({ state: 'unwrap_failed', reason: 'retry_failed_route', creditId: id, nearTxHash: prior.tx_hash });
    }
    await c.env.DB.batch([
      c.env.DB.prepare('INSERT OR IGNORE INTO any_chain_retry_attempts (credit_id, tx_hash, ended_at) VALUES (?, ?, ?)')
        .bind(id, prior.tx_hash, Date.now()),
      c.env.DB.prepare("DELETE FROM any_chain_retry_operations WHERE credit_id = ? AND state = 'failed' AND tx_hash = ?")
        .bind(id, prior.tx_hash),
    ]);
    prior = null;
  }
  if (prior?.state === 'claimed') return c.json({ state: 'retry_pending', creditId: id });
  if (prior?.state === 'failed') return c.json({ state: 'unwrap_failed', creditId: id });
  const claim = await c.env.DB.prepare(`INSERT OR IGNORE INTO any_chain_retry_operations
    (credit_id, state, created_at, updated_at) VALUES (?, 'claimed', ?, ?)`)
    .bind(id, Date.now(), Date.now()).run();
  if (claim.meta.changes !== 1) return c.json({ state: 'retry_pending', creditId: id });
  const answer = await c.env.SERVER_KEY.get(c.env.SERVER_KEY.idFromName('gas')).sendGas({
    methodName: 'retry_unwrap', args: { credit_id: id }, gas: '100000000000000',
    retryCreditId: id,
  });
  if (answer.status === 'failed') {
    const reason = contractReason(answer.code) ?? 'retry_failed_route';
    await c.env.DB.prepare("UPDATE any_chain_retry_operations SET state = 'failed', rejection_reason = ?, updated_at = ? WHERE credit_id = ?")
      .bind(reason, Date.now(), id).run();
    return c.json({ code: 'retry_rejected', reason }, 409);
  }
  if (answer.status === 'unreachable') {
    // A failure before signing has no hash and cannot have reached the chain.
    // Once signed, retain the claim and reconcile that hash before another send.
    const signed = await c.env.DB.prepare('SELECT tx_hash FROM any_chain_retry_operations WHERE credit_id = ?')
      .bind(id).first<{ tx_hash: string | null }>();
    if (!signed?.tx_hash) {
      await c.env.DB.prepare("DELETE FROM any_chain_retry_operations WHERE credit_id = ? AND state = 'claimed' AND tx_hash IS NULL")
        .bind(id).run();
      return c.json({ code: 'chain_unreachable' }, 503);
    }
    return c.json({ state: 'retry_pending', creditId: id, nearTxHash: signed.tx_hash });
  }
  await c.env.DB.prepare("UPDATE any_chain_retry_operations SET state = 'unknown', updated_at = ? WHERE credit_id = ? AND state = 'sending'")
    .bind(Date.now(), id).run();
  return c.json({ state: 'retry_pending', creditId: id, nearTxHash: answer.txHash });
});
