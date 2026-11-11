import { JUDGE_DELETE_AT } from '../judge';
import { publicPetId } from '../pet/publicIds';
import { routeProjectUsd } from './cost';

export type AnyChainEventName = 'cross_chain_quote_created' | 'cross_chain_deposit_seen' |
  'cross_chain_feed_settled' | 'cross_chain_feed_refunded' | 'cross_chain_feed_stalled' |
  'pet_fed' | 'pet_woke';
export type RouteKind = 'quote' | 'pet_address';
const REASONS = new Set(['provider_failed', 'delivery_unverified', 'unwrap_failed',
  'provider_refund_unverified', 'source_failed', 'source_gas_cap', 'source_gas_unavailable',
  'settlement_transfer_failed', 'reverse_exchange_failed']);
export type EventFields = {
  route?: RouteKind; chain?: string; asset?: 'usdc' | 'other';
  minOutNear?: number; feeUsd?: number; amountNear?: number; elapsedSeconds?: number;
  projectUsd?: number; reason?: string; source?: 'cross_chain'; via?: 'link' | 'owner' | 'address';
};

async function digest(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Only typed, coded fields reach EVENTS. Stable ids repair a failed write on a later read. */
export async function recordAnyChainEvent(env: Pick<Env, 'DB' | 'EVENTS'>, data: {
  name: AnyChainEventName; key: string; routeId: string; tokenId?: string | null; fields?: EventFields;
}): Promise<void> {
  if (Date.now() >= JUDGE_DELETE_AT || !/^[0-9a-z:_-]{1,160}$/i.test(data.key) ||
    !/^[0-9a-f]{32}$/.test(data.routeId) ||
    (data.tokenId != null && !/^\d{1,20}$/.test(data.tokenId))) return;
  const fields = data.fields ?? {};
  if ([fields.minOutNear, fields.feeUsd, fields.amountNear, fields.projectUsd].some((value) =>
    value !== undefined && (!Number.isFinite(value) || value < 0)) ||
    (fields.elapsedSeconds !== undefined && (!Number.isSafeInteger(fields.elapsedSeconds) || fields.elapsedSeconds < 0)) ||
    (fields.reason !== undefined && !REASONS.has(fields.reason))) return;
  try {
    const [id, route, pet] = await Promise.all([
      digest(`nearling:any-chain:event:${data.name}:${data.key}`),
      digest(`nearling:any-chain:route:${data.routeId}`),
      data.tokenId ? publicPetId(env.DB, data.tokenId) : Promise.resolve(null),
    ]);
    await env.EVENTS.prepare(`INSERT OR IGNORE INTO any_chain_events
      (id, at, name, route_id, pet_id, route, chain, asset, min_out_near, fee_usd,
       amount_near, elapsed_seconds, project_usd, reason, source, via)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, Date.now(), data.name,
      route, pet, fields.route ?? null, fields.chain ?? null, fields.asset ?? null,
      fields.minOutNear ?? null, fields.feeUsd ?? null, fields.amountNear ?? null,
      fields.elapsedSeconds ?? null, fields.projectUsd ?? null, fields.reason ?? null,
      fields.source ?? null, fields.via ?? null).run();
  } catch { console.log('any_chain_event_write_failed'); }
}

export function nearAmount(yocto: string): number {
  const padded = yocto.padStart(25, '0');
  return Number(`${padded.slice(0, -24)}.${padded.slice(-24)}`);
}

export function usdcFee(units: string | undefined): number {
  return units && /^\d+$/.test(units) ? Number(units) / 1e6 : 0;
}

/** Reconciliation may be reached by a status read, a retry or cron; all use one credit key. */
export async function recordCreditEvents(env: Pick<Env, 'DB' | 'EVENTS'>, routeId: string, creditId: number): Promise<void> {
  const credit = await env.DB.prepare(`SELECT d.token_id, c.amount_yocto, c.recorded_at,
    c.was_asleep FROM any_chain_delivery_evidence d JOIN any_chain_credit_evidence c ON c.credit_id = d.credit_id
    WHERE d.credit_id = ? AND d.route_id = ?`).bind(creditId, routeId)
    .first<{ token_id: string; amount_yocto: string; recorded_at: number; was_asleep: number }>();
  if (!credit) return;
  const quote = await env.DB.prepare('SELECT origin_asset, origin_chain, origin_symbol, created_at, via FROM any_chain_routes WHERE id = ?')
    .bind(routeId).first<{ origin_asset: string; origin_chain: string | null; origin_symbol: string | null;
      created_at: number; via: 'link' | 'owner' }>();
  const sweep = quote ? null : await env.DB.prepare(`SELECT s.chain, d.observed_at FROM any_chain_sweeps s
    JOIN any_chain_deposits d ON d.id = s.deposit_id WHERE s.route_id = ?`)
    .bind(routeId).first<{ chain: 'base' | 'solana'; observed_at: number }>();
  if (!quote && !sweep) return;
  const route = quote ? 'quote' : 'pet_address';
  const chain = quote ? quote.origin_chain === 'sol' ? 'solana' : quote.origin_chain ?? undefined : sweep?.chain;
  const via = quote?.via ?? 'address';
  const key = `${routeId}:${creditId}`;
  await recordAnyChainEvent(env, { name: 'cross_chain_feed_settled', key, routeId,
    tokenId: credit.token_id, fields: { route, chain,
      asset: quote?.origin_symbol === 'USDC' || !quote ? 'usdc' : 'other', amountNear: nearAmount(credit.amount_yocto),
      elapsedSeconds: Math.max(0, Math.floor((credit.recorded_at - (quote?.created_at ?? sweep!.observed_at)) / 1000)),
      projectUsd: await routeProjectUsd(env.DB, routeId) } });
  await recordAnyChainEvent(env, { name: 'pet_fed', key, routeId, tokenId: credit.token_id,
    fields: { source: 'cross_chain', via } });
  if (credit.was_asleep === 1) await recordAnyChainEvent(env, { name: 'pet_woke', key, routeId,
    tokenId: credit.token_id, fields: { source: 'cross_chain', via } });
}
