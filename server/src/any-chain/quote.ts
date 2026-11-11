import { ChainUnreachable, petView, rpcProvider } from '../chain';
import { isPaused } from '../servicePause';

export const ONE_CLICK = 'https://1click.chaindefuser.com/v0';
export const WNEAR = 'nep141:wrap.near';
export const ORIGINS = {
  base: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near',
  solana: 'nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near',
} as const;
export type Origin = keyof typeof ORIGINS;

const MIN_FOOD = 10_000_000_000_000_000_000_000n;
const MAX_EXPECTED = 200_000_000_000_000_000_000_000n;
const FETCH_MS = 8_000;

export interface OneClickToken {
  assetId: string;
  blockchain: string;
  symbol: string;
  decimals: number;
  price: number;
  contractAddress?: string;
}
export function payableToken(value: unknown): value is OneClickToken {
  if (!value || typeof value !== 'object') return false;
  const token = value as OneClickToken;
  return typeof token.assetId === 'string' && token.assetId.length <= 256 &&
    /^[A-Za-z0-9:._-]+$/.test(token.assetId) &&
    token.assetId !== WNEAR &&
    typeof token.blockchain === 'string' && /^[a-z0-9_-]{2,32}$/.test(token.blockchain) &&
    typeof token.symbol === 'string' && token.symbol.length > 0 && token.symbol.length <= 32 &&
    Number.isInteger(token.decimals) && token.decimals >= 0 && token.decimals <= 30 &&
    Number.isFinite(token.price) && token.price > 0 &&
    (token.contractAddress === undefined || (typeof token.contractAddress === 'string' && token.contractAddress.length > 0));
}

export interface OneClickQuote {
  quote: {
    amountIn: string;
    amountInUsd: string;
    amountOut: string;
    amountOutUsd: string;
    minAmountOut: string;
    refundFee: string;
    withdrawFee: string;
    timeEstimate: number;
    depositAddress?: string;
    depositMemo?: string;
    deadline?: string;
    timeWhenInactive?: string;
  };
  quoteRequest: { originAsset: string; destinationAsset: string; amount: string; customRecipientMsg?: string;
    refundTo: string; refundType: string; depositType: string; recipient: string; recipientType: string;
    slippageTolerance: number; deadline: string; dry: boolean };
  signature: string;
  correlationId: string;
}

export class QuoteUnavailable extends Error {
  constructor(readonly code: string) { super(code); }
}

