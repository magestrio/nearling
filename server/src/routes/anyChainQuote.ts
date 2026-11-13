import { Hono } from 'hono';
import { ChainUnreachable } from '../chain';
import { TOKEN_ID, type AppEnv } from '../http';
import { amountUnits, liveQuote, liveTokens, originOf, preflight, quoteRequest, QuoteUnavailable, refundAddressValid } from '../any-chain/quote';
import { currentOwner } from '../any-chain/addresses';
import { nearAmount, recordAnyChainEvent } from '../any-chain/events';

function addressPresent(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 2 && value.length <= 128 && !/\s/.test(value);
}
function addressValid(asset: string, value: unknown): value is string {
  const chain = originOf(asset);
  return chain ? refundAddressValid(chain, value) : addressPresent(value);
}

function quotedFee(input: string, output: string): number {
  const fee = Number(input) - Number(output);
  if (!Number.isFinite(fee) || fee < 0) throw new QuoteUnavailable('provider_unavailable');
  return fee;
}

export const anyChainQuoteRoutes = new Hono<AppEnv>();

function errorCode(error: unknown): { code: string; status: 400 | 404 | 409 | 503 } {
  if (error instanceof ChainUnreachable) return { code: 'chain_unreachable', status: 503 };
  if (!(error instanceof QuoteUnavailable)) throw error;
  if (error.code === 'no_pet') return { code: error.code, status: 404 };
  if (error.code === 'provider_unavailable' || error.code === 'signer_unavailable') return { code: error.code, status: 503 };
  if (error.code === 'no_payable_quote') return { code: error.code, status: 400 };
  return { code: error.code, status: 409 };
}

// spec: add-any-chain-feed › Cross-chain quote flow › unsupported origin
anyChainQuoteRoutes.get('/api/any-chain/tokens', async (c) => {
  try { return c.json({ tokens: await liveTokens() }); }
  catch (error) { const result = errorCode(error); return c.json({ code: result.code }, result.status); }
});

// spec: add-any-chain-feed › Cross-chain quote flow › guest quote
// spec: add-any-chain-feed › Cross-chain quote flow › quote below minimum
// spec: add-any-chain-feed › Cross-chain quote flow › quote above portion ceiling
// spec: add-any-chain-feed › Cross-chain availability rule › services paused
// spec: add-any-chain-feed › Cross-chain availability rule › receiver not registered
// spec: add-any-chain-feed › Cross-chain availability rule › pending stake unavailable
// spec: add-any-chain-feed › Cross-chain availability rule › pending capacity full
anyChainQuoteRoutes.post('/api/any-chain/quote', async (c) => {
  const body = await c.req.json<{ tokenId?: unknown; originAsset?: unknown; amount?: unknown; refundTo?: unknown }>().catch(() => null);
  const tokenId = body?.tokenId;
  if (typeof tokenId !== 'string' || !TOKEN_ID.test(tokenId) || typeof body?.originAsset !== 'string' ||
    typeof body?.amount !== 'string' || !addressPresent(body?.refundTo))
    return c.json({ code: 'bad_request' }, 400);
  try {
    const tokens = await liveTokens();
    const token = tokens.find((item) => item.assetId === body.originAsset);
    if (!token || originOf(token.assetId, tokens) === null) throw new QuoteUnavailable('unsupported_origin');
    if (!addressValid(token.assetId, body.refundTo)) return c.json({ code: 'bad_request' }, 400);
    const amount = amountUnits(body.amount, token.decimals);
    if (amount === null) return c.json({ code: 'bad_request' }, 400);
    await preflight(c.env, tokenId, originOf(token.assetId) ?? undefined);
    const id = crypto.randomUUID().replaceAll('-', '');
    const deadline = new Date(Date.now() + 2 * 60 * 60_000).toISOString();
    const request = quoteRequest(c.env, id, tokenId, body.originAsset as string, amount, body.refundTo, true, deadline);
    const answer = await liveQuote(request, false);
    const via = c.get('session')?.accountId === await currentOwner(c.env, tokenId) ? 'owner' : 'link';
    await c.env.DB.prepare(`INSERT INTO any_chain_routes
      (id, token_id, origin_asset, origin_chain, origin_symbol, origin_decimals, amount_in, refund_to,
       expected_out, min_out, quote_json, state, created_at, request_deadline, via)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)`)
      .bind(id, tokenId, body.originAsset, token.blockchain, token.symbol, token.decimals, amount, body.refundTo, answer.quote.amountOut,
        answer.quote.minAmountOut, JSON.stringify(answer), Date.now(), deadline, via).run();
    c.header('Date', new Date().toUTCString());
    return c.json({ id, quote: answer.quote, signature: answer.signature, providerReference: answer.correlationId });
  } catch (error) { const result = errorCode(error); return c.json({ code: result.code }, result.status); }
});

