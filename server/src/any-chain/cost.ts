import { nearUsdRate, yoctoToUsdMicros } from '../pricing';
import { rpcProvider } from '../chain';
import { PROJECT_CAP_MICROS } from '../projectBudget';

export { PROJECT_CAP_MICROS } from '../projectBudget';

/** The expense key is a chain transaction or receipt id, never a retry attempt. */
export async function recordExpense(env: Pick<Env, 'DB' | 'NEAR_USD_RATE'>, data: {
  id: string; routeId: string; kind: 'source_gas' | 'source_account_rent' | 'near_signer_gas' |
    'near_release_gas' | 'near_return_deposit_gas'; usdMicros: number;
}): Promise<void> {
  if (!Number.isSafeInteger(data.usdMicros) || data.usdMicros < 0 || data.usdMicros > PROJECT_CAP_MICROS)
    throw new Error('invalid_any_chain_cost');
  if (data.usdMicros === 0) return;
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256',
    new TextEncoder().encode(`nearling:any-chain:expense:${data.id}`)));
  const id = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO project_spend (at, kind, usd_micros, any_chain_expense_id)
      VALUES (?, ?, ?, ?)`).bind(Date.now(), data.kind, data.usdMicros, id),
    env.DB.prepare(`INSERT OR IGNORE INTO any_chain_expense_links (expense_id, route_id, kind, usd_micros)
      SELECT any_chain_expense_id, ?, kind, usd_micros FROM project_spend WHERE any_chain_expense_id = ?`)
      .bind(data.routeId, id),
  ]);
}

export async function recordNearExpense(env: Pick<Env, 'DB' | 'NEAR_USD_RATE'>, data: {
  id: string; routeId: string; kind: 'near_signer_gas' | 'near_release_gas' | 'near_return_deposit_gas';
  burntYocto: string | undefined;
}): Promise<void> {
  if (!data.burntYocto || !/^\d+$/.test(data.burntYocto)) return;
  const rate = nearUsdRate(env.NEAR_USD_RATE);
  if (rate === null) throw new Error('near_rate_missing');
  await recordExpense(env, { ...data, usdMicros: yoctoToUsdMicros(BigInt(data.burntYocto), rate) });
}

/** The FINAL outcome includes callback receipts; optimistic execution can undercount gas. */
export async function recordFinalNearExpense(env: Env, data: {
  id: string; routeId: string; kind: 'near_signer_gas' | 'near_release_gas' | 'near_return_deposit_gas';
  txHash: string; signer: string;
}): Promise<boolean> {
  try {
    const raw = await rpcProvider(env).viewTransactionStatus({ txHash: data.txHash,
      accountId: data.signer, waitUntil: 'FINAL' }) as unknown as {
        final_execution_status?: string; transaction?: { hash?: string; signer_id?: string };
        transaction_outcome?: { outcome?: { tokens_burnt?: string } };
        receipts_outcome?: { outcome?: { tokens_burnt?: string } }[];
      };
    if (raw.final_execution_status !== 'FINAL' || raw.transaction?.hash !== data.txHash ||
      raw.transaction.signer_id !== data.signer || !raw.transaction_outcome?.outcome?.tokens_burnt ||
      !raw.receipts_outcome?.every((item) => item.outcome?.tokens_burnt !== undefined)) return false;
    const burnt = BigInt(raw.transaction_outcome.outcome.tokens_burnt) +
      raw.receipts_outcome.reduce((total, item) => total + BigInt(item.outcome!.tokens_burnt!), 0n);
    await recordNearExpense(env, { id: data.id, routeId: data.routeId, kind: data.kind,
      burntYocto: burnt.toString() });
    return true;
  } catch { /* The original hash remains in D1 for a later reconciliation. */ return false; }
}

export async function routeProjectUsd(db: D1Database, routeId: string): Promise<number> {
  const row = await db.prepare('SELECT COALESCE(SUM(usd_micros), 0) AS total FROM any_chain_expense_links WHERE route_id = ?')
    .bind(routeId).first<{ total: number }>();
  return (row?.total ?? 0) / 1_000_000;
}
