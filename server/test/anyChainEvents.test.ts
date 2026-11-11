import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { recordAnyChainEvent, recordCreditEvents } from '../src/any-chain/events';
import { ONE_CLICK, ORIGINS } from '../src/any-chain/quote';
import { api, harness } from './helpers/api';
import { NEAR_ACCOUNT } from './helpers/network';
import fixture from './fixtures/one-click-quote.json';
import { baseEncode } from 'near-api-js';
import { clean } from '../src/cron';
import { JUDGE_DELETE_AT } from '../src/judge';

const route = 'a'.repeat(32);
const h = harness();

describe('coded cross-chain events', () => {
  beforeEach(() => vi.setSystemTime(new Date('2026-11-15T10:00:00Z')));

  // spec: add-any-chain-feed › Cross-chain playtest data › quote created event
  it('records a payable quote at acceptance and carries no destination or refund address', async () => {
    const refundTo = baseEncode(new Uint8Array(32).fill(9));
    const depositAddress = baseEncode(new Uint8Array(32).fill(7));
    h.net().contract.addPet('1', NEAR_ACCOUNT(1));
    h.net().web.handlers.set(`${ONE_CLICK}/tokens`, () => Response.json([
      { assetId: ORIGINS.solana, blockchain: 'sol', symbol: 'USDC', decimals: 6, price: 1,
        contractAddress: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
    ]));
    h.net().web.handlers.set(`${ONE_CLICK}/quote`, ({ body }) => {
      const request = JSON.parse(body) as { amount: string; dry: boolean; deadline: string };
      return Response.json({ ...fixture, quoteRequest: request, quote: { ...fixture.quote,
        amountIn: request.amount, ...(request.dry ? {} : { depositAddress,
          deadline: request.deadline, timeWhenInactive: request.deadline }) } });
    });
    const dry = await api('/api/any-chain/quote', { body: { tokenId: '1', originAsset: ORIGINS.solana,
      amount: '0.15', refundTo } });
    expect(dry.status).toBe(200);
    expect((await env.EVENTS.prepare('SELECT COUNT(*) AS n FROM any_chain_events').first<{ n: number }>())?.n).toBe(0);
    const accepted = await api(`/api/any-chain/quotes/${dry.body.id}/accept`, { body: {} });
    expect(accepted.status).toBe(200);
    const rows = await env.EVENTS.prepare('SELECT name, chain, asset, min_out_near, fee_usd FROM any_chain_events')
      .all<{ name: string; chain: string; asset: string; min_out_near: number; fee_usd: number }>();
    expect(rows.results).toEqual([{ name: 'cross_chain_quote_created', chain: 'solana', asset: 'usdc',
      min_out_near: Number(fixture.quote.minAmountOut) / 1e24,
      fee_usd: Number(fixture.quote.amountInUsd) - Number(fixture.quote.amountOutUsd) }]);
    expect(JSON.stringify(rows.results)).not.toContain(refundTo);
    expect(JSON.stringify(rows.results)).not.toContain(depositAddress);
  });
  // spec: add-any-chain-feed › Cross-chain playtest data › quote created event
  // spec: add-any-chain-feed › Cross-chain playtest data › deposit seen event
  // spec: add-any-chain-feed › Cross-chain playtest data › refund event
  // spec: add-any-chain-feed › Cross-chain playtest data › stalled event
  it('writes only coded columns and stable once-only ids to EVENTS D1', async () => {
    const events = [
      { name: 'cross_chain_quote_created' as const, key: route,
        fields: { route: 'quote' as const, chain: 'solana' as const, asset: 'usdc' as const,
          minOutNear: 0.04851, feeUsd: 0.01 } },
      { name: 'cross_chain_deposit_seen' as const, key: 'source:abc',
        fields: { route: 'quote' as const, chain: 'solana' as const, asset: 'usdc' as const } },
      { name: 'cross_chain_feed_refunded' as const, key: route,
        fields: { route: 'quote' as const, feeUsd: 0.01 } },
      { name: 'cross_chain_feed_stalled' as const, key: `${route}:provider_failed`,
        fields: { route: 'quote' as const, reason: 'provider_failed', projectUsd: 0.002 } },
    ];
    for (const event of events) {
      await recordAnyChainEvent(env, { ...event, routeId: route, tokenId: '1' });
      await recordAnyChainEvent(env, { ...event, routeId: route, tokenId: '1' });
    }
    await recordAnyChainEvent(env, { name: 'cross_chain_feed_stalled', key: 'private_message',
      routeId: route, fields: { reason: 'my_private_message' } });
    const rows = await env.EVENTS.prepare('SELECT * FROM any_chain_events ORDER BY name').all<Record<string, unknown>>();
    expect(rows.results).toHaveLength(4);
    expect(rows.results.map(({ name }) => name)).toEqual([
      'cross_chain_deposit_seen', 'cross_chain_feed_refunded', 'cross_chain_feed_stalled', 'cross_chain_quote_created',
    ]);
    const serialized = JSON.stringify(rows.results);
    expect(serialized).not.toContain(route);
    expect(serialized).not.toContain('source:abc');
    expect(serialized).not.toContain('token_id');
    expect(serialized).not.toContain('refund_to');
    expect(rows.results.every((item) => /^[0-9a-f]{64}$/.test(String(item.route_id)))).toBe(true);
    await clean(env, JUDGE_DELETE_AT);
    expect((await env.EVENTS.prepare('SELECT COUNT(*) AS n FROM any_chain_events').first<{ n: number }>())?.n).toBe(0);
    vi.setSystemTime(JUDGE_DELETE_AT);
    await recordAnyChainEvent(env, { ...events[0]!, routeId: route });
    expect((await env.EVENTS.prepare('SELECT COUNT(*) AS n FROM any_chain_events').first<{ n: number }>())?.n).toBe(0);
  });

  // spec: add-any-chain-feed › Cross-chain playtest data › settled event
  it('writes settlement, feed and wake once from a confirmed credit with address as anonymous via', async () => {
    await env.DB.prepare("INSERT INTO pets (token_id, hatched_by, born_at, birth_tx, slept_at) VALUES ('1', 'owner', ?, 'tx', ?)")
      .bind(Date.now(), Date.now()).run();
    await env.DB.prepare(`INSERT INTO any_chain_deposits
      (id, token_id, chain, source_tx_hash, transfer_index, sender, address, asset,
       amount_units, state, source_explorer, observed_at)
      VALUES ('deposit', '1', 'solana', 'source', 0, 'sender', 'address', 'usdc',
        '100000', 'converting', 'source-link', ?)`)
      .bind(Date.now() - 30_000).run();
    await env.DB.prepare(`INSERT INTO any_chain_sweeps
      (route_id, deposit_id, token_id, chain, amount_units, provider_wallet, destination,
       refund_recipient, quote_json, payload_hex, approval_hash, sequence, expiry_ms,
       sponsor_cap_micros, estimated_gas_micros, estimated_rent_micros, native_funding_units,
       native_gas_units, native_rent_units, gas_wallet_address, source_meta_json, state, created_at, updated_at)
      VALUES (?, 'deposit', '1', 'solana', '100000', 'provider', 'destination', 'refund',
        '{}', 'payload', 'hash', 0, ?, 50000, 1000, 0, '0', '0', '0', 'gas', '{}', 'food', ?, ?)`)
      .bind(route, Date.now() + 60_000, Date.now(), Date.now()).run();
    await env.DB.prepare(`INSERT INTO any_chain_delivery_evidence
      (receipt_id, route_id, token_id, near_tx_hash, amount_yocto, kind, credit_id, recorded_at)
      VALUES ('receipt', ?, '1', 'near', '50000000000000000000000', 'pending', 7, ?)`)
      .bind(route, Date.now()).run();
    await env.DB.prepare(`INSERT INTO any_chain_credit_evidence
      (credit_id, near_tx_hash, amount_yocto, recorded_at, was_asleep)
      VALUES (7, 'near', '50000000000000000000000', ?, 1)`).bind(Date.now()).run();
    await recordCreditEvents(env, route, 7);
    await recordCreditEvents(env, route, 7);
    const rows = await env.EVENTS.prepare(`SELECT name, route, chain, asset, amount_near, via, source
      FROM any_chain_events WHERE name IN ('cross_chain_feed_settled', 'pet_fed', 'pet_woke') ORDER BY name`)
      .all<{ name: string; route: string | null; chain: string | null; asset: string | null;
        amount_near: number | null; via: string | null; source: string | null }>();
    expect(rows.results).toHaveLength(3);
    expect(rows.results.find((item) => item.name === 'cross_chain_feed_settled')).toMatchObject({
      route: 'pet_address', chain: 'solana', asset: 'usdc', amount_near: 0.05,
    });
    expect(rows.results.filter((item) => item.name === 'pet_fed' || item.name === 'pet_woke'))
      .toEqual([{ name: 'pet_fed', route: null, chain: null, asset: null, amount_near: null,
        via: 'address', source: 'cross_chain' },
      { name: 'pet_woke', route: null, chain: null, asset: null, amount_near: null,
        via: 'address', source: 'cross_chain' }]);
  });
});
