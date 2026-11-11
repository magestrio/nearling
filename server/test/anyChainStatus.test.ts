import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { api, harness } from './helpers/api';
import { ONE_CLICK, ORIGINS } from '../src/any-chain/quote';
import { parseDelivery } from '../src/any-chain/status';
import { setTrackSink } from '../src/track';

const h = harness();
const route = 'a'.repeat(32);
const nearHash = 'B'.repeat(44);
const receiptId = 'C'.repeat(44);
const amount = '41396668678020066426791';
const deposit = 'D'.repeat(44);
const source = 'E'.repeat(88);
const refundHash = 'G'.repeat(88);

function receipt(events: { event: string; data: Record<string, unknown> }[], failed = false,
  txHash = nearHash, id = receiptId, message?: string, senderId = 'intents.near') {
  const args = { sender_id: senderId, amount,
    msg: message ?? JSON.stringify({ token_id: '1', route, kind: 'quote' }) };
  return { final_execution_status: 'FINAL', transaction: { hash: txHash, signer_id: senderId },
    receipts: [{ receipt_id: id, receiver_id: env.CONTRACT_ID, predecessor_id: 'wrap.near',
      receipt: { Action: { actions: [{ FunctionCall: { method_name: 'ft_on_transfer', args: btoa(JSON.stringify(args)) } }] } } }],
    receipts_outcome: [{ id, outcome: { executor_id: env.CONTRACT_ID,
      logs: failed ? [] : events.map((row) => `EVENT_JSON:${JSON.stringify({ standard: 'nearling', version: '1.0.0', ...row })}`),
      status: failed ? { Failure: {} } : { SuccessValue: '' } } }] };
}

async function routeRow() {
  await env.DB.prepare(`INSERT INTO any_chain_routes
    (id, token_id, origin_asset, amount_in, refund_to, expected_out, min_out, quote_json, state,
     created_at, request_deadline, deposit_address)
    VALUES (?, '1', ?, '150000', ?, ?, ?, '{}', 'accepted', ?, ?, ?)`)
    .bind(route, ORIGINS.solana, 'F'.repeat(44), amount, amount,
      Date.now(), new Date(Date.now() + 60_000).toISOString(), deposit).run();
}

function provider(state: string, nearHashes = [nearHash], refundedAmount = '0', refundHashes: string[] = []) {
  h.net().web.handlers.set(`${ONE_CLICK}/status?depositAddress=${deposit}`, () => Response.json({ status: state,
    correlationId: 'recorded-provider-reference', swapDetails: { originChainTxHashes: [{ hash: source }, ...refundHashes.map((hash) => ({ hash }))],
      destinationChainTxHashes: nearHashes.map((hash) => ({ hash })), refundedAmount } }));
}

// spec: add-any-chain-feed › wNEAR receipt contract › wrong token caller
it('carries a coded failed receiver transaction through QuoteStatus.reason', async () => {
  await routeRow();
  provider('FAILED');
  h.net().web.handlers.set(`${ONE_CLICK}/status?depositAddress=${deposit}`, () => Response.json({
    status: 'FAILED', correlationId: 'recorded-provider-reference',
    quoteResponse: { quoteRequest: { originAsset: ORIGINS.solana, destinationAsset: 'nep141:wrap.near',
      refundTo: 'F'.repeat(44), recipient: env.CONTRACT_ID } },
    swapDetails: { originChainTxHashes: [{ hash: source }], nearTxHashes: [nearHash], refundedAmount: '0' },
  }));
  h.net().contract.outcomes.set(nearHash, { final_execution_status: 'FINAL',
    status: { Failure: { ActionError: { kind: { FunctionCallError: {
      ExecutionError: 'Smart contract panicked: wrong_token_caller',
    } } } } },
    transaction: { hash: nearHash, signer_id: 'intents.near' },
    receipts: [], receipts_outcome: [], transaction_outcome: { outcome: { tokens_burnt: '1000' } } });
  const response = await api(`/api/any-chain/status/${route}`);
  expect(response.body.reason).toBe('token_rejected');
});

