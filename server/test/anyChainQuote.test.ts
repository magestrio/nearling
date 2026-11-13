import { env } from 'cloudflare:workers';
import { baseEncode } from 'near-api-js';
import { describe, expect, it, vi } from 'vitest';
import fixture from './fixtures/one-click-quote.json';
import { api, harness } from './helpers/api';
import { NEAR_ACCOUNT } from './helpers/network';
import { ONE_CLICK, ORIGINS, WNEAR, originOf } from '../src/any-chain/quote';

const h = harness();
const refundTo = baseEncode(new Uint8Array(32).fill(9));
const depositAddress = baseEncode(new Uint8Array(32).fill(7));
const tokenList = [
  { assetId: WNEAR, blockchain: 'near', symbol: 'wNEAR', decimals: 24, price: 3.75, contractAddress: 'wrap.near' },
  { assetId: ORIGINS.solana, blockchain: 'sol', symbol: 'USDC', decimals: 6, price: 0.999578,
    contractAddress: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
  { assetId: ORIGINS.base, blockchain: 'base', symbol: 'USDC', decimals: 6, price: 0.999578,
    contractAddress: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' },
  { assetId: 'nep141:eth.omft.near', blockchain: 'eth', symbol: 'ETH', decimals: 18, price: 2078.41 },
  { assetId: '1cs_v1:aptos:aptos-fa:0xb07cf73714a0980fd589e1602ea98fc9c18b8c9c82b828ad3662ee873629be1d',
    blockchain: 'aptos', symbol: 'ETH', decimals: 8, price: 2078.74 },
];

interface ReplyControl { expected?: string; minimum?: string; payableMinimum?: string; error?: number; hang?: boolean }

function network(control: ReplyControl = {}) {
  h.net().contract.addPet('1', NEAR_ACCOUNT(1));
  const calls: Record<string, unknown>[] = [];
  h.net().web.handlers.set(`${ONE_CLICK}/tokens`, () => Response.json(tokenList));
  h.net().web.handlers.set(`${ONE_CLICK}/quote`, ({ body }) => {
    if (control.hang) throw new TypeError('Failed to fetch');
    if (control.error !== undefined) return Response.json({ message: 'unavailable' }, { status: control.error });
    const request = JSON.parse(body) as Record<string, unknown>;
    calls.push(request);
    const quote = { ...fixture.quote, amountIn: request.amount,
      amountOut: control.expected ?? fixture.quote.amountOut,
      minAmountOut: request.dry ? control.minimum ?? fixture.quote.minAmountOut
        : control.payableMinimum ?? control.minimum ?? fixture.quote.minAmountOut,
      ...(request.dry ? {} : {
        depositAddress,
        deadline: request.deadline, timeWhenInactive: request.deadline,
      }),
    };
    return Response.json({ ...fixture, quote, quoteRequest: request }, { status: 201 });
  });
  return calls;
}

const body = { tokenId: '1', originAsset: ORIGINS.solana, amount: '0.15', refundTo };

describe('any-chain live quote', () => {
  // spec: add-any-chain-feed › Cross-chain quote flow › unsupported origin
  it('offers every valid live origin token, including native ETH with 18 decimals', async () => {
    vi.setSystemTime(new Date('2026-11-15T10:00:00Z'));
    network();
    const tokens = await api('/api/any-chain/tokens');
    expect(tokens.status).toBe(200);
    expect(tokens.body.tokens.map((token: { assetId: string }) => token.assetId)).toEqual([
      ORIGINS.solana, ORIGINS.base, 'nep141:eth.omft.near',
      '1cs_v1:aptos:aptos-fa:0xb07cf73714a0980fd589e1602ea98fc9c18b8c9c82b828ad3662ee873629be1d']);
    expect(originOf('nep141:eth.omft.near', tokenList)).toBe('eth');
    const eth = await api('/api/any-chain/quote', { body: { ...body, originAsset: 'nep141:eth.omft.near',
      amount: '0.000000000000000001', refundTo: '0x1234567890123456789012345678901234567890' } });
    expect(eth.status).toBe(200);
    const status = await api(`/api/any-chain/status/${eth.body.id}`);
    expect(status.body).toMatchObject({ sourceAsset: 'ETH', sourceAssetId: 'nep141:eth.omft.near',
      sourceChain: 'eth', sourceDecimals: 18, sourceAmount: '1' });
    const acceptedEth = await api(`/api/any-chain/quotes/${eth.body.id}/accept`, { method: 'POST' });
    expect(acceptedEth.status).toBe(200);
    expect((await env.EVENTS.prepare('SELECT chain, asset FROM any_chain_events WHERE name = ?')
      .bind('cross_chain_quote_created').first<{ chain: string; asset: string }>()))
      .toEqual({ chain: 'eth', asset: 'other' });
    const unsupported = await api('/api/any-chain/quote', { body: { ...body, originAsset: 'nep141:other.omft.near' } });
    expect(unsupported.status).toBe(409);
    expect(unsupported.body.code).toBe('unsupported_origin');
  });

  // spec: add-any-chain-feed › Cross-chain quote flow › guest quote
  // spec: add-any-chain-feed › Cross-chain quote data › quote request leaves browser
  it('creates a guest dry quote with pet-bound message and exactly 1% minimum', async () => {
    const calls = network();
    const response = await api('/api/any-chain/quote', { body });
    expect(response.status).toBe(200);
    expect(response.body.quote.minAmountOut).toBe(fixture.quote.minAmountOut);
    expect(response.body.quote.depositAddress).toBeUndefined();
    expect(response.body.id).toMatch(/^[0-9a-f]{32}$/);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ dry: true, originAsset: ORIGINS.solana,
      destinationAsset: WNEAR, amount: '150000', slippageTolerance: 100,
      depositType: 'ORIGIN_CHAIN', refundType: 'ORIGIN_CHAIN', refundTo,
      recipient: env.CONTRACT_ID });
    expect(JSON.parse(String(calls[0]?.customRecipientMsg))).toEqual({ token_id: '1', route: response.body.id, kind: 'quote' });
    expect(h.net().contract.crossChainExternalViews).toContainEqual({
      account: 'v1.signer-prod.testnet', method: 'derived_public_key',
      args: { path: 'solana:1', predecessor: env.CONTRACT_ID, domain_id: 1 },
    });
  });

  // spec: add-any-chain-feed › Cross-chain quote flow › quote below minimum
  // spec: add-any-chain-feed › Cross-chain quote flow › quote above portion ceiling
  it('refuses output below 0.01 or expected output above 0.2 NEAR before storing an address', async () => {
    network({ expected: '9000000000000000000000', minimum: '8910000000000000000000' });
    const low = await api('/api/any-chain/quote', { body });
    expect(low.body.code).toBe('below_minimum');
    h.net().web.handlers.set(`${ONE_CLICK}/quote`, ({ body: raw }) => {
      const request = JSON.parse(raw);
      return Response.json({ ...fixture, quote: { ...fixture.quote, amountIn: request.amount,
        amountOut: '201000000000000000000000', minAmountOut: '198990000000000000000000' },
        quoteRequest: request }, { status: 201 });
    });
    const high = await api('/api/any-chain/quote', { body });
    expect(high.body.code).toBe('above_ceiling');
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM any_chain_routes').first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  // spec: add-any-chain-feed › Cross-chain quote flow › quote below minimum
  // spec: add-any-chain-feed › Cross-chain quote flow › quote above portion ceiling
  it('accepts the exact 0.01 minimum and 0.2 expected ceiling', async () => {
    const control: ReplyControl = { expected: '10101010101010101010101', minimum: '10000000000000000000000' };
    network(control);
    expect((await api('/api/any-chain/quote', { body })).status).toBe(200);
    control.expected = '200000000000000000000000';
    control.minimum = '198000000000000000000000';
    expect((await api('/api/any-chain/quote', { body })).status).toBe(200);
  });

  // spec: add-any-chain-feed › Cross-chain availability rule › services paused
  // spec: add-any-chain-feed › Cross-chain availability rule › receiver not registered
  // spec: add-any-chain-feed › Cross-chain availability rule › pending stake unavailable
  // spec: add-any-chain-feed › Cross-chain availability rule › pending capacity full
  it('closes new destinations at pause, registration, stake and the global 100/101 boundary', async () => {
    const calls = network();
    await env.DB.prepare("INSERT INTO service_pause (id, reason, since) VALUES (1, 'gas', 1)").run();
    expect((await api('/api/any-chain/quote', { body })).body.code).toBe('paused');
    await env.DB.prepare('DELETE FROM service_pause').run();
    h.net().contract.crossChainRegistered = false;
    expect((await api('/api/any-chain/quote', { body })).body.code).toBe('receiver_unregistered');
    h.net().contract.crossChainRegistered = true;
    h.net().contract.crossChainStakeAvailable = false;
    expect((await api('/api/any-chain/quote', { body })).body.code).toBe('pending_stake_unavailable');
    h.net().contract.crossChainStakeAvailable = true;
    h.net().contract.crossChainPendingCount = 100;
    expect((await api('/api/any-chain/quote', { body })).body.code).toBe('capacity_full');
    h.net().contract.crossChainPendingCount = 101;
    expect((await api('/api/any-chain/quote', { body })).body.code).toBe('capacity_full');
    h.net().contract.crossChainPendingCount = 99;
    expect((await api('/api/any-chain/quote', { body })).status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  // spec: add-any-chain-feed › Pet address deposit flow › signer unavailable
  it('checks the pinned public signer before offering an address', async () => {
    const calls = network();
    h.net().contract.crossChainSignerAvailable = false;
    expect((await api('/api/any-chain/quote', { body })).body.code).toBe('signer_unavailable');
    expect(calls).toHaveLength(0);
  });

  // spec: add-any-chain-feed › Pet address deposit flow › signer unavailable
  it('uses the Base signer domain and chain-qualified pet path for a Base quote', async () => {
    network();
    const response = await api('/api/any-chain/quote', { body: {
      ...body, originAsset: ORIGINS.base, refundTo: `0x${'a'.repeat(40)}`,
    } });
    expect(response.status).toBe(200);
    expect(h.net().contract.crossChainExternalViews).toContainEqual({
      account: 'v1.signer-prod.testnet', method: 'derived_public_key',
      args: { path: 'base:1', predecessor: env.CONTRACT_ID, domain_id: 0 },
    });
    // The recorded Solana-shaped deposit address is not a payable Base destination.
    expect((await api(`/api/any-chain/quotes/${response.body.id}/accept`, { method: 'POST' })).body.code)
      .toBe('quote_expired');
  });

  // spec: add-any-chain-feed › Cross-chain quote flow › quote created
  it('accepts once and exposes the provider deadline, fee and refund recipient without claiming food', async () => {
    const calls = network();
    const dry = await api('/api/any-chain/quote', { body });
    const accepted = await api(`/api/any-chain/quotes/${dry.body.id}/accept`, { method: 'POST' });
    expect(accepted.status).toBe(200);
    expect(accepted.body.quote.depositAddress).toBe(depositAddress);
    expect(accepted.body.quote.deadline).toBeTruthy();
    expect(accepted.body.quote.refundFee).toBe('10005');
    expect(accepted.body.refundTo).toBe(refundTo);
    expect(accepted.body.food).toBeUndefined();
    expect(calls.map((call) => call.dry)).toEqual([true, false]);
    h.net().contract.crossChainPendingCount = 100;
    const existing = await env.DB.prepare('SELECT state, deposit_address FROM any_chain_routes WHERE id = ?')
      .bind(dry.body.id).first<{ state: string; deposit_address: string }>();
    expect(existing).toMatchObject({ state: 'accepted',
      deposit_address: depositAddress });
    expect((await api('/api/any-chain/quote', { body })).body.code).toBe('capacity_full');
    expect((await api(`/api/any-chain/quotes/${dry.body.id}/accept`, { method: 'POST' })).body.code).toBe('quote_expired');
  });

  // spec: add-any-chain-feed › Cross-chain availability rule › changed quote
  it('never issues an address after the payable minimum drops more than 1%', async () => {
    const control: ReplyControl = {};
    network(control);
    const dry = await api('/api/any-chain/quote', { body });
    control.expected = '40400000000000000000000';
    control.payableMinimum = '40000000000000000000000';
    const changed = await api(`/api/any-chain/quotes/${dry.body.id}/accept`, { method: 'POST' });
    expect(changed.body.code).toBe('quote_expired');
    const row = await env.DB.prepare('SELECT deposit_address FROM any_chain_routes WHERE id = ?').bind(dry.body.id)
      .first<{ deposit_address: string | null }>();
    expect(row?.deposit_address).toBeNull();
  });

  // spec: add-any-chain-feed › Cross-chain availability rule › changed quote
  // spec: add-any-chain-feed › Cross-chain quote flow › quote created
  it('accepts a payable minimum within 1% of the shown one and returns the new minimum', async () => {
    const control: ReplyControl = {};
    network(control);
    const shown = BigInt(fixture.quote.minAmountOut);
    const floor = (shown * 99n + 99n) / 100n;
    const below = await api('/api/any-chain/quote', { body });
    const within = await api('/api/any-chain/quote', { body });
    control.expected = '41000000000000000000000';
    control.payableMinimum = String(floor - 1n);
    expect((await api(`/api/any-chain/quotes/${below.body.id}/accept`, { method: 'POST' })).body.code).toBe('quote_expired');
    control.payableMinimum = String(floor);
    const accepted = await api(`/api/any-chain/quotes/${within.body.id}/accept`, { method: 'POST' });
    expect(accepted.status).toBe(200);
    expect(accepted.body.quote.minAmountOut).toBe(String(floor));
    expect(accepted.body.quote.depositAddress).toBe(depositAddress);
    const row = await env.DB.prepare('SELECT state, min_out FROM any_chain_routes WHERE id = ?').bind(within.body.id)
      .first<{ state: string; min_out: string }>();
    expect(row).toEqual({ state: 'accepted', min_out: String(floor) });
  });

  // spec: add-any-chain-feed › Cross-chain pay sheet screen › error
  it('keeps an unknown payable outcome from creating a second address on retry', async () => {
    const control: ReplyControl = {};
    network(control);
    const dry = await api('/api/any-chain/quote', { body });
    control.hang = true;
    expect((await api(`/api/any-chain/quotes/${dry.body.id}/accept`, { method: 'POST' })).body.code)
      .toBe('provider_unavailable');
    control.hang = false;
    expect((await api(`/api/any-chain/quotes/${dry.body.id}/accept`, { method: 'POST' })).body.code)
      .toBe('quote_expired');
  });

  // spec: add-any-chain-feed › Cross-chain availability rule › pending capacity full
  it('rechecks capacity before accepting an earlier dry quote', async () => {
    const calls = network();
    const dry = await api('/api/any-chain/quote', { body });
    h.net().contract.crossChainPendingCount = 100;
    expect((await api(`/api/any-chain/quotes/${dry.body.id}/accept`, { method: 'POST' })).body.code)
      .toBe('capacity_full');
    expect(calls).toHaveLength(1);
  });

  // spec: add-any-chain-feed › Cross-chain pay sheet screen › error
  it('fails closed on a provider error and records no route', async () => {
    network({ error: 503 });
    const response = await api('/api/any-chain/quote', { body });
    expect(response.body.code).toBe('provider_unavailable');
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM any_chain_routes').first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  // spec: add-any-chain-feed › Cross-chain pay sheet screen › error
  it('treats a rejected or malformed provider quote as no payable quote', async () => {
    network({ error: 400 });
    expect((await api('/api/any-chain/quote', { body })).body.code).toBe('no_payable_quote');
    h.net().web.handlers.set(`${ONE_CLICK}/quote`, ({ body: raw }) => {
      const request = JSON.parse(raw);
      return Response.json({ ...fixture, quoteRequest: request,
        quote: { ...fixture.quote, amountIn: request.amount, minAmountOut: '0' } }, { status: 201 });
    });
    expect((await api('/api/any-chain/quote', { body })).body.code).toBe('below_minimum');
    h.net().web.handlers.set(`${ONE_CLICK}/quote`, () => Response.json({ unexpected: true }, { status: 201 }));
    expect((await api('/api/any-chain/quote', { body })).body.code).toBe('provider_unavailable');
  });
});
