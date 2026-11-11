import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { api, harness } from './helpers/api';
import { setTrackSink } from '../src/track';

const h = harness();
const route = 'a'.repeat(32);
const hash = 'Q'.repeat(44);
const amount = '10000000000000000000000';

async function pending(failed: boolean): Promise<void> {
  await env.DB.prepare(`INSERT INTO any_chain_delivery_evidence
    (receipt_id, route_id, token_id, near_tx_hash, amount_yocto, kind, credit_id, unwrap_failed, recorded_at)
    VALUES (?, ?, '1', ?, ?, 'pending', 7, ?, ?)`)
    .bind('R'.repeat(44), route, 'S'.repeat(44), amount, failed ? 1 : 0, Date.now()).run();
}

function retryTx(credited: boolean) {
  const args = btoa(JSON.stringify({ credit_id: 7 }));
  return { final_execution_status: 'FINAL', transaction: { hash, signer_id: env.GAS_ACCOUNT_ID,
    receiver_id: env.CONTRACT_ID, actions: [{ FunctionCall: { method_name: 'retry_unwrap', args } }] },
    receipts: [], receipts_outcome: [{ id: 'T'.repeat(44), outcome: { executor_id: env.CONTRACT_ID,
      logs: credited ? [`EVENT_JSON:${JSON.stringify({ standard: 'nearling', version: '1.0.0',
        event: 'cross_chain_feed', data: { credit_id: 7, token_id: '1', route_id: route, amount } })}`] : [],
      status: { SuccessValue: '' } } }] };
}

describe('failed cross-chain credit retry', () => {
  // spec: add-any-chain-feed › wNEAR recovery contract › route not recoverable
  it('rejects unknown, held and in-flight ids without signing a transaction', async () => {
    expect((await api('/api/any-chain/credits/7/retry', { method: 'POST' })).body.code).toBe('credit_missing');
    await pending(false);
    expect((await api('/api/any-chain/credits/7/retry', { method: 'POST' })).body.code).toBe('not_recoverable');
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM any_chain_retry_operations').first<{ n: number }>())?.n).toBe(0);
  });

  // spec: add-any-chain-feed › wNEAR recovery contract › route already settled
  it('rejects a credit already confirmed by a public contract event', async () => {
    await pending(true);
    await env.DB.prepare('INSERT INTO any_chain_credit_evidence (credit_id, near_tx_hash, amount_yocto, recorded_at) VALUES (7, ?, ?, ?)')
      .bind(hash, amount, Date.now()).run();
    expect((await api('/api/any-chain/credits/7/retry', { method: 'POST' })).body.code).toBe('already_settled');
  });

  // spec: add-any-chain-feed › wNEAR recovery contract › retry failed route
  it('uses the same credit id and records food only after the retry receipt emits a matching feed event', async () => {
    await pending(true);
    await env.DB.prepare(`INSERT INTO any_chain_retry_operations (credit_id, state, tx_hash, created_at, updated_at)
      VALUES (7, 'sending', ?, ?, ?)`).bind(hash, Date.now(), Date.now()).run();
    h.net().contract.outcomes.set(hash, retryTx(false));
    expect((await api('/api/any-chain/credits/7/retry', { method: 'POST' })).body.state).toBe('retry_pending');
    h.net().contract.outcomes.set(hash, retryTx(true));
    const events: string[] = [];
    const reset = setTrackSink((name) => events.push(name));
    const settled = await api('/api/any-chain/credits/7/retry', { method: 'POST' });
    expect(settled.body).toMatchObject({ state: 'food', creditId: 7, nearTxHash: hash });
    expect((await api('/api/any-chain/credits/7/retry', { method: 'POST' })).body.code).toBe('already_settled');
    reset();
    expect(events).toEqual(['pet_fed']);
  });

  // spec: add-any-chain-feed › wNEAR recovery contract › retry failed route
  it('persists one signed gas-account transaction before broadcast and does not send a second one while unknown', async () => {
    await pending(true);
    const first = await api('/api/any-chain/credits/7/retry', { method: 'POST' });
    expect(first.body.state).toBe('retry_pending');
    const row = await env.DB.prepare('SELECT state, tx_hash, signed_bytes FROM any_chain_retry_operations WHERE credit_id = 7')
      .first<{ state: string; tx_hash: string | null; signed_bytes: ArrayBuffer | null }>();
    expect(row?.tx_hash).toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/);
    expect(row?.signed_bytes).not.toBeNull();
    const count = h.net().contract.statusHashes.length;
    const second = await api('/api/any-chain/credits/7/retry', { method: 'POST' });
    expect({ second, logs: h.logs() }).toMatchObject({ second: { status: 200,
      body: { state: 'retry_pending', nearTxHash: row?.tx_hash } }, logs: [] });
    expect(h.net().contract.statusHashes.length).toBe(count + 1);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM any_chain_retry_operations').first<{ n: number }>())?.n).toBe(1);
  });
});