function sourceRpc(kind: 'usdc' | 'other', units: string, blockTime: number, refundUnits = '50000') {
  h.net().web.handlers.set('https://api.mainnet-beta.solana.com', ({ body }) => {
    const request = JSON.parse(body) as { params: [string] };
    const isRefund = request.params[0] === refundHash;
    const mint = isRefund || kind === 'usdc' ? 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' : 'OtherMint';
    const sent = isRefund ? refundUnits : units;
    const from = isRefund ? 'H'.repeat(44) : 'F'.repeat(44);
    const to = isRefund ? 'F'.repeat(44) : deposit;
    return Response.json({ result: { blockTime, meta: { err: null,
      preTokenBalances: [
        { accountIndex: 0, mint, owner: from, uiTokenAmount: { amount: sent } },
        { accountIndex: 1, mint, owner: to, uiTokenAmount: { amount: '0' } },
      ], postTokenBalances: [
        { accountIndex: 0, mint, owner: from, uiTokenAmount: { amount: '0' } },
        { accountIndex: 1, mint, owner: to, uiTokenAmount: { amount: sent } },
      ], innerInstructions: [] }, transaction: { message: {
        accountKeys: [{ pubkey: 'L'.repeat(44) }, { pubkey: 'M'.repeat(44) }],
        instructions: [{ program: 'spl-token', parsed: { type: 'transferChecked',
          info: { source: 'L'.repeat(44), destination: 'M'.repeat(44), mint,
            tokenAmount: { amount: sent } } } }],
      } } } });
  });
}

