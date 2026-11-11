import { Hono } from 'hono';
import { ed25519 } from '@noble/curves/ed25519.js';
import { ChainUnreachable, currentGasPrice, rpcProvider, txStatus } from '../chain';
import { currentOwner, petAddresses } from '../any-chain/addresses';
import { gasWallet } from '../any-chain/gasWallet';
import { liveQuote, nativePrice, ORIGINS, preflight, quoteRequest, QuoteUnavailable, type Origin } from '../any-chain/quote';
import { baseSource, solanaSource, sourceBalance, type SweepSource } from '../any-chain/sweepRpc';
import { advanceSweep, reconcileSweepProvider } from '../any-chain/sweepBroadcast';
import { BASE_USDC, bytesHex, SOLANA_USDC } from '../any-chain/sweepPayload';
import { requireSession, type AppEnv } from '../http';
import { nearUsdRate, yoctoToUsdMicros } from '../pricing';
import { PROJECT_CAP_MICROS, recordFinalNearExpense } from '../any-chain/cost';
import { contractReason } from '../any-chain/reasons';

export const anyChainSweepRoutes = new Hono<AppEnv>();
const ID = /^[0-9a-f]{32}$/;
const SWEEP_WINDOW_MS = 3_600_000;

interface Deposit {
  id: string; token_id: string; chain: Origin; asset: string; amount_units: string; state: string;
}
interface Sweep {
  route_id: string; deposit_id: string; token_id: string; chain: Origin; amount_units: string;
  provider_wallet: string; destination: string; refund_recipient: string; quote_json: string;
  payload_hex: string; approval_hash: string; sequence: number; expiry_ms: number;
  sponsor_cap_micros: number; estimated_gas_micros: number; estimated_rent_micros: number;
  native_funding_units: string; native_gas_units: string; native_rent_units: string;
  gas_wallet_address: string; source_meta_json: string;
  creation_message: string | null; state: string; owner_signature: string | null;
  near_tx_hash: string | null; source_tx_hash: string | null; created_at: number; updated_at: number;
  signed_at_ms: number | null;
}

function unhex(value: string): Uint8Array {
  return Uint8Array.from(value.match(/../g)!, (part) => parseInt(part, 16));
}

function mpcResponse(value: string | null, chain: Origin): Record<string, unknown> | null {
  if (!value || value === 'null') return null;
  try {
    const decoded: unknown = JSON.parse(value);
    const inner: unknown = typeof decoded === 'string' ? JSON.parse(decoded) : decoded;
    if (inner && typeof inner === 'object' && (inner as { scheme?: unknown }).scheme ===
      (chain === 'base' ? 'Secp256k1' : 'Ed25519')) return inner as Record<string, unknown>;
  } catch { /* The original transaction remains the recovery reference. */ }
  return null;
}

function usdMicros(value: string): number {
  if (!/^\d+(?:\.\d{1,12})?$/.test(value)) throw new QuoteUnavailable('provider_unavailable');
  const [whole, fraction = ''] = value.split('.');
  const result = BigInt(whole!) * 1_000_000n + BigInt(fraction.padEnd(6, '0').slice(0, 6));
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new QuoteUnavailable('provider_unavailable');
  return Number(result);
}

function nativeMicros(chain: Origin, units: bigint, price: number): number {
  const divisor = chain === 'base' ? 1e18 : 1e9;
  const result = Math.ceil(Number(units) / divisor * price * 1e6);
  if (!Number.isSafeInteger(result) || result < 0) throw new QuoteUnavailable('source_unavailable');
  return result;
}

function fault(c: { json: (body: { code: string }, status: 403 | 404 | 409 | 503) => Response }, error: unknown): Response {
  if (error instanceof ChainUnreachable) return c.json({ code: 'chain_unreachable' }, 503);
  if (error instanceof QuoteUnavailable) return c.json({ code: error.code },
    error.code === 'no_pet' || error.code === 'deposit_missing' ? 404 :
      error.code === 'not_owner' ? 403 : error.code.endsWith('_unavailable') ? 503 : 409);
  throw error;
}