interface DraftRow {
  id: string; token_id: string; origin_asset: string; origin_chain: string | null;
  origin_symbol: string | null; origin_decimals: number | null; amount_in: string; refund_to: string;
  min_out: string; state: string; request_deadline: string; via: 'link' | 'owner';
}

// spec: add-any-chain-feed › Cross-chain quote flow › quote created
// spec: add-any-chain-feed › Cross-chain availability rule › changed quote
anyChainQuoteRoutes.post('/api/any-chain/quotes/:id/accept', async (c) => {
  const id = c.req.param('id');
  if (!/^[0-9a-f]{32}$/.test(id)) return c.json({ code: 'bad_request' }, 400);
  const row = await c.env.DB.prepare('SELECT id, token_id, origin_asset, origin_chain, origin_symbol, origin_decimals, amount_in, refund_to, min_out, state, request_deadline, via FROM any_chain_routes WHERE id = ?')
    .bind(id).first<DraftRow>();
  if (row === null) return c.json({ code: 'quote_missing' }, 404);
  if (row.state !== 'draft' || Date.parse(row.request_deadline) <= Date.now()) return c.json({ code: 'quote_expired' }, 409);
  try {
    const tokens = await liveTokens();
    const token = tokens.find((item) => item.assetId === row.origin_asset);
    if (!token || originOf(row.origin_asset, tokens) !== row.origin_chain || token.decimals !== row.origin_decimals)
      throw new QuoteUnavailable('unsupported_origin');
    await preflight(c.env, row.token_id, originOf(token.assetId) ?? undefined);
    // Claim before asking 1-Click for a one-time address. An unknown network outcome
    // remains `accepting`: a retry cannot silently create a second address.
    const claim = await c.env.DB.prepare("UPDATE any_chain_routes SET state = 'accepting' WHERE id = ? AND state = 'draft'")
      .bind(id).run();
    if (claim.meta.changes !== 1) throw new QuoteUnavailable('quote_expired');
    const request = quoteRequest(c.env, id, row.token_id, row.origin_asset, row.amount_in, row.refund_to, false, row.request_deadline);
    const answer = await liveQuote(request, true);
    // The payable quote is priced seconds after the dry one the player saw; on a moving rate its
    // minimum lands slightly lower. Within the quote's own 1% slippage the payment-address screen
    // shows the new minimum (liveQuote still holds it at or above the minimum portion); a larger
    // drop is a changed quote.
    if (BigInt(answer.quote.minAmountOut) * 100n < BigInt(row.min_out) * 99n || Date.parse(answer.quote.deadline!) <= Date.now() ||
      Date.parse(answer.quote.timeWhenInactive!) <= Date.now() || !addressValid(row.origin_asset, answer.quote.depositAddress))
      throw new QuoteUnavailable('quote_expired');
    const changed = await c.env.DB.prepare(`UPDATE any_chain_routes SET state = 'accepted', quote_json = ?, min_out = ?,
      deposit_address = ?, deposit_memo = ?, provider_deadline = ?, inactive_at = ? WHERE id = ? AND state = 'accepting'`)
      .bind(JSON.stringify(answer), answer.quote.minAmountOut, answer.quote.depositAddress, answer.quote.depositMemo ?? null,
        answer.quote.deadline, answer.quote.timeWhenInactive, id).run();
    if (changed.meta.changes !== 1) throw new QuoteUnavailable('quote_expired');
    await recordAnyChainEvent(c.env, { name: 'cross_chain_quote_created', key: id, routeId: id,
      tokenId: row.token_id, fields: { route: 'quote',
        chain: row.origin_chain === 'sol' ? 'solana' : row.origin_chain ?? undefined,
        asset: row.origin_symbol === 'USDC' ? 'usdc' : 'other',
        minOutNear: nearAmount(answer.quote.minAmountOut),
        feeUsd: quotedFee(answer.quote.amountInUsd, answer.quote.amountOutUsd) } });
    c.header('Date', new Date().toUTCString());
    return c.json({ id, quote: answer.quote, refundTo: row.refund_to, signature: answer.signature,
      providerReference: answer.correlationId });
  } catch (error) { const result = errorCode(error); return c.json({ code: result.code }, result.status); }
});
