import { env } from 'cloudflare:workers';
import { baseEncode, KeyPairEd25519 } from 'near-api-js';
import { describe, expect, it } from 'vitest';
import { api, harness } from './helpers/api';
import { NEAR_ACCOUNT, token } from './helpers/network';
import { attestationBytes, type Attestation } from '../src/any-chain/held';
import { ONE_CLICK, ORIGINS, WNEAR } from '../src/any-chain/quote';

const h = harness();
const route = 'a'.repeat(32);
const nearHash = 'B'.repeat(44);
const sourceHash = 'E'.repeat(88);
const refundHash = 'G'.repeat(88);
const receiptId = 'C'.repeat(44);
const deposit = 'D'.repeat(44);
const recipient = 'F'.repeat(44);
const amount = '10000000000000000000000';
const providerReference = 'forward-reference';

async function seed(): Promise<void> {
  await env.DB.prepare(`INSERT INTO any_chain_routes
    (id, token_id, origin_asset, amount_in, refund_to, expected_out, min_out, quote_json,
     state, created_at, request_deadline, deposit_address)
    VALUES (?, '1', ?, '150000', ?, ?, ?, '{}', 'accepted', ?, ?, ?)`)
    .bind(route, ORIGINS.solana, recipient, amount, amount,
      Date.now(), new Date(Date.now() + 60_000).toISOString(), deposit).run();
  await env.DB.prepare(`INSERT INTO any_chain_delivery_evidence
    (receipt_id, route_id, token_id, near_tx_hash, amount_yocto, kind, held_id, held_reason, recorded_at)
    VALUES (?, ?, '1', ?, ?, 'held', 4, 'capacity', ?)`)
    .bind(receiptId, route, nearHash, amount, Date.now()).run();
  await env.DB.prepare(`INSERT INTO any_chain_held_returns (held_id, receipt_id, amount_yocto, reason)
    VALUES (4, ?, ?, 'capacity')`).bind(receiptId, amount).run();
  const args = { sender_id: 'intents.near', amount, msg: JSON.stringify({ token_id: '1', route, kind: 'quote' }) };
  h.net().contract.outcomes.set(nearHash, { final_execution_status: 'FINAL',
    transaction: { hash: nearHash, signer_id: 'intents.near' },
    receipts: [{ receipt_id: receiptId, receiver_id: env.CONTRACT_ID, predecessor_id: 'wrap.near',
      receipt: { Action: { actions: [{ FunctionCall: { method_name: 'ft_on_transfer', args: btoa(JSON.stringify(args)) } }] } } }],
    receipts_outcome: [{ id: receiptId, outcome: { executor_id: env.CONTRACT_ID,
      logs: [`EVENT_JSON:${JSON.stringify({ standard: 'nearling', version: '1.0.0', event: 'cross_chain_held',
        data: { delivery_id: 4, amount, reason: 'capacity', route_id: route, token_id: '1',
          sender_id: 'intents.near' } })}`],
      status: { SuccessValue: '' } } }] });
  h.net().web.handlers.set(`${ONE_CLICK}/status?depositAddress=${deposit}`, () => Response.json({ status: 'SUCCESS',
    correlationId: providerReference,
    quoteResponse: { quoteRequest: { refundTo: recipient, originAsset: ORIGINS.solana,
      destinationAsset: WNEAR, recipient: env.CONTRACT_ID } },
    swapDetails: { depositedAmount: '150000', originChainTxHashes: [{ hash: sourceHash }], nearTxHashes: [nearHash] } }));
  h.net().web.handlers.set('https://api.mainnet-beta.solana.com', ({ body }) => {
    const request = JSON.parse(body) as { params: [string] };
    if (request.params[0] === sourceHash) return Response.json({ result: solanaTransfer(recipient, deposit, '150000') });
    if (request.params[0] === refundHash) return Response.json({ result: solanaTransfer('H'.repeat(44), recipient, '27215') });
    return Response.json({ result: null });
  });
}

function solanaTransfer(sender: string, receiver: string, units: string) {
  const token = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  return { meta: { err: null,
    preTokenBalances: [
      { accountIndex: 0, mint: token, owner: sender, uiTokenAmount: { amount: units } },
      { accountIndex: 1, mint: token, owner: receiver, uiTokenAmount: { amount: '0' } },
    ], postTokenBalances: [
      { accountIndex: 0, mint: token, owner: sender, uiTokenAmount: { amount: '0' } },
      { accountIndex: 1, mint: token, owner: receiver, uiTokenAmount: { amount: units } },
    ] }, transaction: { message: { accountKeys: [{ pubkey: 'L'.repeat(44) }, { pubkey: 'M'.repeat(44) }],
      instructions: [{ program: 'spl-token', parsed: { type: 'transferChecked',
        info: { source: 'L'.repeat(44), destination: 'M'.repeat(44), mint: token,
          tokenAmount: { amount: units } } } }] } } };
}