async function oneClick<T>(path: string, body?: unknown, timeoutMs = FETCH_MS): Promise<T> {
  try {
    const response = await fetch(`${ONE_CLICK}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new QuoteUnavailable(response.status === 400 ? 'no_payable_quote' : 'provider_unavailable');
    return await response.json() as T;
  } catch (error) {
    if (error instanceof QuoteUnavailable) throw error;
    throw new QuoteUnavailable('provider_unavailable');
  }
}

export async function liveTokens(): Promise<OneClickToken[]> {
  const response = await oneClick<unknown>('/tokens');
  if (!Array.isArray(response)) throw new QuoteUnavailable('provider_unavailable');
  return response.filter(payableToken);
}

/** Source-chain native price from the same live provider catalog as the USDC quote. */
export async function nativePrice(chain: Origin): Promise<number> {
  const response = await oneClick<unknown>('/tokens');
  if (!Array.isArray(response)) throw new QuoteUnavailable('provider_unavailable');
  const token = response.find((item): item is OneClickToken => item !== null && typeof item === 'object' &&
    (item as OneClickToken).blockchain === (chain === 'base' ? 'base' : 'sol') &&
    (item as OneClickToken).symbol === (chain === 'base' ? 'ETH' : 'SOL') &&
    Number.isFinite((item as OneClickToken).price) && (item as OneClickToken).price > 0);
  if (!token) throw new QuoteUnavailable('provider_unavailable');
  return token.price;
}

/** USD price of NEAR from the same 1-Click token list used by the any-chain feed. */
export async function nearUsdPrice(): Promise<number | null> {
  const response = await oneClick<unknown>('/tokens', undefined, 1_000);
  if (!Array.isArray(response)) return null;
  const token = response.find((item): item is OneClickToken => item !== null && typeof item === 'object' &&
    (item as OneClickToken).assetId === WNEAR);
  return token && Number.isFinite(token.price) && token.price > 0 ? token.price : null;
}

export function amountUnits(value: unknown, decimals = 6): string | null {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,11})(?:\.\d{1,30})?$/.test(value)) return null;
  const [whole = '', fraction = ''] = value.split('.');
  if (fraction.length > decimals) return null;
  const amount = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0');
  return amount > 0n ? amount.toString() : null;
}

export function originOf(asset: unknown): Origin | null;
export function originOf(asset: unknown, tokens: OneClickToken[]): string | null;
export function originOf(asset: unknown, tokens?: OneClickToken[]): string | null {
  if (tokens) return tokens.find((token) => token.assetId === asset)?.blockchain ?? null;
  if (asset === ORIGINS.base) return 'base';
  if (asset === ORIGINS.solana) return 'solana';
  return null;
}

export function refundAddressValid(chain: Origin, address: unknown): address is string {
  return typeof address === 'string' && (chain === 'base'
    ? /^0x[0-9a-fA-F]{40}$/.test(address)
    : /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address));
}

interface CapacityView { pending_count: number; pending_cap: number; capacity_available: boolean; stake_available: boolean }
interface SignerView { signer_id: string | null; base_domain_id: number; solana_domain_id: number; path_format: string }

async function externalView<T>(env: Env, contractId: string, method: string, args: Record<string, unknown>): Promise<T> {
  try {
    return await rpcProvider(env).callFunction({ contractId, method, args }) as T;
  } catch { throw new ChainUnreachable(); }
}

/** All reads are live. A failure closes the offer, while an existing status link still works. */
export async function preflight(env: Env, tokenId: string, chain?: Origin): Promise<void> {
  if (await isPaused(env.DB, 'thought')) throw new QuoteUnavailable('paused');
  if (await petView(env, tokenId) === null) throw new QuoteUnavailable('no_pet');
  const registered = await externalView<unknown>(env, env.NEAR_NETWORK === 'testnet' ? 'wrap.testnet' : 'wrap.near',
    'storage_balance_of', { account_id: env.CONTRACT_ID });
  if (registered === null) throw new QuoteUnavailable('receiver_unregistered');
  const capacity = await externalView<CapacityView>(env, env.CONTRACT_ID, 'cross_chain_capacity_view', { token_id: tokenId });
  if (!Number.isSafeInteger(capacity.pending_cap) || capacity.pending_cap < 1 ||
    capacity.pending_count >= capacity.pending_cap || !capacity.capacity_available)
    throw new QuoteUnavailable('capacity_full');
  if (!capacity.stake_available) throw new QuoteUnavailable('pending_stake_unavailable');
  if (chain === undefined) return;
  const signer = await externalView<SignerView>(env, env.CONTRACT_ID, 'sweep_signer_view', {});
  if (!signer.signer_id || signer.path_format !== '<chain>:<token_id>' || signer.base_domain_id !== 0 || signer.solana_domain_id !== 1)
    throw new QuoteUnavailable('signer_unavailable');
  const path = `${chain}:${tokenId}`;
  const domain_id = chain === 'base' ? signer.base_domain_id : signer.solana_domain_id;
  const key = await externalView<unknown>(env, signer.signer_id, 'derived_public_key', { path, predecessor: env.CONTRACT_ID, domain_id });
  if (typeof key !== 'string' || !key.startsWith(chain === 'base' ? 'secp256k1:' : 'ed25519:') ||
    !/^[1-9A-HJ-NP-Za-km-z]+$/.test(key.split(':')[1] ?? ''))
    throw new QuoteUnavailable('signer_unavailable');
}

export function quoteRequest(env: Env, id: string, tokenId: string, asset: string, amount: string,
  refundTo: string, dry: boolean, deadline: string, kind: 'quote' | 'pet_address' = 'quote'): Record<string, unknown> {
  return {
    dry, depositMode: 'SIMPLE', swapType: 'EXACT_INPUT', slippageTolerance: 100,
    originAsset: asset, depositType: 'ORIGIN_CHAIN', destinationAsset: WNEAR,
    amount, refundTo, refundType: 'ORIGIN_CHAIN', recipient: env.CONTRACT_ID,
    recipientType: 'DESTINATION_CHAIN', deadline,
    customRecipientMsg: JSON.stringify({ token_id: tokenId, route: id, kind }),
  };
}

export async function liveQuote(request: Record<string, unknown>, payable: boolean, enforcePortion = true): Promise<OneClickQuote> {
  const answer = await oneClick<OneClickQuote>('/quote', request);
  const quote = answer?.quote;
  const echo = answer?.quoteRequest;
  if (!quote || !echo || typeof answer.signature !== 'string' || typeof answer.correlationId !== 'string' ||
    echo.originAsset !== request.originAsset || echo.destinationAsset !== WNEAR ||
    echo.amount !== request.amount || echo.refundTo !== request.refundTo || echo.recipient !== request.recipient ||
    echo.refundType !== 'ORIGIN_CHAIN' || echo.depositType !== 'ORIGIN_CHAIN' ||
    echo.recipientType !== 'DESTINATION_CHAIN' || echo.deadline !== request.deadline ||
    echo.customRecipientMsg !== request.customRecipientMsg || echo.slippageTolerance !== 100 ||
    echo.dry !== !payable || !/^\d+$/.test(quote.amountOut) || !/^\d+$/.test(quote.minAmountOut) ||
    !/^\d+$/.test(quote.amountIn) || quote.amountIn !== request.amount ||
    !/^\d+$/.test(quote.refundFee) || !/^\d+$/.test(quote.withdrawFee) ||
    !Number.isFinite(quote.timeEstimate) || quote.timeEstimate < 0 ||
    (payable && (!quote.depositAddress || !quote.deadline || !quote.timeWhenInactive ||
      !Number.isFinite(Date.parse(quote.deadline)) || !Number.isFinite(Date.parse(quote.timeWhenInactive)))))
    throw new QuoteUnavailable('provider_unavailable');
  const expected = BigInt(quote.amountOut);
  const minimum = BigInt(quote.minAmountOut);
  if (enforcePortion && (expected < MIN_FOOD || minimum < MIN_FOOD)) throw new QuoteUnavailable('below_minimum');
  if (enforcePortion && expected > MAX_EXPECTED) throw new QuoteUnavailable('above_ceiling');
  if (minimum > expected || minimum < expected * 99n / 100n) throw new QuoteUnavailable('provider_unavailable');
  return answer;
}

/** A conservative live USDC floor, rounded upward to cents and verified by a dry quote. */
export async function addressMinimum(env: Env, tokenId: string, chain: Origin, address: string): Promise<{
  amountUsdc: string; waitSeconds: number;
}> {
  const deadline = new Date(Date.now() + 2 * 60 * 60_000).toISOString();
  const preview = async (cents: number): Promise<OneClickQuote | null> => {
    const request = quoteRequest(env, crypto.randomUUID().replaceAll('-', ''), tokenId, ORIGINS[chain],
      String(cents * 10_000), address, true, deadline, 'pet_address');
    try { return await liveQuote(request, false, false); }
    catch (error) {
      if (error instanceof QuoteUnavailable && error.code === 'no_payable_quote') return null;
      throw error;
    }
  };
  let low = 0;
  let high = 100;
  const first = await preview(high);
  if (!first || BigInt(first.quote.minAmountOut) < MIN_FOOD) throw new QuoteUnavailable('provider_unavailable');
  // The live one-dollar quote is a bracket, and its output gives a smaller first probe.
  // Every amount offered below is still checked by its own current dry quote.
  const proportional = Number((100n * MIN_FOOD + BigInt(first.quote.minAmountOut) - 1n) /
    BigInt(first.quote.minAmountOut));
  if (proportional >= 1 && proportional < high) {
    const projected = await preview(proportional);
    if (projected && BigInt(projected.quote.minAmountOut) >= MIN_FOOD) high = proportional;
    else {
      low = proportional;
      const next = await preview(proportional + 1);
      if (next && BigInt(next.quote.minAmountOut) >= MIN_FOOD) high = proportional + 1;
    }
  }
  while (high - low > 1) {
    const middle = Math.floor((high + low) / 2);
    const answer = await preview(middle);
    if (answer && BigInt(answer.quote.minAmountOut) >= MIN_FOOD) high = middle;
    else low = middle;
  }
  const verified = await preview(high);
  if (!verified || BigInt(verified.quote.minAmountOut) < MIN_FOOD) throw new QuoteUnavailable('provider_unavailable');
  return { amountUsdc: (high / 100).toFixed(2), waitSeconds: verified.quote.timeEstimate };
}
