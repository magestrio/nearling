import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { cleanResolvedPayments, PAYMENT_RETENTION_MS } from '../src/any-chain/retention';
import { ORIGINS } from '../src/any-chain/quote';
import { harness } from './helpers/api';
import { api } from './helpers/api';
import { NEAR_ACCOUNT, token } from './helpers/network';

const old = Date.now() - PAYMENT_RETENTION_MS - 1;
const h = harness();
const pending = 'a'.repeat(32);
const done = 'b'.repeat(32);

async function route(id: string, resolvedAt: number | null): Promise<void> {
  await env.DB.prepare(`INSERT INTO any_chain_routes
    (id, token_id, origin_asset, amount_in, refund_to, expected_out, min_out, quote_json,
     state, created_at, request_deadline)
    VALUES (?, '1', ?, '100000', ?, '10000000000000000000000',
      '9900000000000000000000', '{}', 'accepted', ?, ?)`)
    .bind(id, ORIGINS.solana, 'F'.repeat(44), old, new Date(old + 3_600_000).toISOString()).run();
  await env.DB.prepare(`INSERT INTO any_chain_route_status
    (route_id, provider_state, last_checked_at, resolved_at) VALUES (?, 'SUCCESS', ?, ?)`)
    .bind(id, old, resolvedAt).run();
}