describe('any-chain status', () => {
  // spec: add-any-chain-feed › Cross-chain settlement data › recovery after unknown outcome
  it('keeps an acceptance with no known destination on its original id as unknown', async () => {
    await routeRow();
    await env.DB.prepare("UPDATE any_chain_routes SET state = 'accepting', deposit_address = NULL WHERE id = ?")
      .bind(route).run();
    const status = await api(`/api/any-chain/status/${route}`);
    expect(status.body).toMatchObject({ id: route, state: 'unknown_outcome', deliveries: [] });
    expect(status.body).toMatchObject({ sourceAmount: '150000', sourceAsset: 'USDC', sourceChain: 'solana',
      providerStatusUrl: null });
    expect((await env.DB.prepare('SELECT state, deposit_address FROM any_chain_routes WHERE id = ?')
      .bind(route).first<{ state: string; deposit_address: string | null }>()))
      .toEqual({ state: 'accepting', deposit_address: null });
  });

  // spec: add-any-chain-feed › Cross-chain quote data › status link shared
  it('returns the quoted source amount, path and a usable provider status URL on the bearer link', async () => {
    await routeRow();
    provider('PENDING_DEPOSIT', []);
    const response = await api(`/api/any-chain/status/${route}`);
    expect(response.body).toMatchObject({ sourceAmount: '150000', sourceAsset: 'USDC', sourceChain: 'solana' });
    const link = new URL(response.body.providerStatusUrl as string);
    expect(`${link.origin}${link.pathname}`).toBe(`${ONE_CLICK}/status`);
    expect(link.searchParams.get('depositAddress')).toBe(deposit);
  });

  // spec: add-any-chain-feed › Cross-chain quote data › status read leaves browser
  // spec: add-any-chain-feed › Cross-chain settlement data › recovery after unknown outcome
  it('never makes provider SUCCESS into food when the real receiver failed and refundedAmount is zero', async () => {
    await routeRow();
    provider('SUCCESS');
    h.net().contract.outcomes.set(nearHash, receipt([], true));
    const response = await api(`/api/any-chain/status/${route}`);
    expect(response.status).toBe(200);
    expect(response.body.state).toBe('delivery_unverified');
    expect(response.body.deliveries).toEqual([]);
    expect(response.body.providerRefundAmount).toBeNull();
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM any_chain_credit_evidence').first<{ n: number }>())?.n).toBe(0);
  });

  // spec: add-any-chain-feed › Cross-chain settlement data › credited once
  it('records one contract credit from a final receipt and ignores poll replay', async () => {
    await routeRow();
    provider('SUCCESS');
    h.net().contract.outcomes.set(nearHash, receipt([
      { event: 'cross_chain_pending', data: { credit_id: 9, token_id: '1', route_id: route, amount, kind: 'quote' } },
      { event: 'cross_chain_feed', data: { credit_id: 9, token_id: '1', route_id: route, amount, kind: 'quote' } },
    ]));
    const events: string[] = [];
    const reset = setTrackSink((name) => events.push(name));
    try {
      expect((await api(`/api/any-chain/status/${route}`)).body.state).toBe('food');
      expect((await api(`/api/any-chain/status/${route}`)).body.deliveries).toHaveLength(1);
    } finally { reset(); }
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM any_chain_credit_evidence').first<{ n: number }>())?.n).toBe(1);
    expect(events).toEqual(['pet_fed']);
  });

  // spec: add-any-chain-feed › wNEAR receipt contract › second real delivery on one route
  // spec: add-any-chain-feed › Cross-chain settlement data › credited once
  it('keeps a second real delivery separate on the same quote', async () => {
    await routeRow();
    const secondHash = 'Z'.repeat(44);
    provider('SUCCESS', [nearHash, secondHash]);
    h.net().contract.outcomes.set(nearHash, receipt([
      { event: 'cross_chain_pending', data: { credit_id: 9, token_id: '1', route_id: route, amount } },
      { event: 'cross_chain_feed', data: { credit_id: 9, token_id: '1', route_id: route, amount } },
    ]));
    h.net().contract.outcomes.set(secondHash, receipt([
      { event: 'cross_chain_pending', data: { credit_id: 10, token_id: '1', route_id: route, amount } },
      { event: 'cross_chain_feed', data: { credit_id: 10, token_id: '1', route_id: route, amount } },
    ], false, secondHash, 'Y'.repeat(44)));
    const first = await api(`/api/any-chain/status/${route}`);
    expect(first.body.deliveries.map((item: { creditId: number }) => item.creditId)).toEqual([9, 10]);
    expect((await api(`/api/any-chain/status/${route}`)).body.deliveries).toHaveLength(2);
  });

  // spec: add-any-chain-feed › wNEAR unwrap contract › unwrap failed
  // spec: add-any-chain-feed › Cross-chain settlement data › recovery after unknown outcome
  it('distinguishes a failed unwrap callback from an in-flight credit and from held custody', async () => {
    await routeRow();
    provider('SUCCESS');
    const raw = receipt([
      { event: 'cross_chain_pending', data: { credit_id: 9, token_id: '1', route_id: route, amount } },
    ]) as unknown as { receipts: unknown[]; receipts_outcome: unknown[] };
    raw.receipts.push({ receipt_id: 'W'.repeat(44), receiver_id: 'wrap.near', predecessor_id: env.CONTRACT_ID,
      receipt: { Action: { actions: [{ FunctionCall: { method_name: 'near_withdraw', args: btoa(JSON.stringify({ amount })) } }] } } });
    raw.receipts_outcome.push({ id: 'W'.repeat(44), outcome: { executor_id: 'wrap.near', logs: [], status: { Failure: {} } } });
    raw.receipts.push({ receipt_id: 'X'.repeat(44), receiver_id: env.CONTRACT_ID, predecessor_id: env.CONTRACT_ID,
      receipt: { Action: { actions: [{ FunctionCall: { method_name: 'on_unwrap', args: btoa(JSON.stringify({ credit_id: 9 })) } }] } } });
    raw.receipts_outcome.push({ id: 'X'.repeat(44), outcome: { executor_id: env.CONTRACT_ID, logs: [], status: { SuccessValue: '' } } });
    h.net().contract.outcomes.set(nearHash, raw);
    const status = await api(`/api/any-chain/status/${route}`);
    expect(status.body.state).toBe('unwrap_failed');
    expect(status.body.deliveries[0]).toMatchObject({ creditId: 9, unwrapFailed: true, creditedAmount: null });
  });

  // spec: add-any-chain-feed › Cross-chain settlement data › held delivery reconciled
  it('preserves a held receipt and reason despite provider SUCCESS', async () => {
    await routeRow();
    provider('SUCCESS');
    h.net().contract.outcomes.set(nearHash, receipt([
      { event: 'cross_chain_held', data: { delivery_id: 4, route_id: route, token_id: '1', amount,
        sender_id: 'intents.near', reason: 'capacity' } },
    ]));
    const response = await api(`/api/any-chain/status/${route}`);
    expect(response.body.state).toBe('held');
    expect(response.body.deliveries[0]).toMatchObject({ heldId: 4, amount, reason: 'capacity', nearTxHash: nearHash });
  });

  // spec: add-any-chain-feed › wNEAR receipt contract › pending cap reached
  // spec: add-any-chain-feed › wNEAR receipt contract › pending storage unavailable
  it('keeps separate cap and stake held evidence across repeated status reads', async () => {
    await routeRow();
    const otherHash = 'Z'.repeat(44);
    provider('SUCCESS', [nearHash, otherHash]);
    h.net().contract.outcomes.set(nearHash, receipt([
      { event: 'cross_chain_held', data: { delivery_id: 4, route_id: route, token_id: '1', amount,
        sender_id: 'intents.near', reason: 'capacity' } },
    ]));
    h.net().contract.outcomes.set(otherHash, receipt([
      { event: 'cross_chain_held', data: { delivery_id: 5, route_id: route, token_id: '1', amount,
        sender_id: 'intents.near', reason: 'storage_unavailable' } },
    ], false, otherHash, 'Y'.repeat(44)));
    const first = await api(`/api/any-chain/status/${route}`);
    expect(first.body.deliveries.map((item: { reason: string }) => item.reason))
      .toEqual(['capacity', 'storage_unavailable']);
    expect((await api(`/api/any-chain/status/${route}`)).body.deliveries).toHaveLength(2);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM any_chain_held_returns').first<{ n: number }>())?.n).toBe(2);
  });

  // spec: add-any-chain-feed › Cross-chain settlement data › held delivery reconciled
  it('matches a route-less held event through the quoted provider trace and public NEAR receipt', async () => {
    await routeRow();
    h.net().web.handlers.set(`${ONE_CLICK}/status?depositAddress=${deposit}`, () => Response.json({ status: 'SUCCESS',
      correlationId: 'recorded-provider-reference',
      quoteResponse: { quoteRequest: { originAsset: ORIGINS.solana, destinationAsset: 'nep141:wrap.near',
        refundTo: 'F'.repeat(44), recipient: env.CONTRACT_ID } },
      swapDetails: { originChainTxHashes: [{ hash: source }], nearTxHashes: [nearHash], refundedAmount: '0' },
    }));
    h.net().contract.outcomes.set(nearHash, receipt([
      { event: 'cross_chain_held', data: { delivery_id: 5, token_id: '1', amount,
        sender_id: 'intents.near', reason: 'invalid_route' } },
    ], false, nearHash, receiptId, 'broken-message'));
    const status = await api(`/api/any-chain/status/${route}`);
    expect(status.body).toMatchObject({ state: 'held', deliveries: [{ heldId: 5, reason: 'invalid_route', amount }] });
    const held = await api('/api/any-chain/held/5/status', { headers: { 'x-payment-id': route } });
    expect(held.body).toMatchObject({ state: 'source_unverified', amount, reason: 'invalid_route', nearTxHash: nearHash });
    expect(held.body.refundTxHash).toBeNull();
  });

  // spec: add-any-chain-feed › wNEAR receipt contract › wrong sender
  // spec: add-any-chain-feed › Cross-chain settlement data › held delivery reconciled
  it('observes an independently sent wrong-sender receipt without calling it food', async () => {
    await routeRow();
    h.net().contract.outcomes.set(nearHash, receipt([
      { event: 'cross_chain_held', data: { delivery_id: 6, route_id: route, token_id: '1', amount,
        sender_id: 'wrong.near', reason: 'wrong_sender' } },
    ], false, nearHash, receiptId, undefined, 'wrong.near'));
    const observed = await api('/api/any-chain/deliveries/observe', { body: { nearTxHash: nearHash, signerId: 'wrong.near' } });
    expect(observed.body.deliveries).toMatchObject([{ heldId: 6, amount, reason: 'wrong_sender' }]);
    const status = await api(`/api/any-chain/status/${route}`);
    expect(status.body.state).toBe('held');
    expect(status.body.deliveries[0].creditedAmount).toBeNull();
  });

  // spec: add-any-chain-feed › Cross-chain quote flow › source transfer pending
  it('reports source pending without a destination and keeps failure separate', async () => {
    await routeRow();
    provider('PENDING_DEPOSIT', []);
    expect((await api(`/api/any-chain/status/${route}`)).body.state).toBe('source_pending');
    provider('FAILED', []);
    expect((await api(`/api/any-chain/status/${route}`)).body.state).toBe('provider_failed');
  });

  // spec: add-any-chain-feed › Cross-chain quote flow › source transfer pending
  it('keeps a finalized source transfer pending until a distinct NEAR food event', async () => {
    await routeRow();
    sourceRpc('usdc', '150000', Math.floor(Date.now() / 1000));
    provider('PROCESSING', []);
    const status = await api(`/api/any-chain/status/${route}`);
    expect(status.body).toMatchObject({ state: 'source_transfer_pending', sourceTxHash: source,
      sourceCondition: 'observed', deliveries: [] });
  });

  // spec: add-any-chain-feed › Cross-chain quote flow › unknown outcome
  it('keeps the accepted payment id when the provider cannot answer', async () => {
    await routeRow();
    h.net().web.handlers.set(`${ONE_CLICK}/status?depositAddress=${deposit}`, () => { throw new TypeError('network down'); });
    const response = await api(`/api/any-chain/status/${route}`);
    expect(response.body).toMatchObject({ id: route, state: 'unknown_outcome', deliveries: [] });
    const saved = await env.DB.prepare('SELECT id, deposit_address FROM any_chain_routes WHERE id = ?').bind(route)
      .first<{ id: string; deposit_address: string }>();
    expect(saved).toMatchObject({ id: route, deposit_address: deposit });
  });

  // spec: add-any-chain-feed › Cross-chain quote flow › transfer too small
  // spec: add-any-chain-feed › Cross-chain quote flow › transfer after deadline
  // spec: add-any-chain-feed › Cross-chain quote flow › wrong asset sent
  it('uses finalized source evidence for small, late and wrong-asset transfers', async () => {
    await routeRow();
    provider('INCOMPLETE_DEPOSIT', []);
    sourceRpc('usdc', '100000', Math.floor(Date.now() / 1000));
    expect((await api(`/api/any-chain/status/${route}`)).body.state).toBe('transfer_too_small');
    sourceRpc('usdc', '150000', Math.floor(Date.now() / 1000) + 120);
    expect((await api(`/api/any-chain/status/${route}`)).body.state).toBe('transfer_late');
    sourceRpc('other', '150000', Math.floor(Date.now() / 1000));
    expect((await api(`/api/any-chain/status/${route}`)).body.state).toBe('wrong_asset');
  });

  // spec: add-any-chain-feed › Cross-chain quote flow › provider refund
  // spec: add-any-chain-feed › Cross-chain quote flow › excess input refunded
  it('claims a provider refund only with an actual origin-chain USDC transfer', async () => {
    await routeRow();
    sourceRpc('usdc', '150000', Math.floor(Date.now() / 1000));
    provider('REFUNDED', [], '50000');
    expect((await api(`/api/any-chain/status/${route}`)).body.state).toBe('provider_refund_unverified');
    provider('REFUNDED', [], '50000', [refundHash]);
    const refunded = await api(`/api/any-chain/status/${route}`);
    expect(refunded.body).toMatchObject({ state: 'provider_refunded', providerRefundAmount: '50000', providerRefundTxHash: refundHash });
  });

  // spec: add-any-chain-feed › Cross-chain quote flow › excess input refunded
  it('shows a separate proven excess refund beside an actual NEAR food credit', async () => {
    await routeRow();
    sourceRpc('usdc', '150000', Math.floor(Date.now() / 1000));
    provider('SUCCESS', [nearHash], '50000', [refundHash]);
    h.net().contract.outcomes.set(nearHash, receipt([
      { event: 'cross_chain_pending', data: { credit_id: 9, token_id: '1', route_id: route, amount } },
      { event: 'cross_chain_feed', data: { credit_id: 9, token_id: '1', route_id: route, amount } },
    ]));
    const status = await api(`/api/any-chain/status/${route}`);
    expect(status.body).toMatchObject({ state: 'food_excess_refunded', providerRefundTxHash: refundHash,
      providerRefundAmount: '50000' });
    expect(status.body.deliveries[0].creditedAmount).toBe(amount);
  });

  it('rejects event text with no matching wrap.near transfer call', () => {
    const raw = receipt([{ event: 'cross_chain_feed', data: { credit_id: 9, amount, route_id: route } }]);
    expect(parseDelivery(raw, nearHash, env.CONTRACT_ID)).toEqual([]);
  });
});
