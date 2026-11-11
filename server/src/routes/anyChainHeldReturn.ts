import { Hono } from 'hono';
import { ChainUnreachable, rpcProvider } from '../chain';
import { type AppEnv } from '../http';
import { associatedSource, operatorSignature, recoveredWnear, releaseOutcome, reverseQuote, reverseRequest, reverseStatus, type Attestation } from '../any-chain/held';
import { ORIGINS, QuoteUnavailable, type OneClickQuote } from '../any-chain/quote';
import { confirmedReturn } from '../any-chain/source';
import { readDeliveries } from '../any-chain/status';
import { recordFinalNearExpense, routeProjectUsd } from '../any-chain/cost';
import { recordAnyChainEvent, usdcFee } from '../any-chain/events';

export const anyChainHeldReturnRoutes = new Hono<AppEnv>();
const HELD = /^(?:0|[1-9]\d{0,15})$/;

interface HeldRow {
  held_id: number; receipt_id: string; amount_yocto: string; reason: string;
  near_tx_hash: string; route_id: string | null; token_id: string | null;
  source_tx_hash: string | null; origin_chain: string | null;
  route_origin_asset: string | null; route_origin_symbol: string | null; route_origin_decimals: number | null;
  verified_recipient: string | null; attestation_nonce: string | null;
  quote_state: string | null; reverse_quote_json: string | null;
  reverse_request_deadline: string | null;
  reverse_provider_reference: string | null; release_tx_hash: string | null;
  release_state: string | null; reverse_state: string | null;
  recovered_tx_hash: string | null; refund_tx_hash: string | null;
  refund_amount_usdc: string | null;
}
interface RouteRow { origin_asset: string; origin_chain: string | null; refund_to: string; deposit_address: string | null; deposit_memo: string | null }

function expiredReverse(raw: string): boolean {
  try {
    const quote = (JSON.parse(raw) as OneClickQuote).quote;
    return !quote.deadline || !quote.timeWhenInactive ||
      !Number.isFinite(Date.parse(quote.deadline)) || !Number.isFinite(Date.parse(quote.timeWhenInactive)) ||
      Date.parse(quote.deadline) <= Date.now() || Date.parse(quote.timeWhenInactive) <= Date.now();
  } catch { return true; }
}

async function held(db: D1Database, id: number): Promise<HeldRow | null> {
  return db.prepare(`SELECT h.*, d.near_tx_hash, d.route_id, d.token_id,
    r.origin_asset AS route_origin_asset, r.origin_symbol AS route_origin_symbol,
    r.origin_decimals AS route_origin_decimals FROM any_chain_held_returns h
    JOIN any_chain_delivery_evidence d ON d.receipt_id = h.receipt_id
    LEFT JOIN any_chain_routes r ON r.id = d.route_id WHERE h.held_id = ?`).bind(id).first<HeldRow>();
}

function attestation(body: unknown, id: number): Attestation | null {
  if (!body || typeof body !== 'object' || (body as Attestation).heldId !== id) return null;
  return body as Attestation;
}

async function linked(c: { env: Env }, row: HeldRow, proof: Attestation): Promise<boolean> {
  if (row.near_tx_hash !== proof.nearTxHash || row.amount_yocto !== proof.amount ||
    (row.route_id !== null && row.route_id !== proof.routeId)) return false;
  const publicReceipt = await readDeliveries(c.env, [proof.nearTxHash]);
  if (!publicReceipt.some((item) => item.kind === 'held' && item.heldId === row.held_id &&
    item.receiptId === row.receipt_id && item.amount === row.amount_yocto && item.reason === row.reason)) return false;
  const route = await c.env.DB.prepare('SELECT origin_asset, origin_chain, refund_to, deposit_address, deposit_memo FROM any_chain_routes WHERE id = ?')
    .bind(proof.routeId).first<RouteRow>();
  if (!route?.deposit_address) return false;
  const chain = route.origin_chain === 'sol' ? 'solana' : route.origin_chain ??
    (route.origin_asset === ORIGINS.base ? 'base' : route.origin_asset === ORIGINS.solana ? 'solana' : null);
  if (!chain) return false;
  return associatedSource(c.env, proof, route.deposit_address, route.deposit_memo,
    route.origin_asset, chain, route.refund_to);
}

