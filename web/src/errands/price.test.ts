import { describe, expect, it } from 'vitest';
import type { ErrandQuote } from '../seams/worker-types';
import { isLink, pageTokens, readEstimate, READ_LIMIT_TOKENS, sendPrice } from './price';

// The quote as the Worker's `GET …/errand` answers it for a pet that can pay: a typical read ≈ 0.15¢ (3,000 tokens of page), a search
// form up to ≈ 2¢; `base` and `perToken` in yocto.
const QUOTE: ErrandQuote = {
  form: 'read',
  paused: false,
  read: { typical: { yocto: '325000000000000000000', cents: 0.15 }, base: '200000000000000000000', perToken: '42000000000000000' },
  search: { upTo: { yocto: '4330000000000000000000', cents: 2 }, full: true, short: false, searches: 3, allowance: 3 },
  block: null,
  labels: [],
  sharedNeeded: { yocto: '4330000000000000000000', cents: 2 },
};

describe('the price Errand sheet shows before «Send»', () => {
  // spec: add-pet-errands › Errand sheet screen › success
  it('says the typical read for an empty field and for a link, until the link is read', () => {
    expect(sendPrice('read', QUOTE, '')).toBe('≈ 0.15¢');
    expect(sendPrice('read', QUOTE, 'https://example.com/dreams')).toBe('≈ 0.15¢');
    expect(sendPrice('read', QUOTE, '  https://example.com/dreams  ')).toBe('≈ 0.15¢');
  });

  // spec: add-pet-errands › Errand sheet screen › success
  it('moves with the length of pasted text, by the quarter-byte token count the server uses', () => {
    const short = readEstimate(QUOTE, 'Our lease says: sixty days\' notice.');
    const long = readEstimate(QUOTE, 'x'.repeat(8_000));
    expect(Number(short.yocto)).toBeLessThan(Number(long.yocto));
    expect(short.cents).toBeLessThan(long.cents);
    expect(BigInt(long.yocto)).toBe(BigInt(QUOTE.read.base) + BigInt(QUOTE.read.perToken) * 2_000n);
    // a multi-byte character costs its bytes: four bytes is one token
    expect(pageTokens('ab')).toBe(1);
    expect(pageTokens('日本語')).toBe(3);
    expect(pageTokens('')).toBe(0);
  });

  // spec: add-pet-errands › Errand sheet screen › success
  it('stops at the 8,000 tokens a read takes: a longer text is not read, so its price does not grow', () => {
    const edge = readEstimate(QUOTE, 'x'.repeat(READ_LIMIT_TOKENS * 4));
    const past = readEstimate(QUOTE, 'x'.repeat(READ_LIMIT_TOKENS * 4 + 4_000));
    expect(past.yocto).toBe(edge.yocto);
  });

  // spec: add-pet-errands › Errand sheet screen › a search form
  it('says «up to ≈ 2¢» for a search form whose food covers all its searches', () => {
    expect(sendPrice('find', QUOTE, 'When do the Leonids peak?')).toBe('up to ≈ 2¢');
    expect(sendPrice('check', QUOTE, 'Octopuses have three hearts.')).toBe('up to ≈ 2¢');
  });

  // spec: add-pet-errands › Errand sheet screen › food covers fewer searches
  it('says «up to ≈ {price}» at what the food covers when it covers fewer', () => {
    const short: ErrandQuote = { ...QUOTE, search: { upTo: { yocto: '2690000000000000000000', cents: 1.24 }, full: false, short: true, searches: 1, allowance: 3 } };
    expect(sendPrice('find', short, 'x')).toBe('up to ≈ 1.2¢');
  });

  // spec: add-pet-errands › Errand sheet screen › a skill with outside data
  it('uses the data-source quote ceiling even when that quote is full', () => {
    const withData: ErrandQuote = { ...QUOTE, search: { upTo: { yocto: '3790000000000000000000', cents: 1.75 }, full: true, short: false, searches: 2, allowance: 2 }, labels: ['Daybook'] };
    expect(sendPrice('find', withData, 'x')).toBe('up to ≈ 1.75¢');
  });

  // spec: add-pet-errands › Read this flow › page can't be read
  it('takes the trimmed field for a link only when it is one http or https address with no whitespace', () => {
    expect(isLink('https://example.com/a')).toBe(true);
    expect(isLink('http://example.com')).toBe(true);
    expect(isLink('example.com')).toBe(false);
    expect(isLink('https://example.com/a and more')).toBe(false);
    expect(isLink('ftp://example.com')).toBe(false);
    expect(isLink('see https://example.com')).toBe(false);
  });
});