async function ownedDeposit(env: Env, id: string, account: string): Promise<Deposit> {
  const row = await env.DB.prepare('SELECT id, token_id, chain, asset, amount_units, state FROM any_chain_deposits WHERE id = ?')
    .bind(id).first<Deposit>();
  if (!row) throw new QuoteUnavailable('deposit_missing');
  const owner = await currentOwner(env, row.token_id);
  if (!owner) throw new QuoteUnavailable('no_pet');
  if (owner !== account) throw new QuoteUnavailable('not_owner');
  return row;
}

async function signerId(env: Env): Promise<string> {
  try {
    const view = await rpcProvider(env).callFunction({ contractId: env.CONTRACT_ID, method: 'sweep_signer_view', args: {} }) as { signer_id?: unknown };
    if (typeof view.signer_id === 'string') return view.signer_id;
  } catch { throw new ChainUnreachable(); }
  throw new QuoteUnavailable('signer_unavailable');
}

/** An owner sees the payable amount, exact transfer account, refund address and the hash to sign. */
// spec: add-any-chain-feed › Pet address deposit flow › owner authorization pending
// spec: add-any-chain-feed › Pet address deposit flow › deposit exceeds one sweep
// spec: add-any-chain-feed › Pet address data › pet-address refund routing
// spec: add-any-chain-feed › Pet sweep authorization contract › wrong refund recipient
anyChainSweepRoutes.post('/api/any-chain/deposits/:id/sweep/quote', async (c) => {
  const session = requireSession(c);
  if (session instanceof Response) return session;
  const id = c.req.param('id');
  if (!ID.test(id)) return c.json({ code: 'bad_request' }, 400);
  try {
    const deposit = await ownedDeposit(c.env, id, session.accountId);
    if (deposit.asset !== 'usdc' || deposit.state === 'unsupported') throw new QuoteUnavailable('unsupported_origin');
    await preflight(c.env, deposit.token_id, deposit.chain);
    const addresses = await petAddresses(c.env, deposit.token_id);
    const address = addresses?.find((item) => item.chain === deposit.chain);
    if (!address) throw new QuoteUnavailable('signer_unavailable');
    const existing = await c.env.DB.prepare(`SELECT route_id, state, sequence, expiry_ms, signed_at_ms, updated_at, amount_units FROM any_chain_sweeps
      WHERE token_id = ? AND chain = ? ORDER BY created_at DESC LIMIT 1`)
      .bind(deposit.token_id, deposit.chain).first<Pick<Sweep, 'route_id' | 'state' | 'sequence' | 'expiry_ms' | 'signed_at_ms' | 'updated_at' | 'amount_units'>>();
    if (existing && !['quoted', 'sign_failed', 'approval_rejected'].includes(existing.state) &&
      (existing.signed_at_ms ?? existing.updated_at) + SWEEP_WINDOW_MS > Date.now())
      throw new QuoteUnavailable('sweep_already_active');
    if (existing?.state === 'quoted' && existing.expiry_ms > Date.now())
      throw new QuoteUnavailable('quote_pending');
    const balance = await sourceBalance(deposit.chain, address.address);
    const prior = await c.env.DB.prepare(`SELECT COALESCE(SUM(CAST(amount_units AS INTEGER)), 0) AS used
      FROM any_chain_sweeps WHERE deposit_id = ? AND state IN ('broadcasting', 'sent', 'food')`)
      .bind(id).first<{ used: number }>();
    const available = [BigInt(deposit.amount_units) - BigInt(prior?.used ?? 0), balance]
      .reduce((min, value) => value < min ? value : min);
    if (available < 10_000n) throw new QuoteUnavailable('below_minimum');
    let portion = available > 1_000_000n ? 1_000_000n : available;
    const routeId = crypto.randomUUID().replaceAll('-', '');
    const deadline = new Date(Date.now() + 2 * 60 * 60_000).toISOString();
    // The contract's 1 USDC limit and the game's 0.2 NEAR quote ceiling can differ.
    // Halve only when the live expected food exceeds that ceiling; every portion still needs approval.
    for (;;) {
      const trial = quoteRequest(c.env, routeId, deposit.token_id, ORIGINS[deposit.chain],
        portion.toString(), address.address, true, deadline, 'pet_address');
      try { await liveQuote(trial, false); break; }
      catch (error) {
        if (!(error instanceof QuoteUnavailable) || error.code !== 'above_ceiling' || portion <= 10_000n) throw error;
        portion /= 2n;
      }
    }
    const request = quoteRequest(c.env, routeId, deposit.token_id, ORIGINS[deposit.chain],
      portion.toString(), address.address, false, deadline, 'pet_address');
    const answer = await liveQuote(request, true);
    if (!answer.quote.depositAddress || Date.parse(answer.quote.deadline!) <= Date.now() ||
      Date.parse(answer.quote.timeWhenInactive!) <= Date.now()) throw new QuoteUnavailable('quote_expired');
    const gasKey = gasWallet(c.env, deposit.chain);
    const price = await nativePrice(deposit.chain);
    const source: SweepSource = deposit.chain === 'base'
      ? await baseSource(address.address, answer.quote.depositAddress, portion, price)
      : await solanaSource(address.address, answer.quote.depositAddress, portion, price, gasKey.address);
    const gasMicros = nativeMicros(deposit.chain, source.nativeGas, price);
    const rentMicros = nativeMicros(deposit.chain, source.nativeRent, price);
    const capMicros = Math.min(Math.floor(usdMicros(answer.quote.amountOutUsd) / 10), 50_000);
    if (gasMicros > capMicros) throw new QuoteUnavailable('sweep_gas_cap');
    const expiry = Date.now() + (deposit.chain === 'solana' ? 45_000 : 5 * 60_000);
    const payloadBytes = Uint8Array.from(source.payloadHex.match(/../g)!, (part) => parseInt(part, 16));
    const envelope = {
      contract_id: c.env.CONTRACT_ID, signer_id: await signerId(c.env), token_id: deposit.token_id,
      chain: deposit.chain, path: address.path,
      usdc_contract: deposit.chain === 'base' ? BASE_USDC : SOLANA_USDC,
      amount_base_units: Number(portion), destination: source.destination, refund_recipient: address.address,
      route_id: routeId, sequence: existing ? existing.sequence +
        (existing.state === 'quoted' || existing.state === 'approval_rejected' ? 0 : 1) : 0,
      expiry_ms: expiry,
      signing_payload_sha256: Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', payloadBytes))),
    };
    let approvalHash: unknown;
    try { approvalHash = await rpcProvider(c.env).callFunction({ contractId: c.env.CONTRACT_ID,
      method: 'sweep_approval_hash_view', args: { envelope } }); }
    catch { throw new ChainUnreachable(); }
    if (typeof approvalHash !== 'string' || !/^[0-9a-f]{64}$/.test(approvalHash)) throw new ChainUnreachable();
    const added = await c.env.DB.prepare(`INSERT INTO any_chain_sweeps
      (route_id, deposit_id, token_id, chain, amount_units, provider_wallet, destination, refund_recipient,
       quote_json, payload_hex, approval_hash, sequence, expiry_ms, sponsor_cap_micros,
       estimated_gas_micros, estimated_rent_micros, native_funding_units, native_gas_units,
       native_rent_units, gas_wallet_address, source_meta_json, creation_message, state, created_at, updated_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'quoted', ?, ?
      WHERE (SELECT COALESCE(SUM(usd_micros), 0) FROM project_spend) +
        (SELECT COALESCE(SUM(estimated_gas_micros + estimated_rent_micros), 0) FROM any_chain_sweeps
         WHERE expiry_ms > ? AND state IN ('quoted', 'signing', 'sign_unknown', 'signed', 'awaiting_gas', 'broadcasting'))
        + ? + ? <= ? AND NOT EXISTS (SELECT 1 FROM any_chain_sweeps
          WHERE token_id = ? AND chain = ? AND
            ((state = 'quoted' AND expiry_ms > ?) OR
             (state NOT IN ('quoted', 'sign_failed', 'approval_rejected') AND
              COALESCE(signed_at_ms, updated_at) + ? > ?)))`)
      .bind(routeId, id, deposit.token_id, deposit.chain, portion.toString(), answer.quote.depositAddress,
        source.destination, address.address, JSON.stringify(answer), source.payloadHex, approvalHash,
        envelope.sequence, expiry, capMicros, gasMicros, rentMicros,
        source.nativeFunding.toString(), source.nativeGas.toString(), source.nativeRent.toString(),
        gasKey.address, JSON.stringify(source.sourceMeta), source.accountCreationMessage ?? null,
        Date.now(), Date.now(), Date.now(), gasMicros, rentMicros, PROJECT_CAP_MICROS,
        deposit.token_id, deposit.chain, Date.now(), SWEEP_WINDOW_MS, Date.now()).run();
    if (added.meta.changes !== 1) throw new QuoteUnavailable('project_budget');
    return c.json({ routeId, amountUnits: portion.toString(), remainderUnits: (available - portion).toString(),
      chain: deposit.chain, destination: source.destination, providerWallet: answer.quote.depositAddress,
      refundTo: address.address, quote: answer.quote, sponsorCapMicros: capMicros,
      sourceGasMicros: gasMicros, tokenAccountCreationMicros: rentMicros, approvalHash, expiryMs: expiry });
  } catch (error) { return fault(c, error); }
});