function releaseTx(txHash: string, event: string) {
  return { final_execution_status: 'FINAL', transaction: { hash: txHash, signer_id: env.CONTRACT_ID,
    receiver_id: env.CONTRACT_ID, actions: [{ FunctionCall: { method_name: 'held_refund_release',
      args: btoa(JSON.stringify({ delivery_id: 4, amount, settlement_account: env.TREASURY_ACCOUNT_ID })) } }] },
    receipts_outcome: [{ outcome: { executor_id: env.CONTRACT_ID,
      logs: [`EVENT_JSON:${JSON.stringify({ standard: 'nearling', event,
        data: { delivery_id: 4, amount, settlement_account: env.TREASURY_ACCOUNT_ID } })}`] } }] };
}

async function readyQuote(): Promise<void> {
  const deadline = new Date(Date.now() + 60_000).toISOString();
  await env.DB.prepare(`UPDATE any_chain_held_returns SET source_tx_hash = ?, origin_chain = 'solana',
    verified_recipient = ?, quote_state = 'ready', reverse_provider_reference = 'reverse-reference',
    reverse_quote_json = ? WHERE held_id = 4`)
    .bind(sourceHash, recipient, JSON.stringify({ quoteRequest: { originAsset: WNEAR,
      destinationAsset: ORIGINS.solana, amount, recipient, refundTo: env.TREASURY_ACCOUNT_ID },
      quote: { amountIn: amount, amountOut: '27356', minAmountOut: '27082', refundFee: '0', withdrawFee: '10031',
        depositAddress: 'a'.repeat(64), deadline, timeWhenInactive: deadline }, correlationId: 'reverse-reference' })).run();
}

async function proof(key: KeyPairEd25519, overrides: Partial<Attestation> = {}): Promise<Attestation> {
  const value: Attestation = { heldId: 4, routeId: route, nearTxHash: nearHash, sourceTxHash: sourceHash,
    amount, chain: 'solana', recipient, quoteReference: providerReference,
    nonce: crypto.randomUUID().replaceAll('-', ''), publicKey: key.getPublicKey().toString(), signature: '', ...overrides };
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', attestationBytes(value)));
  value.signature = baseEncode(key.sign(digest).signature);
  return value;
}