// spec: add-any-chain-feed › Held delivery refund data › source verified
// spec: add-any-chain-feed › Held delivery refund data › source unverified
anyChainHeldReturnRoutes.post('/api/any-chain/held/:id/attest', async (c) => {
  if (!HELD.test(c.req.param('id'))) return c.json({ code: 'bad_request' }, 400);
  const id = Number(c.req.param('id'));
  const proof = attestation(await c.req.json().catch(() => null), id);
  if (!proof) return c.json({ code: 'bad_request' }, 400);
  const row = await held(c.env.DB, id);
  if (!row) return c.json({ code: 'held_missing' }, 404);
  try {
    if (!await operatorSignature(c.env, proof) || !await linked(c, row, proof)) return c.json({ code: 'source_unverified' }, 409);
    const changed = await c.env.DB.batch([
      c.env.DB.prepare('INSERT INTO any_chain_operator_nonces (nonce, held_id, used_at) VALUES (?, ?, ?)')
        .bind(proof.nonce, id, Date.now()),
      c.env.DB.prepare(`UPDATE any_chain_held_returns SET source_tx_hash = ?, origin_chain = ?,
        verified_recipient = ?, attestation_nonce = ? WHERE held_id = ? AND attestation_nonce IS NULL`)
        .bind(proof.sourceTxHash, proof.chain, proof.recipient, proof.nonce, id),
    ]);
    if (changed[1]?.meta.changes !== 1) return c.json({ code: 'already_attested' }, 409);
    // A malformed on-chain route id may be linked only through an independently
    // matched provider source and final NEAR delivery, never sender_id alone.
    if (row.route_id === null) await c.env.DB.prepare('UPDATE any_chain_delivery_evidence SET route_id = ? WHERE receipt_id = ? AND route_id IS NULL')
      .bind(proof.routeId, row.receipt_id).run();
    return c.json({ state: 'source_verified', heldId: id });
  } catch (error) {
    if (error instanceof ChainUnreachable) return c.json({ code: 'source_unavailable' }, 503);
    if (error instanceof Error && /UNIQUE constraint failed/.test(error.message)) return c.json({ code: 'nonce_used' }, 409);
    throw error;
  }
});