/** A transaction hash is recorded by ServerKey before broadcast, so a timeout cannot sign again. */
// spec: add-any-chain-feed › Pet address deposit flow › owner rejects conversion
// spec: add-any-chain-feed › Pet address deposit flow › approval submitted
// spec: add-any-chain-feed › Pet address deposit flow › NEAR signing failed
// spec: add-any-chain-feed › Pet address deposit flow › NEAR signing outcome unknown
// spec: add-any-chain-feed › Pet address data › owner approval leaves browser
anyChainSweepRoutes.post('/api/any-chain/sweeps/:id/approve', async (c) => {
  const session = requireSession(c);
  if (session instanceof Response) return session;
  const id = c.req.param('id');
  const body = await c.req.json<{ signature?: unknown }>().catch(() => null);
  if (!ID.test(id) || typeof body?.signature !== 'string' || !/^[0-9a-fA-F]{128}$/.test(body.signature))
    return c.json({ code: 'bad_request' }, 400);
  const sweep = await c.env.DB.prepare('SELECT * FROM any_chain_sweeps WHERE route_id = ?').bind(id).first<Sweep>();
  if (!sweep) return c.json({ code: 'quote_missing' }, 404);
  try {
    await ownedDeposit(c.env, sweep.deposit_id, session.accountId);
    if (sweep.state !== 'quoted' || sweep.expiry_ms <= Date.now()) throw new QuoteUnavailable('quote_expired');
    const addresses = await petAddresses(c.env, sweep.token_id);
    const address = addresses?.find((item) => item.chain === sweep.chain);
    if (!address) throw new QuoteUnavailable('signer_unavailable');
    if (address.address !== sweep.refund_recipient) throw new QuoteUnavailable('wrong_refund_recipient');
    let valid = false;
    try { valid = /^[0-9a-f]{64}$/.test(session.accountId) &&
      ed25519.verify(unhex(body.signature), unhex(sweep.approval_hash), unhex(session.accountId)); }
    catch { valid = false; }
    if (!valid)
      throw new QuoteUnavailable('wrong_owner_approval');
    // Another tab may have consumed the quote between the read and this claim.
    const claim = await c.env.DB.prepare(`UPDATE any_chain_sweeps SET state = 'signing', owner_signature = ?, updated_at = ?
      WHERE route_id = ? AND state = 'quoted' AND expiry_ms > ?`)
      .bind(body.signature.toLowerCase(), Date.now(), id, Date.now()).run();
    if (claim.meta.changes !== 1) throw new QuoteUnavailable('quote_expired');
    // Gift safety immediately before the server key sends. A changed owner revokes this claim.
    if (await currentOwner(c.env, sweep.token_id) !== session.accountId) {
      await c.env.DB.prepare("UPDATE any_chain_sweeps SET state = 'approval_rejected' WHERE route_id = ? AND state = 'signing' AND near_tx_hash IS NULL")
        .bind(id).run();
      throw new QuoteUnavailable('not_owner');
    }
    const rate = nearUsdRate(c.env.NEAR_USD_RATE);
    if (rate === null) throw new QuoteUnavailable('source_unavailable');
    const reserve = yoctoToUsdMicros(await currentGasPrice(c.env) * 150_000_000_000_000n, rate);
    const budgeted = await c.env.DB.prepare(`UPDATE any_chain_sweeps SET near_signer_reserve_micros = ?
      WHERE route_id = ? AND state = 'signing' AND
      (SELECT COALESCE(SUM(usd_micros), 0) FROM project_spend) +
      (SELECT COALESCE(SUM(estimated_gas_micros + estimated_rent_micros + near_signer_reserve_micros), 0)
       FROM any_chain_sweeps WHERE expiry_ms > ? AND state IN
       ('quoted', 'signing', 'sign_unknown', 'signed', 'awaiting_gas', 'broadcasting')) + ? <= ?`)
      .bind(reserve, id, Date.now(), reserve, PROJECT_CAP_MICROS).run();
    if (budgeted.meta.changes !== 1) {
      await c.env.DB.prepare("UPDATE any_chain_sweeps SET state = 'approval_rejected' WHERE route_id = ? AND state = 'signing' AND near_tx_hash IS NULL")
        .bind(id).run();
      throw new QuoteUnavailable('project_budget');
    }
    const result = await c.env.SERVER_KEY.get(c.env.SERVER_KEY.idFromName('server')).send({
      methodName: 'sweep_sign', gas: '150000000000000', writes: { kind: 'sweep_sign', routeId: id },
      args: { token_id: sweep.token_id, chain: sweep.chain, path: `${sweep.chain}:${sweep.token_id}`,
        usdc_contract: sweep.chain === 'base' ? BASE_USDC : SOLANA_USDC,
        amount_base_units: Number(sweep.amount_units), destination: sweep.destination,
        refund_recipient: sweep.refund_recipient, route_id: id, sequence: sweep.sequence,
        expiry_ms: sweep.expiry_ms, signing_payload_hex: sweep.payload_hex,
        owner_approval: { public_key: session.accountId, signature: body.signature.toLowerCase() } },
    });
    if (result.status === 'unreachable') {
      const signed = await c.env.DB.prepare('SELECT near_tx_hash FROM any_chain_sweeps WHERE route_id = ?')
        .bind(id).first<{ near_tx_hash: string | null }>();
      if (!signed?.near_tx_hash) {
        await c.env.DB.prepare("UPDATE any_chain_sweeps SET state = 'approval_rejected' WHERE route_id = ? AND state = 'signing'")
          .bind(id).run();
        throw new ChainUnreachable();
      }
      await c.env.DB.prepare("UPDATE any_chain_sweeps SET state = 'sign_unknown' WHERE route_id = ? AND state = 'signing'")
        .bind(id).run();
      return c.json({ state: 'sign_unknown', nearTxHash: signed.near_tx_hash });
    }
    if (await recordFinalNearExpense(c.env, { id: `near:signer:${result.txHash}`, routeId: id,
      kind: 'near_signer_gas', txHash: result.txHash, signer: c.env.SERVER_ACCOUNT_ID }))
      await c.env.DB.prepare('UPDATE any_chain_sweeps SET near_signer_reserve_micros = 0 WHERE route_id = ?').bind(id).run();
    if (result.status === 'failed') {
      const reason = contractReason(result.code);
      await c.env.DB.prepare("UPDATE any_chain_sweeps SET state = 'approval_rejected', rejection_reason = ?, updated_at = ? WHERE route_id = ?")
        .bind(reason, Date.now(), id).run();
      return c.json({ state: 'sign_failed', reason, nearTxHash: result.txHash });
    }
    if (result.status === 'unknown') {
      await c.env.DB.prepare("UPDATE any_chain_sweeps SET state = 'sign_unknown', updated_at = ? WHERE route_id = ?")
        .bind(Date.now(), id).run();
      return c.json({ state: 'sign_unknown', nearTxHash: result.txHash });
    }
    const mpc = mpcResponse(result.value, sweep.chain);
    if (!mpc) {
      await c.env.DB.prepare("UPDATE any_chain_sweeps SET state = 'sign_failed', updated_at = ? WHERE route_id = ?")
        .bind(Date.now(), id).run();
      return c.json({ state: 'sign_failed', nearTxHash: result.txHash });
    }
    await c.env.DB.prepare("UPDATE any_chain_sweeps SET state = 'signed', mpc_response = ?, signed_at_ms = ?, updated_at = ? WHERE route_id = ?")
      .bind(JSON.stringify(mpc), Date.now(), Date.now(), id).run();
    let sourceState: string = 'signed';
    try { sourceState = await advanceSweep(c.env, id); } catch { /* The cron retries the same signed payload. */ }
    return c.json({ state: sourceState, nearTxHash: result.txHash, routeId: id });
  } catch (error) { return fault(c, error); }
});