describe('held delivery return', () => {
  // spec: add-any-chain-feed › Held delivery refund data › source verified
  // spec: add-any-chain-feed › Held delivery refund data › reverse quote ready
  // spec: add-any-chain-feed › Held delivery refund data › refund confirmed
  it('returns a newly offered origin asset to the quote refund address using matched 1-Click evidence', async () => {
    await seed();
    const asset = 'nep141:eth-asset.omft.near';
    const chain = 'ethereum';
    const refundTo = `0x${'1'.repeat(40)}`;
    const source = `0x${'2'.repeat(64)}`;
    const refund = `0x${'3'.repeat(64)}`;
    await env.DB.prepare(`UPDATE any_chain_routes SET origin_asset = ?, origin_chain = ?,
      origin_symbol = 'WETH', origin_decimals = 18, refund_to = ? WHERE id = ?`)
      .bind(asset, chain, refundTo, route).run();
    h.net().web.handlers.set(`${ONE_CLICK}/status?depositAddress=${deposit}`, () => Response.json({ status: 'SUCCESS',
      correlationId: providerReference,
      quoteResponse: { quoteRequest: { refundTo, originAsset: asset,
        destinationAsset: WNEAR, recipient: env.CONTRACT_ID } },
      swapDetails: { originChainTxHashes: [{ hash: source }], nearTxHashes: [nearHash] } }));
    const key = KeyPairEd25519.fromRandom();
    const first = await proof(key, { chain, sourceTxHash: source, recipient: refundTo });
    h.net().contract.operatorKeys = [{ public_key: first.publicKey,
      access_key: { nonce: 1, permission: 'FullAccess' } }];
    const unrelated = await proof(key, { chain, sourceTxHash: `0x${'4'.repeat(64)}`, recipient: refundTo });
    expect((await api('/api/any-chain/held/4/attest', { body: unrelated })).body.code).toBe('source_unverified');
    expect((await api('/api/any-chain/held/4/attest', { body: first })).body.state).toBe('source_verified');
    const requests: Record<string, unknown>[] = [];
    h.net().web.handlers.set(`${ONE_CLICK}/quote`, ({ body }) => {
      const request = JSON.parse(body) as Record<string, unknown>;
      requests.push(request);
      return Response.json({ quoteRequest: request, correlationId: 'reverse-reference', signature: 'recorded',
        quote: { amountIn: amount, amountOut: '10000000000000000', minAmountOut: '9900000000000000',
          refundFee: '0', withdrawFee: '0', depositAddress: 'a'.repeat(64),
          deadline: request.deadline, timeWhenInactive: request.deadline } });
    });
    expect((await api('/api/any-chain/held/4/quote', { body: await proof(key, {
      chain, sourceTxHash: source, recipient: refundTo,
    }) })).body.state).toBe('reverse_quote_ready');
    expect(requests[0]).toMatchObject({ originAsset: WNEAR, destinationAsset: asset,
      recipient: refundTo, refundTo: env.TREASURY_ACCOUNT_ID });
    await env.DB.prepare("UPDATE any_chain_held_returns SET release_state = 'released', release_tx_hash = ? WHERE held_id = 4")
      .bind('K'.repeat(44)).run();
    h.net().web.handlers.set(`${ONE_CLICK}/status?depositAddress=${'a'.repeat(64)}`, () => Response.json({
      status: 'SUCCESS', correlationId: 'reverse-reference',
      swapDetails: { destinationChainTxHashes: [{ hash: refund }], amountOut: '9950000000000000' },
    }));
    const status = await api('/api/any-chain/held/4/status', { headers: { 'x-payment-id': route } });
    expect(status.body).toMatchObject({ state: 'refund_confirmed', refundTxHash: refund,
      refundAmount: '9950000000000000', refundAsset: 'WETH', refundDecimals: 18,
      refundAmountUsdc: null, recipient: refundTo });
    const event = await env.EVENTS.prepare("SELECT fee_usd FROM any_chain_events WHERE name = 'cross_chain_feed_refunded'")
      .first<{ fee_usd: number | null }>();
    // The harness clock is 2036, after event retention ends; status still retains the return proof.
    expect(event).toBeNull();
    expect(h.logs()).toEqual([]);
  });
  // spec: add-any-chain-feed › Held delivery refund data › source verified
  // spec: add-any-chain-feed › Held delivery refund data › source unverified
  it('requires a contract full-access signature and matched source transfer, then consumes the nonce', async () => {
    await seed();
    const key = KeyPairEd25519.fromRandom();
    const signed = await proof(key);
    h.net().contract.operatorKeys = [{ public_key: signed.publicKey, access_key: { nonce: 1,
      permission: { FunctionCall: { receiver_id: env.CONTRACT_ID, method_names: ['retry_unwrap'] } } } }];
    const denied = await api('/api/any-chain/held/4/attest', { body: signed });
    expect({ denied, logs: h.logs() }).toMatchObject({ denied: { status: 409, body: { code: 'source_unverified' } }, logs: [] });
    h.net().contract.operatorKeys = [{ public_key: signed.publicKey, access_key: { nonce: 1, permission: 'FullAccess' } }];
    const approved = await api('/api/any-chain/held/4/attest', { body: signed });
    expect({ approved, logs: h.logs() }).toMatchObject({ approved: { status: 200, body: { state: 'source_verified' } }, logs: [] });
    expect((await api('/api/any-chain/held/4/attest', { body: signed })).status).toBe(409);
    expect((await api('/api/any-chain/held/4/status', { method: 'GET' })).status).toBe(404);
    const payer = await api('/api/any-chain/held/4/status', { headers: { 'x-payment-id': route } });
    expect(payer.body).toMatchObject({ state: 'source_verified', recipient, amount, nearTxHash: nearHash });
  });

  // spec: add-any-chain-feed › Held delivery refund data › source unverified
  it('keeps a mismatched refund recipient held and never starts a reverse quote', async () => {
    await seed();
    const key = KeyPairEd25519.fromRandom();
    const signed = await proof(key, { recipient: 'J'.repeat(44) });
    h.net().contract.operatorKeys = [{ public_key: signed.publicKey, access_key: { nonce: 1, permission: 'FullAccess' } }];
    const mismatch = await api('/api/any-chain/held/4/attest', { body: signed });
    expect({ mismatch, logs: h.logs() }).toMatchObject({ mismatch: { status: 409, body: { code: 'source_unverified' } }, logs: [] });
    const row = await env.DB.prepare('SELECT verified_recipient FROM any_chain_held_returns WHERE held_id = 4')
      .first<{ verified_recipient: string | null }>();
    expect(row?.verified_recipient).toBeNull();
  });

  // spec: add-any-chain-feed › Held delivery refund data › reverse quote ready
  // spec: add-any-chain-feed › Held delivery refund data › refund confirmed
  it('quotes only after attestation and confirms the actual source-chain USDC transfer', async () => {
    await seed();
    const key = KeyPairEd25519.fromRandom();
    const first = await proof(key);
    h.net().contract.operatorKeys = [{ public_key: first.publicKey, access_key: { nonce: 1, permission: 'FullAccess' } }];
    expect((await api('/api/any-chain/held/4/attest', { body: first })).status).toBe(200);
    const calls: Record<string, unknown>[] = [];
    h.net().web.handlers.set(`${ONE_CLICK}/quote`, ({ body }) => {
      const request = JSON.parse(body) as Record<string, unknown>;
      calls.push(request);
      return Response.json({ quoteRequest: request, correlationId: 'reverse-reference', signature: 'recorded',
        quote: { amountIn: amount, amountInUsd: '0.0376', amountOut: '27356', amountOutUsd: '0.0273',
          minAmountOut: '27082', refundFee: '0', withdrawFee: '10031', timeEstimate: 19,
          depositAddress: 'a'.repeat(64), deadline: request.deadline, timeWhenInactive: request.deadline } });
    });
    const second = await proof(key);
    const quoted = await api('/api/any-chain/held/4/quote', { body: second });
    expect(quoted.body.state).toBe('reverse_quote_ready');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ originAsset: WNEAR, destinationAsset: ORIGINS.solana,
      recipient, refundTo: env.TREASURY_ACCOUNT_ID, amount, dry: false });
    expect((await api('/api/any-chain/held/4/quote', { body: second })).status).toBe(409);
    await env.DB.prepare("UPDATE any_chain_held_returns SET release_state = 'released', release_tx_hash = ? WHERE held_id = 4")
      .bind('K'.repeat(44)).run();
    h.net().web.handlers.set(`${ONE_CLICK}/status?depositAddress=${'a'.repeat(64)}`, () => Response.json({
      status: 'SUCCESS', correlationId: 'reverse-reference',
      swapDetails: { destinationChainTxHashes: [{ hash: refundHash }], amountOut: '27215' },
    }));
    const payer = await api('/api/any-chain/held/4/status', { headers: { 'x-payment-id': route } });
    expect(payer.body).toMatchObject({ state: 'refund_confirmed', refundTxHash: refundHash,
      refundAmountUsdc: '27215', recipient });
    expect((await api('/api/any-chain/held/4/status', { headers: { 'x-payment-id': route } })).body.state).toBe('refund_confirmed');
    const ownerId = NEAR_ACCOUNT(91);
    h.net().contract.addPet('1', ownerId);
    const owner = await api('/api/any-chain/held/4/status', { token: await token('did:privy:held-owner-refund', ownerId) });
    expect(owner.body).toMatchObject({ state: 'refund_confirmed', refundAmountUsdc: '27215',
      refundTxHash: refundHash, releaseTxHash: 'K'.repeat(44) });
    expect(owner.body).not.toHaveProperty('recipient');
    expect(owner.body).not.toHaveProperty('previousAttempts');
  });

  // spec: add-any-chain-feed › Held wNEAR release contract › settlement transfer failed
  // spec: add-any-chain-feed › Held delivery refund data › reverse quote ready
  it('keeps a failed settlement transfer separate and allows a fresh quote after its proof', async () => {
    await seed();
    await readyQuote();
    const key = KeyPairEd25519.fromRandom();
    h.net().contract.operatorKeys = [{ public_key: key.getPublicKey().toString(), access_key: { nonce: 1, permission: 'FullAccess' } }];
    const txHash = 'K'.repeat(44);
    h.net().contract.outcomes.set(txHash, releaseTx(txHash, 'cross_chain_held_release_failed'));
    const signed = await proof(key, { quoteReference: 'reverse-reference', releaseTxHash: txHash });
    const sent = await api('/api/any-chain/held/4/release', { body: signed });
    expect(sent.body).toMatchObject({ state: 'failed', nearTxHash: txHash });
    const status = await api('/api/any-chain/held/4/status', { headers: { 'x-payment-id': route } });
    expect(status.body).toMatchObject({ state: 'settlement_transfer_failed', refundTxHash: null });
    expect((await api('/api/any-chain/held/4/release', { body: signed })).status).toBe(409);
    h.net().web.handlers.set(`${ONE_CLICK}/quote`, ({ body }) => {
      const request = JSON.parse(body) as Record<string, unknown>;
      return Response.json({ quoteRequest: request, correlationId: 'new-reverse-reference', signature: 'recorded',
        quote: { amountIn: amount, amountInUsd: '0.0376', amountOut: '27356', amountOutUsd: '0.0273',
          minAmountOut: '27082', refundFee: '0', withdrawFee: '10031', timeEstimate: 19,
          depositAddress: 'b'.repeat(64), deadline: request.deadline, timeWhenInactive: request.deadline } });
    });
    const newQuote = await api('/api/any-chain/held/4/quote', { body: await proof(key) });
    expect(newQuote.body.state).toBe('reverse_quote_ready');
    const attempts = await env.DB.prepare('SELECT state, release_tx_hash FROM any_chain_held_attempts WHERE held_id = 4')
      .all<{ state: string; release_tx_hash: string }>();
    expect(attempts.results).toMatchObject([{ state: 'settlement_failed', release_tx_hash: txHash }]);
  });

  // spec: add-any-chain-feed › Held wNEAR release contract › operator release
  it('keeps an unknown release transaction in flight and refuses a second release', async () => {
    await seed();
    await readyQuote();
    const key = KeyPairEd25519.fromRandom();
    h.net().contract.operatorKeys = [{ public_key: key.getPublicKey().toString(), access_key: { nonce: 1, permission: 'FullAccess' } }];
    const releaseHash = 'K'.repeat(44);
    const signed = await proof(key, { quoteReference: 'reverse-reference', releaseTxHash: releaseHash });
    expect((await api('/api/any-chain/held/4/release', { body: signed })).body.state).toBe('pending');
    expect((await api('/api/any-chain/held/4/release', { body: await proof(key, {
      quoteReference: 'reverse-reference', releaseTxHash: 'L'.repeat(44),
    }) })).body.code).toBe('not_releasable');
    const status = await api('/api/any-chain/held/4/status', { headers: { 'x-payment-id': route } });
    expect(status.body).toMatchObject({ state: 'release_in_progress', releaseTxHash: releaseHash, refundTxHash: null });
  });

  // spec: add-any-chain-feed › Held wNEAR release contract › operator release
  it('records a successful NEAR release as return in progress, never as a source refund', async () => {
    await seed();
    await readyQuote();
    const key = KeyPairEd25519.fromRandom();
    h.net().contract.operatorKeys = [{ public_key: key.getPublicKey().toString(), access_key: { nonce: 1, permission: 'FullAccess' } }];
    const releaseHash = 'K'.repeat(44);
    h.net().contract.outcomes.set(releaseHash, releaseTx(releaseHash, 'cross_chain_held_released'));
    const signed = await proof(key, { quoteReference: 'reverse-reference', releaseTxHash: releaseHash });
    expect((await api('/api/any-chain/held/4/release', { body: signed })).body.state).toBe('released');
    const status = await api('/api/any-chain/held/4/status', { headers: { 'x-payment-id': route } });
    expect(status.body).toMatchObject({ state: 'return_in_progress', releaseTxHash: releaseHash,
      refundTxHash: null, refundAmountUsdc: null });
  });

  // spec: add-any-chain-feed › Held delivery refund data › reverse quote ready × quote expiry before release
  it('refuses to record a release against an expired reverse quote', async () => {
    await seed();
    await readyQuote();
    const row = await env.DB.prepare('SELECT reverse_quote_json FROM any_chain_held_returns WHERE held_id = 4')
      .first<{ reverse_quote_json: string }>();
    const quote = JSON.parse(row!.reverse_quote_json) as { quote: { deadline: string } };
    quote.quote.deadline = new Date(Date.now() - 1).toISOString();
    await env.DB.prepare('UPDATE any_chain_held_returns SET reverse_quote_json = ? WHERE held_id = 4')
      .bind(JSON.stringify(quote)).run();
    const key = KeyPairEd25519.fromRandom();
    h.net().contract.operatorKeys = [{ public_key: key.getPublicKey().toString(), access_key: { nonce: 1, permission: 'FullAccess' } }];
    const signed = await proof(key, { quoteReference: 'reverse-reference', releaseTxHash: 'K'.repeat(44) });
    expect((await api('/api/any-chain/held/4/release', { body: signed })).body.code).toBe('quote_expired');
    expect((await env.DB.prepare('SELECT release_tx_hash FROM any_chain_held_returns WHERE held_id = 4')
      .first<{ release_tx_hash: string | null }>())?.release_tx_hash).toBeNull();
  });

  // spec: add-any-chain-feed › Held delivery refund data › reverse quote ready × quote expiry before release
  it('rejects an inactive reverse quote and permits a fresh quote before release', async () => {
    await seed();
    await readyQuote();
    const row = await env.DB.prepare('SELECT reverse_quote_json FROM any_chain_held_returns WHERE held_id = 4')
      .first<{ reverse_quote_json: string }>();
    const old = JSON.parse(row!.reverse_quote_json) as { quote: { timeWhenInactive: string } };
    old.quote.timeWhenInactive = new Date(Date.now() - 1).toISOString();
    await env.DB.prepare('UPDATE any_chain_held_returns SET reverse_quote_json = ? WHERE held_id = 4')
      .bind(JSON.stringify(old)).run();
    const key = KeyPairEd25519.fromRandom();
    h.net().contract.operatorKeys = [{ public_key: key.getPublicKey().toString(), access_key: { nonce: 1, permission: 'FullAccess' } }];
    expect((await api('/api/any-chain/held/4/release', { body: await proof(key, {
      quoteReference: 'reverse-reference', releaseTxHash: 'K'.repeat(44),
    }) })).body.code).toBe('quote_expired');
    h.net().web.handlers.set(`${ONE_CLICK}/quote`, ({ body }) => {
      const request = JSON.parse(body) as Record<string, unknown>;
      return Response.json({ quoteRequest: request, correlationId: 'fresh-reference', signature: 'recorded',
        quote: { amountIn: amount, amountInUsd: '0.0376', amountOut: '27356', amountOutUsd: '0.0273',
          minAmountOut: '27082', refundFee: '0', withdrawFee: '10031', timeEstimate: 19,
          depositAddress: 'b'.repeat(64), deadline: request.deadline, timeWhenInactive: request.deadline } });
    });
    expect((await api('/api/any-chain/held/4/quote', { body: await proof(key) })).body.state).toBe('reverse_quote_ready');
    expect((await env.DB.prepare('SELECT state FROM any_chain_held_attempts WHERE held_id = 4')
      .first<{ state: string }>())?.state).toBe('expired');
  });

  // spec: add-any-chain-feed › Held delivery refund data › reverse quote ready × rejected payable quote
  it('clears a definitive provider 400 so the held amount can be quoted again', async () => {
    await seed();
    const key = KeyPairEd25519.fromRandom();
    h.net().contract.operatorKeys = [{ public_key: key.getPublicKey().toString(), access_key: { nonce: 1, permission: 'FullAccess' } }];
    expect((await api('/api/any-chain/held/4/attest', { body: await proof(key) })).status).toBe(200);
    h.net().web.handlers.set(`${ONE_CLICK}/quote`, () => Response.json({ message: 'not payable' }, { status: 400 }));
    expect((await api('/api/any-chain/held/4/quote', { body: await proof(key) })).body.code).toBe('quote_unavailable');
    expect((await env.DB.prepare('SELECT quote_state FROM any_chain_held_returns WHERE held_id = 4')
      .first<{ quote_state: string | null }>())?.quote_state).toBeNull();
  });

  // spec: add-any-chain-feed › Held delivery refund data › below return minimum
  it('leaves a provider-declared below-minimum amount in contract custody', async () => {
    await seed();
    const key = KeyPairEd25519.fromRandom();
    h.net().contract.operatorKeys = [{ public_key: key.getPublicKey().toString(), access_key: { nonce: 1, permission: 'FullAccess' } }];
    expect((await api('/api/any-chain/held/4/attest', { body: await proof(key) })).status).toBe(200);
    h.net().web.handlers.set(`${ONE_CLICK}/quote`, () => Response.json({ message: 'try at least 666806082210557728690' }, { status: 400 }));
    const below = await api('/api/any-chain/held/4/quote', { body: await proof(key) });
    expect(below.body).toMatchObject({ state: 'below_return_minimum', amount });
    const row = await env.DB.prepare('SELECT release_tx_hash, reverse_quote_json FROM any_chain_held_returns WHERE held_id = 4')
      .first<{ release_tx_hash: string | null; reverse_quote_json: string | null }>();
    expect(row).toMatchObject({ release_tx_hash: null, reverse_quote_json: null });
    h.net().web.handlers.set(`${ONE_CLICK}/quote`, ({ body }) => {
      const request = JSON.parse(body) as Record<string, unknown>;
      return Response.json({ quoteRequest: request, correlationId: 'later-reverse-reference', signature: 'recorded',
        quote: { amountIn: amount, amountInUsd: '0.0376', amountOut: '27356', amountOutUsd: '0.0273',
          minAmountOut: '27082', refundFee: '0', withdrawFee: '10031', timeEstimate: 19,
          depositAddress: 'b'.repeat(64), deadline: request.deadline, timeWhenInactive: request.deadline } });
    });
    expect((await api('/api/any-chain/held/4/quote', { body: await proof(key) })).body.state).toBe('reverse_quote_ready');
  });

  // spec: add-any-chain-feed › Held delivery refund data › reverse quote ready × unknown payable outcome
  it('keeps an unknown payable reverse quote from issuing a second deposit address', async () => {
    await seed();
    const key = KeyPairEd25519.fromRandom();
    h.net().contract.operatorKeys = [{ public_key: key.getPublicKey().toString(), access_key: { nonce: 1, permission: 'FullAccess' } }];
    expect((await api('/api/any-chain/held/4/attest', { body: await proof(key) })).status).toBe(200);
    h.net().web.handlers.set(`${ONE_CLICK}/quote`, () => Response.json({ message: 'unavailable' }, { status: 503 }));
    expect((await api('/api/any-chain/held/4/quote', { body: await proof(key) })).body.code).toBe('quote_unavailable');
    expect((await api('/api/any-chain/held/4/quote', { body: await proof(key) })).body.code).toBe('not_quotable');
    expect((await env.DB.prepare('SELECT quote_state, reverse_quote_json FROM any_chain_held_returns WHERE held_id = 4')
      .first<{ quote_state: string; reverse_quote_json: string | null }>()))
      .toMatchObject({ quote_state: 'quoting', reverse_quote_json: null });
  });

  // spec: add-any-chain-feed › Held delivery refund data › reverse quote ready × unknown payable outcome
  it('keeps an unknown claim until the exact provider deadline, even when its nonce is two hours old', async () => {
    await seed();
    const key = KeyPairEd25519.fromRandom();
    h.net().contract.operatorKeys = [{ public_key: key.getPublicKey().toString(), access_key: { nonce: 1, permission: 'FullAccess' } }];
    expect((await api('/api/any-chain/held/4/attest', { body: await proof(key) })).status).toBe(200);
    let sentDeadline = '';
    h.net().web.handlers.set(`${ONE_CLICK}/quote`, ({ body }) => {
      sentDeadline = (JSON.parse(body) as { deadline: string }).deadline;
      return Response.json({ message: 'unavailable' }, { status: 503 });
    });
    expect((await api('/api/any-chain/held/4/quote', { body: await proof(key) })).body.code).toBe('quote_unavailable');
    expect(Date.parse(sentDeadline)).toBeGreaterThan(Date.now());
    await env.DB.prepare("UPDATE any_chain_operator_nonces SET used_at = ? WHERE nonce = (SELECT attestation_nonce FROM any_chain_held_returns WHERE held_id = 4)")
      .bind(Date.now() - 2 * 60 * 60_000 - 1).run();
    expect((await api('/api/any-chain/held/4/quote', { body: await proof(key) })).body.code).toBe('not_quotable');
    const row = await env.DB.prepare('SELECT reverse_request_deadline FROM any_chain_held_returns WHERE held_id = 4')
      .first<{ reverse_request_deadline: string }>();
    expect(row?.reverse_request_deadline).toBe(sentDeadline);
  });

  // spec: add-any-chain-feed › Held delivery refund data › reverse quote ready × unknown payable outcome
  it('reconciles an unknown request after its deadline while custody was never released', async () => {
    await seed();
    const key = KeyPairEd25519.fromRandom();
    h.net().contract.operatorKeys = [{ public_key: key.getPublicKey().toString(), access_key: { nonce: 1, permission: 'FullAccess' } }];
    expect((await api('/api/any-chain/held/4/attest', { body: await proof(key) })).status).toBe(200);
    h.net().web.handlers.set(`${ONE_CLICK}/quote`, () => Response.json({ message: 'unavailable' }, { status: 503 }));
    expect((await api('/api/any-chain/held/4/quote', { body: await proof(key) })).body.code).toBe('quote_unavailable');
    await env.DB.prepare('UPDATE any_chain_held_returns SET reverse_request_deadline = ? WHERE held_id = 4')
      .bind(new Date(Date.now() - 1).toISOString()).run();
    h.net().web.handlers.set(`${ONE_CLICK}/quote`, ({ body }) => {
      const request = JSON.parse(body) as Record<string, unknown>;
      return Response.json({ quoteRequest: request, correlationId: 'after-timeout', signature: 'recorded',
        quote: { amountIn: amount, amountInUsd: '0.0376', amountOut: '27356', amountOutUsd: '0.0273',
          minAmountOut: '27082', refundFee: '0', withdrawFee: '10031', timeEstimate: 19,
          depositAddress: 'b'.repeat(64), deadline: request.deadline, timeWhenInactive: request.deadline } });
    });
    expect((await api('/api/any-chain/held/4/quote', { body: await proof(key) })).body.state).toBe('reverse_quote_ready');
  });

  // spec: add-any-chain-feed › Held delivery refund data › reverse exchange failed
  it('requires a proved project-account wNEAR recovery before another reverse quote', async () => {
    await seed();
    await readyQuote();
    await env.DB.prepare("UPDATE any_chain_held_returns SET release_state = 'released', release_tx_hash = ? WHERE held_id = 4")
      .bind('K'.repeat(44)).run();
    const key = KeyPairEd25519.fromRandom();
    h.net().contract.operatorKeys = [{ public_key: key.getPublicKey().toString(), access_key: { nonce: 1, permission: 'FullAccess' } }];
    const recoveryHash = 'M'.repeat(44);
    h.net().web.handlers.set(`${ONE_CLICK}/status?depositAddress=${'a'.repeat(64)}`, () => Response.json({
      status: 'FAILED', correlationId: 'reverse-reference',
      swapDetails: { nearTxHashes: [recoveryHash] },
    }));
    expect((await api('/api/any-chain/held/4/status', { headers: { 'x-payment-id': route } })).body.state)
      .toBe('reverse_exchange_failed');
    const signed = await proof(key, { quoteReference: 'reverse-reference', recoveryTxHash: recoveryHash });
    expect((await api('/api/any-chain/held/4/recovered', { body: signed })).body.code).toBe('recovery_unverified');
    const args = btoa(JSON.stringify({ receiver_id: env.TREASURY_ACCOUNT_ID, amount }));
    h.net().contract.outcomes.set(recoveryHash, { final_execution_status: 'FINAL',
      transaction: { hash: recoveryHash, signer_id: 'intents.near' },
      receipts: [{ receipt_id: 'N'.repeat(44), receiver_id: 'wrap.near', predecessor_id: 'intents.near',
        receipt: { Action: { actions: [{ FunctionCall: { method_name: 'ft_transfer', args } }] } } }],
      receipts_outcome: [{ id: 'N'.repeat(44), outcome: { executor_id: 'wrap.near', status: { SuccessValue: '' } } }] });
    expect((await api('/api/any-chain/held/4/recovered', { body: signed })).body.state).toBe('recovered');
    expect((await api('/api/any-chain/held/4/recovered', { body: signed })).status).toBe(409);
    const after = await api('/api/any-chain/held/4/status', { headers: { 'x-payment-id': route } });
    expect(after.body).toMatchObject({ state: 'recovered_for_retry', previousAttempts: [
      { state: 'recovered', provider_reference: 'reverse-reference', recovered_tx_hash: recoveryHash },
    ] });
    const attempts = await env.DB.prepare('SELECT state, recovered_tx_hash FROM any_chain_held_attempts WHERE held_id = 4')
      .all<{ state: string; recovered_tx_hash: string }>();
    expect(attempts.results).toMatchObject([{ state: 'recovered', recovered_tx_hash: recoveryHash }]);
  });

  // spec: add-any-chain-feed › Held delivery refund data › source verified × signed-out payer and gift
  it('rechecks nft_token ownership after a gift while the signed-out payer retains the bearer projection', async () => {
    await seed();
    await readyQuote();
    const firstOwner = NEAR_ACCOUNT(81);
    const nextOwner = NEAR_ACCOUNT(82);
    h.net().contract.addPet('1', firstOwner);
    const oldToken = await token('did:privy:held-old', firstOwner);
    const newToken = await token('did:privy:held-new', nextOwner);
    const old = await api('/api/any-chain/held/4/status', { token: oldToken });
    expect(old.body.sourceVerified).toBe(true);
    expect(old.body).not.toHaveProperty('recipient');
    h.net().contract.pets.get('1')!.owner_id = nextOwner;
    expect((await api('/api/any-chain/held/4/status', { token: oldToken })).status).toBe(404);
    const newOwner = await api('/api/any-chain/held/4/status', { token: newToken });
    expect(newOwner.status).toBe(200);
    expect(newOwner.body).not.toHaveProperty('recipient');
    const payer = await api('/api/any-chain/held/4/status', { headers: { 'x-payment-id': route } });
    expect(payer.body.recipient).toBe(recipient);
  });

  // spec: add-any-chain-feed › Held delivery refund data › refund confirmed
  it('rejects a provider SUCCESS for a different reverse quote', async () => {
    await seed();
    await readyQuote();
    await env.DB.prepare("UPDATE any_chain_held_returns SET release_state = 'released', release_tx_hash = ? WHERE held_id = 4")
      .bind('K'.repeat(44)).run();
    h.net().web.handlers.set(`${ONE_CLICK}/status?depositAddress=${'a'.repeat(64)}`, () => Response.json({
      status: 'SUCCESS', correlationId: 'different-reverse-reference',
      swapDetails: { destinationChainTxHashes: [{ hash: refundHash }], amountOut: '27215' },
    }));
    const status = await api('/api/any-chain/held/4/status', { headers: { 'x-payment-id': route } });
    expect(status.body).toMatchObject({ state: 'return_in_progress', refundTxHash: null, refundAmountUsdc: null });
    expect((await env.DB.prepare('SELECT refund_tx_hash FROM any_chain_held_returns WHERE held_id = 4')
      .first<{ refund_tx_hash: string | null }>())?.refund_tx_hash).toBeNull();
  });
});
