import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { recordExpense, recordFinalNearExpense, recordNearExpense, routeProjectUsd } from '../src/any-chain/cost';
import { harness } from './helpers/api';

const route = 'a'.repeat(32);
const h = harness();

describe('cross-chain project costs', () => {
  // spec: add-any-chain-feed › Cross-chain playtest data › project spend
  it('books actual failed source gas and account rent once each, outside payer and provider fees', async () => {
    await recordExpense(env, { id: 'base:source_gas:failed_tx', routeId: route,
      kind: 'source_gas', usdMicros: 15_000 });
    await recordExpense(env, { id: 'base:source_gas:failed_tx', routeId: route,
      kind: 'source_gas', usdMicros: 15_000 });
    await recordExpense(env, { id: 'solana:source_account_rent:creation_tx', routeId: route,
      kind: 'source_account_rent', usdMicros: 170_000 });
    const sum = await env.DB.prepare(`SELECT SUM(usd_micros) AS total, COUNT(*) AS count FROM project_spend
      WHERE any_chain_expense_id IS NOT NULL`).first<{ total: number; count: number }>();
    expect(sum).toEqual({ total: 185_000, count: 2 });
    expect(await routeProjectUsd(env.DB, route)).toBe(0.185);
    const keys = await env.DB.prepare('SELECT any_chain_expense_id AS id FROM project_spend WHERE any_chain_expense_id IS NOT NULL')
      .all<{ id: string }>();
    expect(keys.results.every(({ id }) => /^[0-9a-f]{64}$/.test(id))).toBe(true);
  });

  // spec: add-any-chain-feed › Cross-chain playtest data › project spend
  it('books NEAR signer, release and return-deposit gas by distinct transaction keys', async () => {
    const yocto = '100000000000000000000';
    await recordNearExpense(env, { id: 'near:signer:tx1', routeId: route,
      kind: 'near_signer_gas', burntYocto: yocto });
    await recordNearExpense(env, { id: 'near:release:tx2', routeId: route,
      kind: 'near_release_gas', burntYocto: yocto });
    await recordNearExpense(env, { id: 'near:return-deposit:tx3', routeId: route,
      kind: 'near_return_deposit_gas', burntYocto: yocto });
    await recordNearExpense(env, { id: 'near:release:tx2', routeId: route,
      kind: 'near_release_gas', burntYocto: yocto });
    const rows = await env.DB.prepare(`SELECT kind, usd_micros FROM project_spend
      WHERE kind IN ('near_release_gas', 'near_return_deposit_gas', 'near_signer_gas')
      ORDER BY kind`).all<{ kind: string; usd_micros: number }>();
    expect(rows.results.map((item) => item.kind)).toEqual([
      'near_release_gas', 'near_return_deposit_gas', 'near_signer_gas',
    ]);
    expect(rows.results.every((item) => item.usd_micros > 0)).toBe(true);
  });

  // spec: add-any-chain-feed › Cross-chain playtest data › project spend
  it('uses only a final NEAR transaction of the expected signer and includes receipt gas', async () => {
    const hash = 'B'.repeat(44);
    h.net().contract.outcomes.set(hash, { final_execution_status: 'FINAL',
      transaction: { hash, signer_id: env.SERVER_ACCOUNT_ID },
      transaction_outcome: { outcome: { tokens_burnt: '100000000000000000000' } },
      receipts_outcome: [{ outcome: { tokens_burnt: '200000000000000000000' } }],
    });
    await recordFinalNearExpense(env, { id: `near:signer:${hash}`, routeId: route,
      kind: 'near_signer_gas', txHash: hash, signer: env.TREASURY_ACCOUNT_ID });
    expect(await routeProjectUsd(env.DB, route)).toBe(0);
    await recordFinalNearExpense(env, { id: `near:signer:${hash}`, routeId: route,
      kind: 'near_signer_gas', txHash: hash, signer: env.SERVER_ACCOUNT_ID });
    await recordFinalNearExpense(env, { id: `near:signer:${hash}`, routeId: route,
      kind: 'near_signer_gas', txHash: hash, signer: env.SERVER_ACCOUNT_ID });
    const cost = await env.DB.prepare('SELECT usd_micros FROM project_spend WHERE any_chain_expense_id IS NOT NULL')
      .first<{ usd_micros: number }>();
    expect(cost?.usd_micros).toBeGreaterThan(0);
    expect(await routeProjectUsd(env.DB, route)).toBe((cost?.usd_micros ?? 0) / 1_000_000);
  });
});
