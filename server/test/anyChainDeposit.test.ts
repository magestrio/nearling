import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import fixture from './fixtures/one-click-quote.json';
import { api, harness } from './helpers/api';
import { NEAR_ACCOUNT, token } from './helpers/network';
import { ONE_CLICK, ORIGINS } from '../src/any-chain/quote';

const h = harness();
const hash = `0x${'c'.repeat(64)}`;
const usdc = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const transfer = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const tokens = Object.entries(ORIGINS).map(([chain, assetId]) => ({ assetId, blockchain: chain === 'solana' ? 'sol' : chain,
  symbol: 'USDC', decimals: 6, price: 1, contractAddress: chain === 'base' ? usdc : 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' }));

async function setup(asset = usdc, amount = '150000', finalized = true) {
  h.net().contract.addPet('1', NEAR_ACCOUNT(1), { name: 'Pixel' });
  h.net().web.handlers.set(`${ONE_CLICK}/tokens`, () => Response.json(tokens));
  h.net().web.handlers.set(`${ONE_CLICK}/quote`, ({ body }) => {
    const request = JSON.parse(body) as Record<string, unknown>;
    return Response.json({ ...fixture, quote: { ...fixture.quote, amountIn: request.amount,
      amountOut: BigInt(String(request.amount)) < 10000n ? '9000000000000000000000' : fixture.quote.amountOut,
      minAmountOut: BigInt(String(request.amount)) < 10000n ? '8910000000000000000000' : fixture.quote.minAmountOut },
    quoteRequest: request }, { status: 201 });
  });
  const addresses = await api('/api/any-chain/pets/1/addresses');
  expect(addresses.status).toBe(200);
  const address = addresses.body.addresses[0].address as string;
  h.net().web.handlers.set('https://mainnet.base.org', ({ body }) => {
    const request = JSON.parse(body) as { method: string; params: string[] };
    if (request.method === 'eth_getBlockByNumber') return Response.json({ result: {
      number: finalized ? '0x10' : '0x0f', timestamp: '0x65000000',
    } });
    if (request.params[0] !== hash) return Response.json({ result: { status: '0x1', blockNumber: '0x10', logs: [] } });
    if (request.method === 'eth_getTransactionReceipt') return Response.json({ result: {
      status: '0x1', blockNumber: '0x10', logs: [{ address: asset, logIndex: '0x2',
        topics: [transfer, `0x${'0'.repeat(24)}${'b'.repeat(40)}`, `0x${'0'.repeat(24)}${address.slice(2)}`],
        data: `0x${BigInt(amount).toString(16).padStart(64, '0')}` }],
    } });
    return Response.json({ result: null });
  });
  return address;
}

describe('pet-address source observation and access', () => {
  // spec: add-any-chain-feed › Pet address data › owner deposit read
  it('returns no owner sweep or spent portion before a verified deposit gets a bounded quote', async () => {
    await setup();
    const tracked = await api('/api/any-chain/deposits/track', { body: { tokenId: '1', chain: 'base', hash } });
    const ownerToken = await token('owner', NEAR_ACCOUNT(1));
    const detail = await api(`/api/any-chain/deposits/${tracked.body.id}/owner`, { token: ownerToken });
    expect(detail.body).toMatchObject({ convertedUnits: '0', sweep: null,
      deposit: { id: tracked.body.id, amount_units: '150000', chain: 'base' } });
    const publicRead = await api(`/api/any-chain/deposits/${tracked.body.id}/status`);
    expect(publicRead.body).not.toHaveProperty('sweep');
    expect(publicRead.body).not.toHaveProperty('convertedUnits');
  });
  // spec: add-any-chain-feed › Pet address data › sender transaction lookup
  // spec: add-any-chain-feed › Pet address deposit flow › sender obtains status link
  it('gives a verified source hash one stable opaque link, with only public status fields', async () => {
    await setup();
    const wrong = await api('/api/any-chain/deposits/track', { body: { tokenId: '1', chain: 'base', hash: `0x${'d'.repeat(64)}` } });
    expect(wrong.status).toBe(404);
    expect((await api('/api/any-chain/deposits/track', { body: {
      tokenId: '1', chain: 'base', hash, transferIndex: 3,
    } })).status).toBe(404);
    const observed = await api('/api/any-chain/deposits/track', { body: { tokenId: '1', chain: 'base', hash } });
    expect(observed.status).toBe(200);
    expect(observed.body.id).toMatch(/^[0-9a-f]{32}$/);
    expect(observed.body.id).not.toBe(hash);
    expect((await api('/api/any-chain/deposits/track', { body: { tokenId: '1', chain: 'base', hash } })).body.id).toBe(observed.body.id);
    const status = await api(`/api/any-chain/deposits/${observed.body.id}/status`);
    expect(status.body).toEqual({ id: observed.body.id, tokenId: '1', state: 'waiting_for_owner',
      source: `https://basescan.org/tx/${hash}`, nearCredit: null, refund: null });
    expect(JSON.stringify(status.body)).not.toContain(NEAR_ACCOUNT(1));
    expect(JSON.stringify(status.body)).not.toContain('sender');
    expect((await env.DB.prepare('SELECT transfer_index AS i FROM any_chain_deposits WHERE id = ?')
      .bind(observed.body.id).first<{ i: number }>())?.i).toBe(2);
    for (const [stored, shown] of [['converting', 'converting'], ['food', 'became_food'], ['refunded', 'refunded']] as const) {
      await env.DB.prepare('UPDATE any_chain_deposits SET state = ?, near_credit_tx = ?, source_refund_tx = ? WHERE id = ?')
        .bind(stored, stored === 'food' ? 'N'.repeat(44) : null,
          stored === 'refunded' ? `0x${'a'.repeat(64)}` : null, observed.body.id).run();
      const publicRead = (await api(`/api/any-chain/deposits/${observed.body.id}/status`)).body;
      expect(publicRead.state).toBe(shown);
      if (stored === 'food') expect(publicRead.nearCredit).toBe(`https://testnet.nearblocks.io/txns/${'N'.repeat(44)}`);
      expect(publicRead.tokenId).toBe('1');
      expect(Object.keys(publicRead).sort()).toEqual(['id', 'nearCredit', 'refund', 'source', 'state', 'tokenId']);
      expect(JSON.stringify(publicRead)).not.toContain(NEAR_ACCOUNT(1));
    }
  });

  // spec: add-any-chain-feed › Pet address data › source deposit observation
  // spec: add-any-chain-feed › Pet address deposit flow › unsupported deposit
  // spec: add-any-chain-feed › Pet address deposit flow › below conversion minimum
  it('requires finality and records unsupported assets and a too-small confirmed USDC amount without food', async () => {
    await setup(usdc, '150000', false);
    expect((await api('/api/any-chain/deposits/track', { body: { tokenId: '1', chain: 'base', hash } })).status).toBe(404);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM any_chain_deposits').first<{ n: number }>())?.n).toBe(0);
    await setup(`0x${'e'.repeat(40)}`);
    const other = await api('/api/any-chain/deposits/track', { body: { tokenId: '1', chain: 'base', hash } });
    expect(other.status).toBe(409);
    expect(other.body).not.toHaveProperty('url');
    expect((await env.DB.prepare('SELECT state FROM any_chain_deposits WHERE source_tx_hash = ?').bind(hash)
      .first<{ state: string }>())?.state).toBe('unsupported');
    await env.DB.prepare('DELETE FROM any_chain_deposits').run();
    await setup(usdc, '9000');
    const small = await api('/api/any-chain/deposits/track', { body: { tokenId: '1', chain: 'base', hash } });
    expect((await env.DB.prepare('SELECT state FROM any_chain_deposits WHERE id = ?').bind(small.body.id)
      .first<{ state: string }>())?.state).toBe('below_minimum');
  });

  // spec: add-any-chain-feed › Pet address data › owner deposit read
  // spec: add-any-chain-feed › Pet address deposit flow › gift before settlement
  it('checks the NFT owner afresh for list and detail after a gift', async () => {
    await setup();
    const tracked = await api('/api/any-chain/deposits/track', { body: { tokenId: '1', chain: 'base', hash } });
    const oldToken = await token('old-owner', NEAR_ACCOUNT(1));
    const newToken = await token('new-owner', NEAR_ACCOUNT(2));
    expect((await api('/api/any-chain/pets/1/deposits', { token: oldToken })).body.deposits).toHaveLength(1);
    h.net().contract.pets.get('1')!.owner_id = NEAR_ACCOUNT(2);
    expect((await api(`/api/any-chain/deposits/${tracked.body.id}/owner`, { token: oldToken })).status).toBe(403);
    expect((await api('/api/any-chain/pets/1/deposits', { token: oldToken })).status).toBe(403);
    expect((await api(`/api/any-chain/deposits/${tracked.body.id}/owner`, { token: newToken })).body.deposit.amount_units).toBe('150000');
  });

  // spec: add-any-chain-feed › Pet address data › source deposit observation
  it('observes a finalized Solana SPL-USDC instruction at the pet address', async () => {
    await setup();
    const address = (await api('/api/any-chain/pets/1/addresses')).body.addresses[1].address as string;
    const mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const solHash = 'E'.repeat(88);
    h.net().web.handlers.set('https://api.mainnet-beta.solana.com', ({ body }) => {
      const request = JSON.parse(body) as { method: string };
      if (request.method !== 'getTransaction') return Response.json({ result: null });
      return Response.json({ result: { blockTime: 1_700_000_000, meta: { err: null,
        preTokenBalances: [
          { accountIndex: 0, mint, owner: 'F'.repeat(44), uiTokenAmount: { amount: '150000' } },
          { accountIndex: 1, mint, owner: address, uiTokenAmount: { amount: '0' } },
        ], postTokenBalances: [
          { accountIndex: 0, mint, owner: 'F'.repeat(44), uiTokenAmount: { amount: '0' } },
          { accountIndex: 1, mint, owner: address, uiTokenAmount: { amount: '150000' } },
        ], innerInstructions: [] }, transaction: { message: {
          accountKeys: [{ pubkey: 'L'.repeat(44) }, { pubkey: 'M'.repeat(44) }],
          instructions: [{ program: 'spl-token', parsed: { type: 'transferChecked',
            info: { source: 'L'.repeat(44), destination: 'M'.repeat(44), mint,
              tokenAmount: { amount: '150000' } } } }],
        } } } });
    });
    const observed = await api('/api/any-chain/deposits/track', { body: { tokenId: '1', chain: 'solana', hash: solHash } });
    expect(observed.status).toBe(200);
    const row = await env.DB.prepare('SELECT chain, transfer_index, asset, amount_units FROM any_chain_deposits WHERE id = ?')
      .bind(observed.body.id).first<{ chain: string; transfer_index: number; asset: string; amount_units: string }>();
    expect(row).toEqual({ chain: 'solana', transfer_index: 0, asset: 'usdc', amount_units: '150000' });
  });
});
