import { WorkerError } from '../seams/worker-types';
import type { OriginToken, QuoteAnswer } from './types';

export type PayIssue = 'error' | 'unsupported' | 'below' | 'above' | 'changed' | 'paused' | 'capacity' | 'stake' | 'receiver';
export type PayPhase =
  | { kind: 'draft' }
  | { kind: 'quoting' }
  | { kind: 'quoted'; answer: QuoteAnswer; origin: OriginToken }
  | { kind: 'accepting'; answer: QuoteAnswer; origin: OriginToken }
  | { kind: 'accepted'; answer: QuoteAnswer; origin: OriginToken }
  | { kind: 'issue'; issue: PayIssue };

export function quoteIssue(error: unknown): PayIssue {
  const code = error instanceof WorkerError ? error.code : '';
  switch (code) {
    case 'unsupported_origin': return 'unsupported';
    case 'below_minimum': return 'below';
    case 'above_ceiling': return 'above';
    case 'quote_expired': return 'changed';
    case 'paused': return 'paused';
    case 'capacity_full': return 'capacity';
    case 'pending_stake_unavailable': return 'stake';
    case 'receiver_unregistered': return 'receiver';
    default: return 'error';
  }
}

export function decimalUnits(value: string, decimals: number): string | null {
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) || decimals < 0 || decimals > 30) return null;
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > decimals) return null;
  const units = BigInt(whole!) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0');
  return units > 0n ? units.toString() : null;
}

export function formatUnits(value: string, decimals: number, places = 5): string {
  if (!/^\d+$/.test(value)) return '—';
  const base = 10n ** BigInt(decimals);
  const whole = BigInt(value) / base;
  const fraction = (BigInt(value) % base).toString().padStart(decimals, '0').slice(0, places).replace(/0+$/, '');
  return `${whole}${fraction ? `.${fraction}` : ''}`;
}

export function supportedToken(tokens: OriginToken[], chain: string, assetId?: string): OriginToken | null {
  return tokens.find((token) => token.blockchain === chain && (!assetId || token.assetId === assetId) &&
    Boolean(token.assetId && token.symbol) && Number.isInteger(token.decimals) && token.decimals >= 0 &&
    token.decimals <= 30 && Number.isFinite(Number(token.price)) && Number(token.price) > 0) ?? null;
}

export function addressExpired(answer: QuoteAnswer, now: number): boolean {
  const inactive = Date.parse(answer.quote.timeWhenInactive ?? '');
  const deadline = Date.parse(answer.quote.deadline ?? '');
  return !Number.isFinite(inactive) || !Number.isFinite(deadline) || now >= Math.min(inactive, deadline);
}
