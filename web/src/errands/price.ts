// What Errand sheet's «Send · …» says (`Errand sheet screen` › «success», «a search form», «food covers fewer searches»). The server
// prices an errand after it ran, by usage; this is the estimate before «Send», from the quote it gave (`Errand price data`).
import { formatCents } from '../lib/price';
import type { ErrandForm, ErrandQuote, Price } from '../seams/worker-types';

/** A page is read up to ≈ 8,000 tokens (`Read this flow`); what is longer is not read, so the estimate stops there. */
export const READ_LIMIT_TOKENS = 8_000;
/** A search form with all its searches: the spec's own words «up to ≈ 2¢». */
export const FULL_SEARCH = '2¢';

/** A link: the trimmed field is one `http://` or `https://` address with no whitespace; anything else is text read as is
 *  (`Read this flow`). */
export function isLink(field: string): boolean {
  const text = field.trim();
  return /^https?:\/\/\S+$/i.test(text);
}

/** The page's tokens: ⌈UTF-8 bytes / 4⌉, the server's own count (`Link reader data`). */
export function pageTokens(text: string): number {
  return Math.ceil(new TextEncoder().encode(text).length / 4);
}

const asNumber = (yocto: string): number => Number(BigInt(yocto));

/** The price of a read of `field`: a link stays at the typical read until it is read, pasted text is `base + perToken × tokens`
 *  of its length, in cents at the quote's own rate (`typical.cents` ÷ `typical.yocto`). */
export function readEstimate(quote: ErrandQuote, field: string): Price {
  const { typical, base, perToken } = quote.read;
  if (field.trim() === '' || isLink(field)) return typical;
  const tokens = Math.min(pageTokens(field), READ_LIMIT_TOKENS);
  const yocto = BigInt(base) + BigInt(perToken) * BigInt(tokens);
  const perYocto = typical.cents / asNumber(typical.yocto);
  return { yocto: yocto.toString(), cents: asNumber(yocto.toString()) * perYocto };
}

/** The words after «Send · »: «≈ 0.15¢» for a read, «up to ≈ 2¢» for a search form (what the food covers when it covers fewer). */
export function sendPrice(form: ErrandForm, quote: ErrandQuote, field: string): string {
  if (form === 'read') return `≈ ${formatCents(readEstimate(quote, field).cents)}`;
  const cents = quote.search.full && quote.search.allowance === 2 && quote.labels.length > 0
    ? `${quote.search.upTo.cents.toFixed(2)}¢`
    : quote.search.full && quote.search.allowance === 3 && quote.search.upTo.cents === 2
      ? FULL_SEARCH
      : formatCents(quote.search.upTo.cents);
  return `up to ≈ ${cents}`;
}
