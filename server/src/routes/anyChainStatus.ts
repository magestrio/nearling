import { Hono } from 'hono';
import { ChainUnreachable, txStatus } from '../chain';
import { type AppEnv } from '../http';
import { providerStatus, readDeliveries, type DeliveryEvidence } from '../any-chain/status';
import { observedSource, verifiedSource } from '../any-chain/source';
import { ONE_CLICK, originOf } from '../any-chain/quote';
import { track } from '../track';
import { recordAnyChainEvent, recordCreditEvents, usdcFee } from '../any-chain/events';
import { routeProjectUsd } from '../any-chain/cost';
import { contractReason } from '../any-chain/reasons';

export const anyChainStatusRoutes = new Hono<AppEnv>();
const ID = /^[0-9a-f]{32}$/;
const NEAR_TX = /^[1-9A-HJ-NP-Za-km-z]{32,60}$/;
const NEAR_ACCOUNT = /^[a-z0-9._-]{2,64}$/;

interface RouteRow {
  id: string; token_id: string; origin_asset: string; origin_chain: string | null;
  origin_symbol: string | null; origin_decimals: number | null; amount_in: string; refund_to: string;
  state: string; deposit_address: string | null; deposit_memo: string | null;
  provider_deadline: string | null; quote_json: string;
  request_deadline: string; created_at: number;
}
interface StatusRow {
  provider_state: string; provider_reference: string | null; source_tx_hash: string | null;
  source_condition: string | null;
  provider_refund_tx: string | null; provider_refund_amount: string | null;
  rejection_reason: string | null;
  resolved_at: number | null;
}
interface EvidenceRow {
  receipt_id: string; near_tx_hash: string; amount_yocto: string; kind: string;
  credit_id: number | null; held_id: number | null; held_reason: string | null;
  unwrap_failed: number;
  credited_amount: string | null;
}