export async function reconcileUnknownSweep(env: Env, id: string): Promise<'sign_unknown' | 'sign_failed' | 'signed'> {
  const sweep = await env.DB.prepare('SELECT * FROM any_chain_sweeps WHERE route_id = ?').bind(id).first<Sweep>();
  if (!sweep || sweep.state !== 'sign_unknown' || !sweep.near_tx_hash) return 'sign_unknown';
  const outcome = await txStatus(env, sweep.near_tx_hash, env.SERVER_ACCOUNT_ID);
  if (outcome?.status === 'ok' || outcome?.status === 'failed')
    if (await recordFinalNearExpense(env, { id: `near:signer:${sweep.near_tx_hash}`, routeId: id,
      kind: 'near_signer_gas', txHash: sweep.near_tx_hash, signer: env.SERVER_ACCOUNT_ID }))
      await env.DB.prepare('UPDATE any_chain_sweeps SET near_signer_reserve_micros = 0 WHERE route_id = ?').bind(id).run();
  if (outcome?.status === 'failed') {
    await env.DB.prepare("UPDATE any_chain_sweeps SET state = 'approval_rejected', rejection_reason = ?, updated_at = ? WHERE route_id = ? AND state = 'sign_unknown'")
      .bind(contractReason(outcome.code), Date.now(), id).run();
    return 'sign_failed';
  }
  if (outcome?.status === 'ok') {
    const mpc = mpcResponse(outcome.value, sweep.chain);
    if (mpc) {
      await env.DB.prepare("UPDATE any_chain_sweeps SET state = 'signed', mpc_response = ?, signed_at_ms = ?, updated_at = ? WHERE route_id = ? AND state = 'sign_unknown'")
        .bind(JSON.stringify(mpc), Date.now(), Date.now(), id).run();
      return 'signed';
    }
  }
  return 'sign_unknown';
}