describe('cross-chain retention', () => {
  // spec: add-any-chain-feed › Cross-chain retention data › resolved status expires
  it('deletes resolved quote and refund address after thirty days, preserving unresolved recovery', async () => {
    await route(done, old);
    await route(pending, null);
    await env.DB.prepare(`INSERT INTO any_chain_delivery_evidence
      (receipt_id, route_id, token_id, near_tx_hash, amount_yocto, kind, credit_id, recorded_at)
      VALUES ('settled-receipt', ?, '1', 'near', '10000000000000000000000', 'pending', 4, ?)`)
      .bind(done, old).run();
    await env.DB.prepare(`INSERT INTO any_chain_credit_evidence
      (credit_id, near_tx_hash, amount_yocto, recorded_at)
      VALUES (4, 'near', '10000000000000000000000', ?)`).bind(old).run();
    expect((await api(`/api/any-chain/status/${done}`)).status).toBe(200);
    await cleanResolvedPayments(env.DB);
    expect(await env.DB.prepare('SELECT refund_to FROM any_chain_routes WHERE id = ?').bind(done).first()).toBeNull();
    expect((await api(`/api/any-chain/status/${done}`)).status).toBe(404);
    expect(await env.DB.prepare('SELECT refund_to FROM any_chain_routes WHERE id = ?').bind(pending).first()).not.toBeNull();
  });

  // spec: add-any-chain-feed › Cross-chain retention data › resolved status expires
  it('starts the retention clock for a definitively failed accepted route with no source transfer', async () => {
    const id = '9'.repeat(32);
    await route(id, null);
    await env.DB.prepare("UPDATE any_chain_routes SET provider_deadline = ? WHERE id = ?")
      .bind(new Date(old).toISOString(), id).run();
    await env.DB.prepare("UPDATE any_chain_route_status SET provider_state = 'FAILED' WHERE route_id = ?")
      .bind(id).run();
    expect((await api(`/api/any-chain/status/${id}`)).body.state).toBe('provider_failed');
    const status = await env.DB.prepare('SELECT resolved_at FROM any_chain_route_status WHERE route_id = ?')
      .bind(id).first<{ resolved_at: number | null }>();
    expect(status?.resolved_at).toBe(Date.now());
    await cleanResolvedPayments(env.DB, Date.now() + PAYMENT_RETENTION_MS + 1);
    expect((await api(`/api/any-chain/status/${id}`)).status).toBe(404);
  });

  // spec: add-any-chain-feed › Cross-chain retention data › resolved status expires
  it('cancels expiry when a later verified source transfer reopens recovery', async () => {
    const id = '8'.repeat(32);
    await route(id, Date.now() - PAYMENT_RETENTION_MS);
    await env.DB.prepare(`UPDATE any_chain_route_status SET source_tx_hash = 'source',
      source_condition = 'observed' WHERE route_id = ?`).bind(id).run();
    expect((await api(`/api/any-chain/status/${id}`)).body.state).toBe('delivery_unverified');
    expect((await env.DB.prepare('SELECT resolved_at FROM any_chain_route_status WHERE route_id = ?')
      .bind(id).first<{ resolved_at: number | null }>())?.resolved_at).toBeNull();
    await cleanResolvedPayments(env.DB, Date.now() + PAYMENT_RETENTION_MS + 1);
    expect((await api(`/api/any-chain/status/${id}`)).status).toBe(200);
  });

  // spec: add-any-chain-feed › Cross-chain retention data › resolved status expires
  it('keeps a held delivery until source-chain refund is confirmed, even after route resolution', async () => {
    const id = 'c'.repeat(32);
    await route(id, old);
    await env.DB.prepare(`INSERT INTO any_chain_delivery_evidence
      (receipt_id, route_id, near_tx_hash, amount_yocto, kind, held_id, recorded_at)
      VALUES ('receipt', ?, 'nearhash', '100', 'held', 41, ?)`).bind(id, old).run();
    await env.DB.prepare(`INSERT INTO any_chain_held_returns (held_id, receipt_id, amount_yocto, reason)
      VALUES (41, 'receipt', '100', 'wrong_sender')`).run();
    await cleanResolvedPayments(env.DB);
    expect(await env.DB.prepare('SELECT id FROM any_chain_routes WHERE id = ?').bind(id).first()).not.toBeNull();
  });

  // spec: add-any-chain-feed › Cross-chain retention data › resolved status expires
  it('expires a fully consumed pet-address deposit for both sender and owner, retaining a remainder', async () => {
    const owner = NEAR_ACCOUNT(1);
    h.net().contract.addPet('1', owner);
    const ownerToken = await token('retention-owner', owner);
    for (const [id, units] of [['e'.repeat(32), '100000'], ['f'.repeat(32), '200000']]) {
      await env.DB.prepare(`INSERT INTO any_chain_deposits
        (id, token_id, chain, source_tx_hash, transfer_index, sender, address, asset, amount_units,
         state, source_explorer, observed_at, resolved_at)
        VALUES (?, '1', 'solana', ?, 0, 'sender', 'address', 'usdc', ?, 'food', 'source', ?, ?)`)
        .bind(id, id, units, old, old).run();
      await env.DB.prepare(`INSERT INTO any_chain_sweeps
        (route_id, deposit_id, token_id, chain, amount_units, provider_wallet, destination,
         refund_recipient, quote_json, payload_hex, approval_hash, sequence, expiry_ms,
         sponsor_cap_micros, estimated_gas_micros, estimated_rent_micros, native_funding_units,
         native_gas_units, native_rent_units, gas_wallet_address, source_meta_json, state, created_at, updated_at)
        VALUES (?, ?, '1', 'solana', '100000', 'provider', 'destination', 'refund',
          '{}', 'payload', 'hash', 0, ?, 50000, 1000, 0, '0', '0', '0', 'gas', '{}', 'food', ?, ?)`)
        .bind(id, id, old + 60_000, old, old).run();
    }
    expect((await api(`/api/any-chain/deposits/${'e'.repeat(32)}/status`)).status).toBe(200);
    expect((await api('/api/any-chain/pets/1/deposits', { token: ownerToken })).body.deposits).toHaveLength(2);
    await cleanResolvedPayments(env.DB);
    expect((await api(`/api/any-chain/deposits/${'e'.repeat(32)}/status`)).status).toBe(404);
    expect((await api(`/api/any-chain/deposits/${'f'.repeat(32)}/status`)).status).toBe(200);
    const ownerRead = await api('/api/any-chain/pets/1/deposits', { token: ownerToken });
    expect(ownerRead.body.deposits.map((item: { id: string }) => item.id)).toEqual(['f'.repeat(32)]);
  });

  // spec: add-any-chain-feed › Cross-chain retention data › memory cleared
  it('retains payment records independently of pet memory rows', async () => {
    const id = 'd'.repeat(32);
    await route(id, null);
    const owner = NEAR_ACCOUNT(2);
    h.net().contract.addPet('1', owner);
    const ownerToken = await token('memory-owner', owner);
    await env.DB.prepare("INSERT INTO pets (token_id, hatched_by, born_at, birth_tx) VALUES ('1', 'owner', ?, 'tx')")
      .bind(Date.now()).run();
    await env.DB.prepare("INSERT INTO memory_notes (token_id, kind, name, at) VALUES ('1', 'friend', 'example', ?)")
      .bind(Date.now()).run();
    const cleared = await api('/api/pets/1/memory/clear', { token: ownerToken, body: {} });
    expect(cleared).toMatchObject({ status: 200, body: {
      paymentRecordsNotice: 'Payment records stay for recovery. On-chain credits cannot be erased.',
    } });
    expect(await env.DB.prepare('SELECT * FROM memory_notes WHERE token_id = ?').bind('1').first()).toBeNull();
    await cleanResolvedPayments(env.DB);
    expect(await env.DB.prepare('SELECT id FROM any_chain_routes WHERE id = ?').bind(id).first()).not.toBeNull();
  });
});
