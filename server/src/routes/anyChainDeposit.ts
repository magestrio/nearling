import { Hono } from 'hono';
import { ChainUnreachable } from '../chain';
import { petAddresses, currentOwner } from '../any-chain/addresses';
import { addressMinimum, liveQuote, liveTokens, ORIGINS, preflight, quoteRequest, QuoteUnavailable, type Origin } from '../any-chain/quote';
import { observedSource } from '../any-chain/source';
import { recordAnyChainEvent } from '../any-chain/events';
import { ownerCredits } from '../any-chain/ownerCredits';
import { BASE_USDC, SOLANA_USDC } from '../any-chain/sweepPayload';
import { requireSession, TOKEN_ID, type AppEnv } from '../http';

export const anyChainDepositRoutes = new Hono<AppEnv>();
const ID = /^[0-9a-f]{32}$/;
const BASE_HASH = /^0x[0-9a-fA-F]{64}$/;
const SOL_HASH = /^[1-9A-HJ-NP-Za-km-z]{70,100}$/;

interface DepositRow {
  id: string; token_id: string; chain: Origin; source_tx_hash: string; transfer_index: number;
  sender: string; address: string; asset: 'usdc' | 'other'; amount_units: string;
  state: 'waiting' | 'below_minimum' | 'unsupported' | 'converting' | 'food' | 'refunded';
  source_explorer: string; near_credit_tx: string | null; source_refund_tx: string | null;
}
interface OwnerSweepRow {
  route_id: string; amount_units: string; destination: string; refund_recipient: string;
  quote_json: string; approval_hash: string; expiry_ms: number; state: string; rejection_reason: string | null;
  near_tx_hash: string | null; source_tx_hash: string | null; signed_at_ms: number | null;
  updated_at: number;
}

function fault(c: { json: (body: { code: string }, status: 404 | 409 | 503) => Response }, error: unknown): Response {
  if (error instanceof ChainUnreachable) return c.json({ code: 'chain_unreachable' }, 503);
  if (error instanceof QuoteUnavailable) return c.json({ code: error.code }, error.code === 'no_pet' ? 404 :
    error.code === 'provider_unavailable' || error.code === 'signer_unavailable' ? 503 : 409);
  throw error;
}

async function publicStatus(db: D1Database, row: DepositRow, network: string): Promise<Record<string, unknown>> {
  // A sender's bearer link intentionally has no owner, signature, quote, sender or recovery field.
  const settled = row.state === 'food' ? await db.prepare(`SELECT COALESCE(SUM(CAST(amount_units AS INTEGER)), 0) AS units
    FROM any_chain_sweeps WHERE deposit_id = ? AND state = 'food'`).bind(row.id).first<{ units: number }>() : null;
  const settledUnits = String(settled?.units ?? 0);
  const remainingUnits = row.state === 'food' && BigInt(settledUnits) > 0n && BigInt(row.amount_units) > BigInt(settledUnits)
    ? (BigInt(row.amount_units) - BigInt(settledUnits)).toString() : null;
  const refusal = await db.prepare('SELECT rejection_reason FROM any_chain_sweeps WHERE deposit_id = ? ORDER BY created_at DESC LIMIT 1')
    .bind(row.id).first<{ rejection_reason: string | null }>();
  return { id: row.id, tokenId: row.token_id, state: row.state === 'food' ? 'became_food' : row.state === 'refunded' ? 'refunded' :
    row.state === 'converting' ? 'converting' : 'waiting_for_owner',
    ...(refusal?.rejection_reason ? { reason: refusal.rejection_reason } : {}),
    ...(remainingUnits ? { settledUnits, remainingUnits } : {}),
    source: row.source_explorer,
    nearCredit: row.near_credit_tx ? `https://${network === 'testnet' ? 'testnet.' : ''}nearblocks.io/txns/${row.near_credit_tx}` : null,
    refund: row.source_refund_tx ? row.chain === 'base'
      ? `https://basescan.org/tx/${row.source_refund_tx}` : `https://solscan.io/tx/${row.source_refund_tx}` : null };
}

// spec: add-any-chain-feed › Pet address data › public address read
// spec: add-any-chain-feed › Pet address deposit flow › address entry
anyChainDepositRoutes.get('/api/any-chain/pets/:tokenId/addresses', async (c) => {
  const tokenId = c.req.param('tokenId');
  if (!TOKEN_ID.test(tokenId)) return c.json({ code: 'bad_request' }, 400);
  try {
    // Both domains must remain live before either address is made copyable.
    await preflight(c.env, tokenId, 'base');
    await preflight(c.env, tokenId, 'solana');
    const tokens = await liveTokens();
    const baseToken = tokens.find((token) => token.assetId === ORIGINS.base);
    const solanaToken = tokens.find((token) => token.assetId === ORIGINS.solana);
    if (!baseToken || !solanaToken || baseToken.contractAddress?.toLowerCase() !== BASE_USDC.toLowerCase() ||
      solanaToken.contractAddress !== SOLANA_USDC) throw new QuoteUnavailable('unsupported_origin');
    const addresses = await petAddresses(c.env, tokenId);
    if (!addresses) return c.json({ code: 'no_pet' }, 404);
    const minimums = await Promise.all(addresses.map((item) =>
      addressMinimum(c.env, tokenId, item.chain, item.address)));
    return c.json({ tokenId, addresses: addresses.map(({ chain, address, path }, index) =>
      ({ chain, address, path, asset: ORIGINS[chain],
        contractAddress: chain === 'base' ? baseToken.contractAddress : solanaToken.contractAddress,
        ...minimums[index] })),
      minimumFoodYocto: '10000000000000000000000' });
  } catch (error) { return fault(c, error); }
});