// spec: add-any-chain-feed › Pet address deposit flow › NEAR signing outcome unknown
anyChainSweepRoutes.get('/api/any-chain/sweeps/:id', async (c) => {
  const session = requireSession(c);
  if (session instanceof Response) return session;
  const id = c.req.param('id');
  if (!ID.test(id)) return c.json({ code: 'bad_request' }, 400);
  const sweep = await c.env.DB.prepare('SELECT * FROM any_chain_sweeps WHERE route_id = ?').bind(id).first<Sweep>();
  if (!sweep) return c.json({ code: 'quote_missing' }, 404);
  try {
    await ownedDeposit(c.env, sweep.deposit_id, session.accountId);
    if (sweep.state === 'sign_unknown' && sweep.near_tx_hash) {
      const state = await reconcileUnknownSweep(c.env, id);
      if (state === 'signed') {
        let sourceState: string = 'signed';
        try { sourceState = await advanceSweep(c.env, id); } catch { /* The cron retries. */ }
        return c.json({ state: sourceState, nearTxHash: sweep.near_tx_hash });
      }
      return c.json({ state, nearTxHash: sweep.near_tx_hash });
    }
    if (['signed', 'awaiting_gas', 'broadcasting'].includes(sweep.state)) {
      let state = sweep.state;
      try { state = await advanceSweep(c.env, id); } catch { /* Keep the original transaction references. */ }
      const current = await c.env.DB.prepare('SELECT source_tx_hash FROM any_chain_sweeps WHERE route_id = ?')
        .bind(id).first<{ source_tx_hash: string | null }>();
      return c.json({ state, nearTxHash: sweep.near_tx_hash,
        sourceTxHash: current?.source_tx_hash ?? sweep.source_tx_hash, routeId: id });
    }
    if (sweep.state === 'sent') {
      let state: string = 'sent';
      try { state = await reconcileSweepProvider(c.env, id); } catch { /* Public proofs stay available on retry. */ }
      return c.json({ state, nearTxHash: sweep.near_tx_hash,
        sourceTxHash: sweep.source_tx_hash, routeId: id });
    }
    return c.json({ state: sweep.state, nearTxHash: sweep.near_tx_hash,
      sourceTxHash: sweep.source_tx_hash, routeId: sweep.route_id });
  } catch (error) { return fault(c, error); }
});