async function saveEvidence(env: Env, deliveries: DeliveryEvidence[]): Promise<void> {
  if (!deliveries.length) return;
  const db = env.DB;
  const batch: D1PreparedStatement[] = [];
  const feeds: number[] = [];
  for (const item of deliveries) {
    batch.push(db.prepare(`INSERT OR IGNORE INTO any_chain_delivery_evidence
      (receipt_id, route_id, token_id, near_tx_hash, amount_yocto, kind, credit_id, unwrap_failed, held_id, held_reason, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(item.receiptId, item.routeId, item.tokenId, item.nearTxHash, item.amount, item.kind,
        item.creditId, item.unwrapFailed ? 1 : 0, item.heldId, item.reason, Date.now()));
    if (item.kind === 'held' && item.heldId !== null) batch.push(db.prepare(`INSERT OR IGNORE INTO any_chain_held_returns
      (held_id, receipt_id, amount_yocto, reason) VALUES (?, ?, ?, ?)`)
      .bind(item.heldId, item.receiptId, item.amount, item.reason ?? 'unknown'));
    if (item.credited && item.creditId !== null) {
      feeds.push(batch.length);
      batch.push(db.prepare(`INSERT OR IGNORE INTO any_chain_credit_evidence
        (credit_id, near_tx_hash, amount_yocto, recorded_at, was_asleep)
        VALUES (?, ?, ?, ?, CASE WHEN EXISTS (SELECT 1 FROM pets WHERE token_id = ? AND slept_at IS NOT NULL) THEN 1 ELSE 0 END)`)
        .bind(item.creditId, item.nearTxHash, item.amount, Date.now(), item.tokenId));
    }
  }
  const written = await db.batch(batch);
  for (const index of feeds) if (written[index]?.meta.changes === 1)
    track('pet_fed', { source: 'cross_chain', via: 'link' });
  for (const item of deliveries) if (item.credited && item.creditId !== null && item.routeId)
    await recordCreditEvents(env, item.routeId, item.creditId);
}

async function evidenceFor(db: D1Database, id: string): Promise<EvidenceRow[]> {
  const rows = await db.prepare(`SELECT d.receipt_id, d.near_tx_hash, d.amount_yocto, d.kind,
    d.credit_id, d.unwrap_failed, d.held_id, d.held_reason, c.amount_yocto AS credited_amount
    FROM any_chain_delivery_evidence d LEFT JOIN any_chain_credit_evidence c ON c.credit_id = d.credit_id
    WHERE d.route_id = ? ORDER BY d.recorded_at, d.receipt_id`).bind(id).all<EvidenceRow>();
  return rows.results;
}

// spec: add-any-chain-feed › Cross-chain settlement data › held delivery reconciled
anyChainStatusRoutes.post('/api/any-chain/deliveries/observe', async (c) => {
  const body = await c.req.json<{ nearTxHash?: unknown; signerId?: unknown }>().catch(() => null);
  if (typeof body?.nearTxHash !== 'string' || !NEAR_TX.test(body.nearTxHash) ||
    typeof body.signerId !== 'string' || !NEAR_ACCOUNT.test(body.signerId))
    return c.json({ code: 'bad_request' }, 400);
  const items = await readDeliveries(c.env, [body.nearTxHash], body.signerId);
  if (!items.length) return c.json({ code: 'delivery_missing' }, 404);
  await saveEvidence(c.env, items);
  return c.json({ deliveries: items.map((item) => ({ nearTxHash: item.nearTxHash,
    receiptId: item.receiptId, heldId: item.heldId, creditId: item.creditId,
    amount: item.amount, reason: item.reason, kind: item.kind })) });
});

// spec: add-any-chain-feed › Cross-chain settlement data › credited once
// spec: add-any-chain-feed › Cross-chain settlement data › recovery after unknown outcome
// spec: add-any-chain-feed › Cross-chain quote flow › source transfer pending
// spec: add-any-chain-feed › Cross-chain quote flow › provider failure
// spec: add-any-chain-feed › Cross-chain quote flow › unknown outcome
anyChainStatusRoutes.get('/api/any-chain/status/:id', async (c) => {
  const id = c.req.param('id');
  if (!ID.test(id)) return c.json({ code: 'bad_request' }, 400);
  const row = await c.env.DB.prepare('SELECT * FROM any_chain_routes WHERE id = ?').bind(id).first<RouteRow>();
  if (!row) return c.json({ code: 'payment_missing' }, 404);
  let current: StatusRow | null = await c.env.DB.prepare('SELECT * FROM any_chain_route_status WHERE route_id = ?').bind(id).first<StatusRow>();
  let unavailable = false;
  if (row.deposit_address) {
    try {
      const status = await providerStatus(row.deposit_address, row.deposit_memo);
      const originHashes = status.swapDetails?.originChainTxHashes?.map((item) => item.hash) ?? [];
      let source = originHashes[0] ?? null;
      const chain = originOf(row.origin_asset);
      let sourceCondition: string | null = null;
      if (chain && row.deposit_address) {
        sourceCondition = originHashes.length ? 'unknown' : null;
        for (const candidate of originHashes) {
          try {
            const observation = await observedSource(chain, candidate, row.deposit_address);
            if (!observation) continue;
            source = candidate;
            sourceCondition = observation.asset === 'other' ? 'wrong_asset' :
              observation.at !== null && observation.at > Date.parse(row.request_deadline) ? 'late' :
              BigInt(observation.amount) < BigInt(row.amount_in) ? 'too_small' : 'observed';
            break;
          } catch { /* Keep the public reference and an unknown source condition. */ }
        }
      }
      let refundTx: string | null = null;
      if (chain && status.swapDetails?.refundedAmount && /^\d+$/.test(status.swapDetails.refundedAmount) &&
        BigInt(status.swapDetails.refundedAmount) > 0n) {
        for (const candidate of status.swapDetails.originChainTxHashes ?? []) {
          if (candidate.hash === source) continue;
          try {
            const proof = await verifiedSource(chain, candidate.hash, row.refund_to, status.swapDetails.refundedAmount);
            if (proof && proof.recipient.toLowerCase() === row.refund_to.toLowerCase()) { refundTx = candidate.hash; break; }
          } catch { /* Provider reference remains unverified. */ }
        }
      }
      const nearHashes = [...new Set([
        ...(status.swapDetails?.nearTxHashes ?? []),
        ...(status.swapDetails?.destinationChainTxHashes?.map((item) => item.hash) ?? []),
      ])];
      // The provider's destination hash is a candidate only. Public final NEAR
      // receipt events are the sole authority for held custody and food.
      const linked = status.quoteResponse?.quoteRequest?.originAsset === row.origin_asset &&
        status.quoteResponse.quoteRequest.destinationAsset === 'nep141:wrap.near' &&
        status.quoteResponse.quoteRequest.refundTo === row.refund_to &&
        status.quoteResponse.quoteRequest.recipient === c.env.CONTRACT_ID;
      const deliveries = (await readDeliveries(c.env, nearHashes)).map((item) =>
        item.kind === 'held' && item.routeId === null && linked ? { ...item, routeId: id } : item);
      await saveEvidence(c.env, deliveries);
      let rejection: string | null = null;
      if (linked && deliveries.length === 0) for (const hash of nearHashes.slice(0, 3)) {
        try {
          const outcome = await txStatus(c.env, hash, 'intents.near');
          if (outcome?.status === 'failed') {
            rejection = contractReason(outcome.code);
            if (rejection) break;
          }
        } catch { /* The provider reference remains for a later read. */ }
      }
      await c.env.DB.prepare(`INSERT INTO any_chain_route_status
        (route_id, provider_state, provider_reference, source_tx_hash, source_condition, provider_refund_tx,
         provider_refund_amount, rejection_reason, last_checked_at, resolved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
        ON CONFLICT(route_id) DO UPDATE SET provider_state = excluded.provider_state,
        provider_reference = excluded.provider_reference, source_tx_hash = COALESCE(excluded.source_tx_hash, source_tx_hash),
        source_condition = COALESCE(excluded.source_condition, source_condition),
        provider_refund_tx = COALESCE(excluded.provider_refund_tx, provider_refund_tx),
        provider_refund_amount = excluded.provider_refund_amount,
        rejection_reason = COALESCE(excluded.rejection_reason, rejection_reason), last_checked_at = excluded.last_checked_at`)
        .bind(id, status.status, status.correlationId ?? null, source, sourceCondition, refundTx,
          status.swapDetails?.refundedAmount ?? null, rejection, Date.now()).run();
      current = await c.env.DB.prepare('SELECT * FROM any_chain_route_status WHERE route_id = ?').bind(id).first<StatusRow>();
    } catch (error) {
      if (!(error instanceof ChainUnreachable)) throw error;
      // An accepted address and the last evidence stay reachable during a provider/RPC outage.
      unavailable = true;
    }
  }
  const evidence = await evidenceFor(c.env.DB, id);
  const retryRefusal = await c.env.DB.prepare(`SELECT o.rejection_reason FROM any_chain_retry_operations o
    JOIN any_chain_delivery_evidence d ON d.credit_id = o.credit_id
    WHERE d.route_id = ? AND o.rejection_reason IS NOT NULL ORDER BY o.updated_at DESC LIMIT 1`)
    .bind(id).first<{ rejection_reason: string }>();
  for (const item of evidence) if (item.credited_amount !== null && item.credit_id !== null)
    await recordCreditEvents(c.env, id, item.credit_id);
  const state = evidence.some((item) => item.credited_amount !== null) ?
    current?.provider_refund_tx ? 'food_excess_refunded' : 'food' :
    evidence.some((item) => item.kind === 'held') ? 'held' :
    evidence.some((item) => item.unwrap_failed === 1) ? 'unwrap_failed' :
    evidence.some((item) => item.kind === 'pending') ? 'unwrap_pending' :
    current?.provider_refund_tx ? 'provider_refunded' :
    current?.source_condition === 'wrong_asset' ? 'wrong_asset' :
    current?.source_condition === 'late' ? 'transfer_late' :
    current?.source_condition === 'too_small' ? 'transfer_too_small' :
    current?.provider_state === 'REFUNDED' ? 'provider_refund_unverified' :
    current?.provider_state === 'FAILED' ? 'provider_failed' :
    current?.provider_state === 'SUCCESS' ? 'delivery_unverified' :
    current?.source_condition === 'observed' ? 'source_transfer_pending' :
    row.state === 'accepting' ? 'unknown_outcome' : unavailable && current === null ? 'unknown_outcome' : 'source_pending';
  const chain = originOf(row.origin_asset);
  if (chain && ['observed', 'wrong_asset', 'late', 'too_small'].includes(current?.source_condition ?? '') &&
    current?.source_tx_hash)
    await recordAnyChainEvent(c.env, { name: 'cross_chain_deposit_seen', key: `quote:${chain === 'base' ? current.source_tx_hash.toLowerCase() : current.source_tx_hash}`,
      routeId: id, tokenId: row.token_id, fields: { route: 'quote', chain,
        asset: current.source_condition === 'wrong_asset' ? 'other' : 'usdc' } });
  if (state === 'food' || state === 'food_excess_refunded' || state === 'provider_refunded' ||
    (state === 'provider_failed' && current?.source_tx_hash == null &&
      row.provider_deadline !== null && Date.parse(row.provider_deadline) <= Date.now()))
    await c.env.DB.prepare(`INSERT INTO any_chain_route_status
      (route_id, provider_state, last_checked_at, resolved_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(route_id) DO UPDATE SET resolved_at = COALESCE(resolved_at, excluded.resolved_at)`)
      .bind(id, current?.provider_state ?? 'UNKNOWN', Date.now(), Date.now()).run();
  else if (current?.resolved_at !== null && current?.resolved_at !== undefined)
    await c.env.DB.prepare('UPDATE any_chain_route_status SET resolved_at = NULL WHERE route_id = ?').bind(id).run();
  if (state === 'provider_refunded') {
    const quote = JSON.parse(row.quote_json) as { quote?: { refundFee?: string } };
    await recordAnyChainEvent(c.env, { name: 'cross_chain_feed_refunded', key: id, routeId: id,
      tokenId: row.token_id, fields: { route: 'quote', chain: chain ?? undefined,
        feeUsd: usdcFee(quote.quote?.refundFee) } });
  }
  if ((current?.source_tx_hash || evidence.length > 0) &&
    ['provider_failed', 'delivery_unverified', 'unwrap_failed', 'provider_refund_unverified'].includes(state))
    await recordAnyChainEvent(c.env, { name: 'cross_chain_feed_stalled', key: `${id}:${state}`, routeId: id,
      tokenId: row.token_id, fields: { route: 'quote', reason: state,
        projectUsd: await routeProjectUsd(c.env.DB, id) } });
  const providerStatusUrl = row.deposit_address ? new URL(`${ONE_CLICK}/status`) : null;
  if (providerStatusUrl) {
    providerStatusUrl.searchParams.set('depositAddress', row.deposit_address!);
    if (row.deposit_memo) providerStatusUrl.searchParams.set('depositMemo', row.deposit_memo);
  }
  return c.json({ id, tokenId: row.token_id, state, providerState: current?.provider_state ?? null,
    reason: state === 'food' || state === 'food_excess_refunded' ? null :
      retryRefusal?.rejection_reason ?? current?.rejection_reason ?? null,
    sourceAmount: row.amount_in, sourceAsset: row.origin_symbol ?? 'USDC', sourceDecimals: row.origin_decimals ?? 6,
    sourceAssetId: row.origin_asset, sourceChain: row.origin_chain === 'sol' ? 'solana' : row.origin_chain ?? chain,
    providerStatusUrl: providerStatusUrl?.toString() ?? null,
    providerReference: current?.provider_reference ?? null, sourceTxHash: current?.source_tx_hash ?? null,
    sourceCondition: current?.source_condition ?? null,
    providerRefundAmount: current?.provider_refund_tx ? current.provider_refund_amount : null,
    providerRefundTxHash: current?.provider_refund_tx ?? null,
    refundTo: row.refund_to,
    deliveries: evidence.map((item) => ({ receiptId: item.receipt_id, nearTxHash: item.near_tx_hash,
      amount: item.amount_yocto, kind: item.kind, creditId: item.credit_id, heldId: item.held_id,
      reason: item.held_reason, unwrapFailed: item.unwrap_failed === 1,
      creditedAmount: item.credited_amount })) });
});