// spec: add-any-chain-feed › Pet address data › source deposit observation
// spec: add-any-chain-feed › Pet address data › sender transaction lookup
// spec: add-any-chain-feed › Pet address deposit flow › sender obtains status link
anyChainDepositRoutes.post('/api/any-chain/deposits/track', async (c) => {
  const body = await c.req.json<{ tokenId?: unknown; chain?: unknown; hash?: unknown; transferIndex?: unknown }>().catch(() => null);
  if (!body || typeof body.tokenId !== 'string' || !TOKEN_ID.test(body.tokenId) ||
    (body.chain !== 'base' && body.chain !== 'solana') || typeof body.hash !== 'string' ||
    !(body.chain === 'base' ? BASE_HASH : SOL_HASH).test(body.hash) ||
    (body.transferIndex !== undefined && (!Number.isInteger(body.transferIndex) ||
      (body.transferIndex as number) < 0 || (body.transferIndex as number) > 1_000_000))) return c.json({ code: 'bad_request' }, 400);
  try {
    // Previously offered addresses remain trackable through a signer outage or a pause.
    const offered = await c.env.DB.prepare('SELECT address FROM any_chain_addresses WHERE token_id = ? AND chain = ?')
      .bind(body.tokenId, body.chain).first<{ address: string }>();
    if (!offered) return c.json({ code: 'address_missing' }, 404);
    if (await currentOwner(c.env, body.tokenId) === null) return c.json({ code: 'no_pet' }, 404);
    const proof = await observedSource(body.chain, body.hash, offered.address, body.transferIndex as number | undefined);
    if (!proof) return c.json({ code: 'source_unverified' }, 404);
    const existing = await c.env.DB.prepare('SELECT * FROM any_chain_deposits WHERE chain = ? AND source_tx_hash = ? AND transfer_index = ?')
      .bind(body.chain, body.hash, proof.index).first<DepositRow>();
    if (existing) {
      if (existing.token_id !== body.tokenId || existing.address.toLowerCase() !== offered.address.toLowerCase())
        return c.json({ code: 'source_unverified' }, 404);
      await recordAnyChainEvent(c.env, { name: 'cross_chain_deposit_seen', key: `address:${body.chain}:${body.chain === 'base' ? body.hash.toLowerCase() : body.hash}:${proof.index}`,
        routeId: existing.id, tokenId: existing.token_id,
        fields: { route: 'pet_address', chain: body.chain, asset: existing.asset } });
      if (existing.asset === 'other') return c.json({ code: 'unsupported_asset', source: existing.source_explorer }, 409);
      return c.json({ id: existing.id, status: await publicStatus(c.env.DB, existing, c.env.NEAR_NETWORK), url: `/pet/${body.tokenId}/feed/status/${existing.id}` });
    }
    const source = body.chain === 'base' ? `https://basescan.org/tx/${body.hash}` : `https://solscan.io/tx/${body.hash}`;
    let state: DepositRow['state'] = proof.asset === 'usdc' ? 'waiting' : 'unsupported';
    if (state === 'waiting') {
      const amount = BigInt(proof.amount) > 1_000_000n ? '1000000' : proof.amount;
      try {
        const request = quoteRequest(c.env, crypto.randomUUID().replaceAll('-', ''), body.tokenId,
          ORIGINS[body.chain], amount, offered.address, true, new Date(Date.now() + 2 * 60 * 60_000).toISOString());
        await liveQuote(request, false);
      } catch (error) {
        if (error instanceof QuoteUnavailable && (error.code === 'below_minimum' || error.code === 'no_payable_quote'))
          state = 'below_minimum';
        else if (error instanceof QuoteUnavailable) { /* The source is verified; quote availability is checked later. */ }
        else throw error;
      }
    }
    const id = crypto.randomUUID().replaceAll('-', '');
    await c.env.DB.prepare(`INSERT OR IGNORE INTO any_chain_deposits
      (id, token_id, chain, source_tx_hash, transfer_index, sender, address, asset, amount_units,
       source_at, state, source_explorer, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, body.tokenId, body.chain, body.hash, proof.index, proof.sender, offered.address,
        proof.asset, proof.amount, proof.at, state, source, Date.now()).run();
    const row = await c.env.DB.prepare('SELECT * FROM any_chain_deposits WHERE chain = ? AND source_tx_hash = ? AND transfer_index = ?')
      .bind(body.chain, body.hash, proof.index).first<DepositRow>();
    if (!row || row.token_id !== body.tokenId || row.address.toLowerCase() !== offered.address.toLowerCase())
      return c.json({ code: 'source_unverified' }, 404);
    await recordAnyChainEvent(c.env, { name: 'cross_chain_deposit_seen', key: `address:${body.chain}:${body.chain === 'base' ? body.hash.toLowerCase() : body.hash}:${proof.index}`,
      routeId: row.id, tokenId: row.token_id,
      fields: { route: 'pet_address', chain: body.chain, asset: row.asset } });
    if (row.asset === 'other') return c.json({ code: 'unsupported_asset', source: row.source_explorer }, 409);
    return c.json({ id: row.id, status: await publicStatus(c.env.DB, row, c.env.NEAR_NETWORK), url: `/pet/${body.tokenId}/feed/status/${row.id}` });
  } catch (error) { return fault(c, error); }
});

// spec: add-any-chain-feed › Pet address data › sender status read
anyChainDepositRoutes.get('/api/any-chain/deposits/:id/status', async (c) => {
  const id = c.req.param('id');
  if (!ID.test(id)) return c.json({ code: 'bad_request' }, 400);
  const row = await c.env.DB.prepare('SELECT * FROM any_chain_deposits WHERE id = ?').bind(id).first<DepositRow>();
  return row ? c.json(await publicStatus(c.env.DB, row, c.env.NEAR_NETWORK)) : c.json({ code: 'deposit_missing' }, 404);
});

// spec: add-any-chain-feed › Pet address data › owner deposit read
anyChainDepositRoutes.get('/api/any-chain/pets/:tokenId/deposits', async (c) => {
  const session = requireSession(c);
  if (session instanceof Response) return session;
  const tokenId = c.req.param('tokenId');
  if (!TOKEN_ID.test(tokenId)) return c.json({ code: 'bad_request' }, 400);
  try {
    const owner = await currentOwner(c.env, tokenId);
    if (owner === null) return c.json({ code: 'no_pet' }, 404);
    if (owner !== session.accountId) return c.json({ code: 'not_owner' }, 403);
    const rows = await c.env.DB.prepare('SELECT * FROM any_chain_deposits WHERE token_id = ? ORDER BY observed_at DESC LIMIT 100')
      .bind(tokenId).all<DepositRow>();
    return c.json({ deposits: rows.results, credits: await ownerCredits(c.env.DB, tokenId) });
  } catch (error) { return fault(c, error); }
});

// spec: add-any-chain-feed › Pet address data › owner deposit read
anyChainDepositRoutes.get('/api/any-chain/deposits/:id/owner', async (c) => {
  const session = requireSession(c);
  if (session instanceof Response) return session;
  const id = c.req.param('id');
  if (!ID.test(id)) return c.json({ code: 'bad_request' }, 400);
  const row = await c.env.DB.prepare('SELECT * FROM any_chain_deposits WHERE id = ?').bind(id).first<DepositRow>();
  if (!row) return c.json({ code: 'deposit_missing' }, 404);
  try {
    const owner = await currentOwner(c.env, row.token_id);
    if (owner === null) return c.json({ code: 'no_pet' }, 404);
    if (owner !== session.accountId) return c.json({ code: 'not_owner' }, 403);
    const sweep = await c.env.DB.prepare(`SELECT route_id, amount_units, destination, refund_recipient, rejection_reason,
      quote_json, approval_hash, expiry_ms, state, near_tx_hash, source_tx_hash, signed_at_ms, updated_at
      FROM any_chain_sweeps WHERE deposit_id = ? ORDER BY created_at DESC LIMIT 1`)
      .bind(id).first<OwnerSweepRow>();
    const used = await c.env.DB.prepare(`SELECT COALESCE(SUM(CAST(amount_units AS INTEGER)), 0) AS units
      FROM any_chain_sweeps WHERE deposit_id = ? AND state IN ('broadcasting', 'sent', 'food')`)
      .bind(id).first<{ units: number }>();
    return c.json({ deposit: row, convertedUnits: String(used?.units ?? 0),
      sweep: sweep ? { routeId: sweep.route_id, amountUnits: sweep.amount_units,
        destination: sweep.destination, refundTo: sweep.refund_recipient,
        quote: JSON.parse(sweep.quote_json) as unknown, approvalHash: sweep.approval_hash,
        expiryMs: sweep.expiry_ms, state: sweep.state, reason: sweep.rejection_reason,
        nearTxHash: sweep.near_tx_hash, sourceTxHash: sweep.source_tx_hash,
        windowEndsAt: (sweep.signed_at_ms ?? sweep.updated_at) + 3_600_000 } : null });
  } catch (error) { return fault(c, error); }
});