// spec: add-any-chain-feed › Held delivery refund data › reverse quote ready
// spec: add-any-chain-feed › Held delivery refund data › below return minimum
anyChainHeldReturnRoutes.post('/api/any-chain/held/:id/quote', async (c) => {
  if (!HELD.test(c.req.param('id'))) return c.json({ code: 'bad_request' }, 400);
  const id = Number(c.req.param('id'));
  const proof = attestation(await c.req.json().catch(() => null), id);
  if (!proof) return c.json({ code: 'bad_request' }, 400);
  const row = await held(c.env.DB, id);
  if (!row) return c.json({ code: 'held_missing' }, 404);
  if (row.quote_state === 'quoting' && row.reverse_quote_json === null && row.release_tx_hash === null &&
    row.attestation_nonce) {
    // No release was signed, so the held wNEAR never left custody. Once the unknown
    // provider request's two-hour deadline passes, its destination cannot be payable.
    if (row.reverse_request_deadline && Number.isFinite(Date.parse(row.reverse_request_deadline)) &&
      Date.now() >= Date.parse(row.reverse_request_deadline)) {
      await c.env.DB.prepare(`UPDATE any_chain_held_returns SET quote_state = NULL
        WHERE held_id = ? AND quote_state = 'quoting' AND reverse_quote_json IS NULL
          AND release_tx_hash IS NULL AND attestation_nonce = ? AND reverse_request_deadline = ?`)
        .bind(id, row.attestation_nonce, row.reverse_request_deadline).run();
      row.quote_state = null;
    }
  }
  if (!row.verified_recipient || !row.route_origin_asset || row.origin_chain !== proof.chain || row.verified_recipient !== proof.recipient ||
    row.source_tx_hash !== proof.sourceTxHash || row.near_tx_hash !== proof.nearTxHash || row.amount_yocto !== proof.amount ||
    (row.release_tx_hash !== null && row.release_state !== 'failed') ||
    (row.reverse_quote_json !== null && row.release_state !== 'failed' &&
      (row.release_tx_hash !== null || !expiredReverse(row.reverse_quote_json))) ||
    row.quote_state === 'quoting') return c.json({ code: 'not_quotable' }, 409);
  try {
    if (!await operatorSignature(c.env, proof) || !await linked(c, row, proof)) return c.json({ code: 'source_unverified' }, 409);
    const request = reverseRequest(c.env, row.amount_yocto, row.route_origin_asset, row.verified_recipient, c.env.TREASURY_ACCOUNT_ID);
    const requestDeadline = request.deadline as string;
    const claimSteps: D1PreparedStatement[] = [
      c.env.DB.prepare('INSERT INTO any_chain_operator_nonces (nonce, held_id, used_at) VALUES (?, ?, ?)')
        .bind(proof.nonce, id, Date.now()),
    ];
    if ((row.release_state === 'failed' || (row.reverse_quote_json && expiredReverse(row.reverse_quote_json))) &&
      row.reverse_quote_json && row.reverse_provider_reference) {
      const attempt = await c.env.DB.prepare('SELECT COALESCE(MAX(attempt), 0) AS n FROM any_chain_held_attempts WHERE held_id = ?')
        .bind(id).first<{ n: number }>();
      claimSteps.push(c.env.DB.prepare(`INSERT INTO any_chain_held_attempts
        (held_id, attempt, reverse_quote_json, provider_reference, release_tx_hash, state, recorded_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .bind(id, (attempt?.n ?? 0) + 1, row.reverse_quote_json, row.reverse_provider_reference,
          row.release_tx_hash, row.release_state === 'failed' ? 'settlement_failed' : 'expired', Date.now()));
      claimSteps.push(c.env.DB.prepare(`UPDATE any_chain_held_returns SET quote_state = 'quoting', attestation_nonce = ?, reverse_request_deadline = ?,
        reverse_quote_json = NULL, reverse_provider_reference = NULL, release_tx_hash = NULL,
        release_state = NULL WHERE held_id = ? AND (release_state = 'failed' OR release_tx_hash IS NULL)`)
        .bind(proof.nonce, requestDeadline, id));
    } else {
      claimSteps.push(c.env.DB.prepare(`UPDATE any_chain_held_returns SET quote_state = 'quoting', attestation_nonce = ?, reverse_request_deadline = ?
        WHERE held_id = ? AND quote_state IS NOT 'quoting' AND reverse_quote_json IS NULL`)
        .bind(proof.nonce, requestDeadline, id));
    }
    const claim = await c.env.DB.batch(claimSteps);
    if (claim.at(-1)?.meta.changes !== 1) return c.json({ code: 'not_quotable' }, 409);
    let quote: OneClickQuote;
    try { quote = await reverseQuote(request); }
    catch (error) {
      if (error instanceof QuoteUnavailable && error.code === 'below_return_minimum') {
        await c.env.DB.prepare("UPDATE any_chain_held_returns SET quote_state = 'below_minimum' WHERE held_id = ? AND quote_state = 'quoting'").bind(id).run();
        return c.json({ state: 'below_return_minimum', amount: row.amount_yocto });
      }
      if (error instanceof QuoteUnavailable && error.code === 'no_payable_quote') {
        await c.env.DB.prepare("UPDATE any_chain_held_returns SET quote_state = NULL WHERE held_id = ? AND quote_state = 'quoting'")
          .bind(id).run();
      }
      // Unknown outcome stays `quoting`; no second destination may be issued.
      throw error;
    }
    await c.env.DB.prepare(`UPDATE any_chain_held_returns SET quote_state = 'ready', reverse_quote_json = ?,
      reverse_provider_reference = ? WHERE held_id = ? AND quote_state = 'quoting'`)
      .bind(JSON.stringify(quote), quote.correlationId, id).run();
    return c.json({ state: 'reverse_quote_ready', quote: quote.quote, providerReference: quote.correlationId });
  } catch (error) {
    if (error instanceof ChainUnreachable || error instanceof QuoteUnavailable) return c.json({ code: 'quote_unavailable' }, 503);
    if (error instanceof Error && /UNIQUE constraint failed/.test(error.message)) return c.json({ code: 'nonce_used' }, 409);
    throw error;
  }
});

// spec: add-any-chain-feed › Held wNEAR release contract › operator release
// spec: add-any-chain-feed › Held wNEAR release contract › settlement transfer failed
anyChainHeldReturnRoutes.post('/api/any-chain/held/:id/release', async (c) => {
  if (!HELD.test(c.req.param('id'))) return c.json({ code: 'bad_request' }, 400);
  const id = Number(c.req.param('id'));
  const proof = attestation(await c.req.json().catch(() => null), id);
  const row = await held(c.env.DB, id);
  if (!proof?.releaseTxHash || !row) return c.json({ code: 'bad_request' }, 400);
  if (!row.reverse_quote_json || row.quote_state !== 'ready' || row.release_tx_hash ||
    row.reverse_provider_reference !== proof.quoteReference || row.source_tx_hash !== proof.sourceTxHash ||
    row.verified_recipient !== proof.recipient || row.origin_chain !== proof.chain ||
    row.near_tx_hash !== proof.nearTxHash || row.amount_yocto !== proof.amount) return c.json({ code: 'not_releasable' }, 409);
  const reverse = JSON.parse(row.reverse_quote_json) as OneClickQuote;
  if (expiredReverse(row.reverse_quote_json) ||
    reverse.quoteRequest.recipient !== row.verified_recipient ||
    reverse.quoteRequest.destinationAsset !== row.route_origin_asset ||
    reverse.quoteRequest.refundTo !== c.env.TREASURY_ACCOUNT_ID) return c.json({ code: 'quote_expired' }, 409);
  try {
    if (!await operatorSignature(c.env, proof)) return c.json({ code: 'operator_only' }, 403);
    const saved = await c.env.DB.batch([
      c.env.DB.prepare('INSERT INTO any_chain_operator_nonces (nonce, held_id, used_at) VALUES (?, ?, ?)')
        .bind(proof.nonce, id, Date.now()),
      c.env.DB.prepare("UPDATE any_chain_held_returns SET release_tx_hash = ?, release_state = 'in_flight' WHERE held_id = ? AND release_tx_hash IS NULL")
        .bind(proof.releaseTxHash, id),
    ]);
    if (saved[1]?.meta.changes !== 1) return c.json({ code: 'not_releasable' }, 409);
    const outcome = await releaseOutcome(c.env, proof.releaseTxHash, id, row.amount_yocto);
    if (outcome !== 'pending') await c.env.DB.prepare('UPDATE any_chain_held_returns SET release_state = ? WHERE held_id = ? AND release_tx_hash = ?')
      .bind(outcome, id, proof.releaseTxHash).run();
    if (outcome !== 'pending') await recordFinalNearExpense(c.env, {
      id: `near:release:${proof.releaseTxHash}`, routeId: row.route_id ?? row.receipt_id,
      kind: 'near_release_gas', txHash: proof.releaseTxHash, signer: c.env.CONTRACT_ID });
    return c.json({ state: outcome, nearTxHash: proof.releaseTxHash });
  } catch (error) {
    if (error instanceof ChainUnreachable) return c.json({ code: 'chain_unreachable' }, 503);
    if (error instanceof Error && /UNIQUE constraint failed/.test(error.message)) return c.json({ code: 'nonce_used' }, 409);
    throw error;
  }
});

// spec: add-any-chain-feed › Held delivery refund data › reverse exchange failed
anyChainHeldReturnRoutes.post('/api/any-chain/held/:id/recovered', async (c) => {
  if (!HELD.test(c.req.param('id'))) return c.json({ code: 'bad_request' }, 400);
  const id = Number(c.req.param('id'));
  const proof = attestation(await c.req.json().catch(() => null), id);
  const row = await held(c.env.DB, id);
  if (!proof?.recoveryTxHash || !row?.reverse_quote_json || row.release_state !== 'released' ||
    row.reverse_state === 'refunded' || !row.reverse_provider_reference ||
    proof.quoteReference !== row.reverse_provider_reference || proof.amount !== row.amount_yocto ||
    proof.nearTxHash !== row.near_tx_hash || proof.sourceTxHash !== row.source_tx_hash ||
    proof.recipient !== row.verified_recipient || proof.chain !== row.origin_chain)
    return c.json({ code: 'not_recoverable' }, 409);
  try {
    if (!await operatorSignature(c.env, proof)) return c.json({ code: 'operator_only' }, 403);
    const quote = JSON.parse(row.reverse_quote_json) as OneClickQuote;
    const status = await reverseStatus(quote);
    const providerHashes = [...(status.swapDetails?.nearTxHashes ?? []),
      ...(status.swapDetails?.originChainTxHashes?.map((item) => item.hash) ?? [])];
    if (!['FAILED', 'REFUNDED'].includes(status.status) || !providerHashes.includes(proof.recoveryTxHash) ||
      !await recoveredWnear(c.env, proof.recoveryTxHash, row.amount_yocto)) return c.json({ code: 'recovery_unverified' }, 409);
    const count = await c.env.DB.prepare('SELECT COALESCE(MAX(attempt), 0) AS n FROM any_chain_held_attempts WHERE held_id = ?')
      .bind(id).first<{ n: number }>();
    await c.env.DB.batch([
      c.env.DB.prepare('INSERT INTO any_chain_operator_nonces (nonce, held_id, used_at) VALUES (?, ?, ?)')
        .bind(proof.nonce, id, Date.now()),
      c.env.DB.prepare(`INSERT INTO any_chain_held_attempts
        (held_id, attempt, reverse_quote_json, provider_reference, release_tx_hash, recovered_tx_hash, state, recorded_at)
        VALUES (?, ?, ?, ?, ?, ?, 'recovered', ?)`)
        .bind(id, (count?.n ?? 0) + 1, row.reverse_quote_json, row.reverse_provider_reference,
          row.release_tx_hash, proof.recoveryTxHash, Date.now()),
      c.env.DB.prepare(`UPDATE any_chain_held_returns SET quote_state = NULL, reverse_quote_json = NULL,
        reverse_provider_reference = NULL, release_tx_hash = NULL, release_state = NULL,
        reverse_state = 'recovered', recovered_tx_hash = ? WHERE held_id = ? AND reverse_state IS NOT 'refunded'`)
        .bind(proof.recoveryTxHash, id),
    ]);
    return c.json({ state: 'recovered', heldId: id });
  } catch (error) {
    if (error instanceof ChainUnreachable) return c.json({ code: 'chain_unreachable' }, 503);
    if (error instanceof Error && /UNIQUE constraint failed/.test(error.message)) return c.json({ code: 'nonce_used' }, 409);
    throw error;
  }
});

// spec: add-any-chain-feed › Held delivery refund data › reverse exchange failed
// spec: add-any-chain-feed › Held delivery refund data › refund confirmed
anyChainHeldReturnRoutes.get('/api/any-chain/held/:id/status', async (c) => {
  if (!HELD.test(c.req.param('id'))) return c.json({ code: 'bad_request' }, 400);
  const row = await held(c.env.DB, Number(c.req.param('id')));
  if (!row) return c.json({ code: 'held_missing' }, 404);
  const payer = c.req.header('x-payment-id') === row.route_id && row.route_id !== null;
  const session = c.get('session');
  let owner = false;
  if (session && row.token_id) {
    try {
      const token = await rpcProvider(c.env).callFunction({ contractId: c.env.CONTRACT_ID, method: 'nft_token', args: { token_id: row.token_id } }) as { owner_id?: string } | null;
      owner = token?.owner_id === session.accountId;
    } catch { return c.json({ code: 'chain_unreachable' }, 503); }
  }
  if (!payer && !owner) return c.json({ code: 'not_found' }, 404);
  if (row.release_state === 'in_flight' && row.release_tx_hash) {
    const outcome = await releaseOutcome(c.env, row.release_tx_hash, row.held_id, row.amount_yocto);
    if (outcome !== 'pending') {
      await c.env.DB.prepare('UPDATE any_chain_held_returns SET release_state = ? WHERE held_id = ? AND release_state = ?')
        .bind(outcome, row.held_id, 'in_flight').run();
      row.release_state = outcome;
    }
  }
  if (row.release_tx_hash && (row.release_state === 'released' || row.release_state === 'failed'))
    await recordFinalNearExpense(c.env, { id: `near:release:${row.release_tx_hash}`,
      routeId: row.route_id ?? row.receipt_id, kind: 'near_release_gas',
      txHash: row.release_tx_hash, signer: c.env.CONTRACT_ID });
  if (row.reverse_quote_json && row.release_state === 'released') {
    try {
      const quote = JSON.parse(row.reverse_quote_json) as OneClickQuote;
      const status = await reverseStatus(quote);
      for (const candidate of new Set([...(status.swapDetails?.nearTxHashes ?? []),
        ...(status.swapDetails?.originChainTxHashes?.map((item) => item.hash) ?? [])]))
        await recordFinalNearExpense(c.env, { id: `near:return-deposit:${candidate}`,
          routeId: row.route_id ?? row.receipt_id, kind: 'near_return_deposit_gas',
          txHash: candidate, signer: c.env.TREASURY_ACCOUNT_ID });
      if (row.reverse_state === 'refunded') { /* Only retry the gas ledger. */ }
      else if (status.status === 'FAILED' || status.status === 'REFUNDED') {
        await c.env.DB.prepare("UPDATE any_chain_held_returns SET reverse_state = 'failed' WHERE held_id = ? AND reverse_state IS NOT 'refunded'")
          .bind(row.held_id).run();
        row.reverse_state = 'failed';
      } else if (status.status === 'SUCCESS' && row.origin_chain && row.verified_recipient &&
        status.correlationId === quote.correlationId && quote.quoteRequest.destinationAsset === row.route_origin_asset &&
        quote.quoteRequest.recipient === row.verified_recipient) {
        const hash = status.swapDetails?.destinationChainTxHashes?.[0]?.hash;
        if (hash) {
          const returnedAmount = confirmedReturn(hash, quote.quote.minAmountOut, status.swapDetails?.amountOut);
          if (returnedAmount) {
            const done = await c.env.DB.prepare(`UPDATE any_chain_held_returns SET reverse_state = 'refunded',
              refund_tx_hash = ?, refund_amount_usdc = ?, resolved_at = ? WHERE held_id = ? AND refund_tx_hash IS NULL`)
              .bind(hash, returnedAmount, Date.now(), row.held_id).run();
            if (done.meta.changes === 1) { row.reverse_state = 'refunded'; row.refund_tx_hash = hash; row.refund_amount_usdc = returnedAmount; }
            if (done.meta.changes === 1 && row.route_id) await c.env.DB.prepare(`INSERT INTO any_chain_route_status
              (route_id, provider_state, last_checked_at, resolved_at) VALUES (?, 'REFUNDED', ?, ?)
              ON CONFLICT(route_id) DO UPDATE SET resolved_at = COALESCE(resolved_at, excluded.resolved_at)`)
              .bind(row.route_id, Date.now(), Date.now()).run();
            if (row.route_id) await recordAnyChainEvent(c.env, {
              name: 'cross_chain_feed_refunded', key: `held:${row.held_id}`, routeId: row.route_id,
              tokenId: row.token_id, fields: { route: 'quote',
                ...((row.route_origin_symbol === 'USDC' || row.route_origin_asset === ORIGINS.base || row.route_origin_asset === ORIGINS.solana)
                  ? { feeUsd: usdcFee(quote.quote.refundFee) } : {}) } });
          }
        }
      } else if (status.status === 'PROCESSING') {
        row.reverse_state = 'processing';
      }
    } catch { /* Last verified evidence remains visible; no refund is inferred. */ }
  }
  if (row.route_id && (row.release_state === 'failed' || row.reverse_state === 'failed'))
    await recordAnyChainEvent(c.env, { name: 'cross_chain_feed_stalled',
      key: `held:${row.held_id}:${row.release_state === 'failed' ? 'settlement_transfer_failed' : 'reverse_exchange_failed'}`,
      routeId: row.route_id, tokenId: row.token_id, fields: { route: 'quote',
        reason: row.release_state === 'failed' ? 'settlement_transfer_failed' : 'reverse_exchange_failed',
        projectUsd: await routeProjectUsd(c.env.DB, row.route_id) } });
  const quote = row.reverse_quote_json ? JSON.parse(row.reverse_quote_json) as OneClickQuote : null;
  const previous = await c.env.DB.prepare(`SELECT provider_reference, release_tx_hash, recovered_tx_hash, state
    FROM any_chain_held_attempts WHERE held_id = ? ORDER BY attempt`).bind(row.held_id)
    .all<{ provider_reference: string; release_tx_hash: string | null; recovered_tx_hash: string | null; state: string }>();
  const usdc = row.route_origin_symbol === 'USDC' || row.route_origin_asset === ORIGINS.base || row.route_origin_asset === ORIGINS.solana;
  return c.json({ heldId: row.held_id, amount: row.amount_yocto, reason: row.reason, nearTxHash: row.near_tx_hash,
    state: row.reverse_state === 'refunded' ? 'refund_confirmed' : row.reverse_state === 'failed' ? 'reverse_exchange_failed' :
      row.release_state === 'failed' ? 'settlement_transfer_failed' : row.release_state === 'released' ? 'return_in_progress' :
      row.release_state === 'in_flight' ? 'release_in_progress' :
      row.quote_state === 'ready' ? 'reverse_quote_ready' : row.quote_state === 'below_minimum' ? 'below_return_minimum' :
      row.reverse_state === 'recovered' ? 'recovered_for_retry' :
      row.verified_recipient ? 'source_verified' : 'source_unverified',
    sourceVerified: row.verified_recipient !== null,
    ...(payer ? { recipient: row.verified_recipient, sourceTxHash: row.source_tx_hash,
      quote: quote?.quote ?? null, providerReference: row.reverse_provider_reference } : {}),
    releaseTxHash: row.release_tx_hash, refundTxHash: row.refund_tx_hash,
    refundAmount: row.refund_amount_usdc, refundAsset: row.route_origin_symbol ?? (usdc ? 'USDC' : null),
    refundDecimals: row.route_origin_decimals ?? (usdc ? 6 : null),
    refundAmountUsdc: usdc ? row.refund_amount_usdc : null,
    ...(payer ? { previousAttempts: previous.results } : {}) });
});
