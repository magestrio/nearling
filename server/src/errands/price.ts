// The price of an errand before it is sent (`Errand sheet screen`, `Errand flow` › «can't pay», `Errand price
// data`), pure: the rates of `pricing.ts`, the search fee of `SEARCH_USD_PER_CALL`, the arithmetic of PRODUCT.md
// §4 › Поручения. A search costs the fee × 1.2 on top of the search call's tokens × 1.2; the gas share is paid
// once per thought. Money is usd12 (1e-12 USD) as in `pricing.ts`, and yocto by the rate of NEAR, rounded up.
import {
  costUsd12,
  GAS_SHARE_USD12,
  MAX_THOUGHT_PRICE_YOCTO,
  STARTER_FOOD_YOCTO,
  marked,
  usd12ToYocto,
  type PriceEnv,
} from '../pricing';
import { projectPays, yoctoMicros } from '../spend';
import type { FoodState } from '../pet/view';

export type ErrandForm = 'read' | 'find' | 'check';
export const FORMS: readonly ErrandForm[] = ['read', 'find', 'check'];
export const isSearchForm = (form: ErrandForm): boolean => form !== 'read';

export type ErrandPriceEnv = PriceEnv & { SEARCH_USD_PER_CALL: string };

/** What a read takes in one go, in tokens of the page (`Read this flow`: ≈ 8,000). */
export const READ_LIMIT_TOKENS = 8_000;
/** The layers, the character and the form's line: ≈ 1,000 tokens (§4 › Поручения, hypothesis). */
export const LAYER_TOKENS = 1_000;
/** A typical page and a typical report (§4: 3,000 in the page, 700 out). */
export const TYPICAL_PAGE_TOKENS = 3_000;
export const TYPICAL_REPORT_OUT = 700;
/** The fuse of the report with reasoning and of its re-ask (§4 › Предохранители). */
export const REPORT_FUSE = 1_600;
export const REASK_FUSE = 600;
/** The search call's input at 1, 2, 3 searches (the interpolation of §4) and its output bound. */
export const SEARCH_IN = [8_900, 14_500, 20_000] as const;
export const SEARCH_OUT_BOUND = 100;
const SEARCH_OUT_TYPICAL = 70;
/** The results the report reads (≤ 12,000 characters ≈ 3,000 tokens) and the data of a pet with sources (≤ 16,000
 * characters ≈ 4,000 tokens). */
const RESULTS_TOKENS = 3_000;
const DATA_TOKENS = 4_000;
/** The ceiling of three searches with their report: ≈ 2.05¢ (`Errand price data` › «three searches ran»). */
const THREE_SEARCHES_USD12 = 20_500_000_000n;

/** A price in both units: usd12 (the cents shown never move with NEAR's rate) and yocto at the rate now. */
export interface Priced {
  usd12: bigint;
  yocto: bigint;
}

function priced(env: PriceEnv, usd12: bigint): Priced {
  return { usd12, yocto: usd12ToYocto(env, usd12) };
}

/** `{ yocto, cents }` as the sheet carries a price: cents with two significant digits. */
export function view(p: Priced): { yocto: string; cents: number } {
  return { yocto: p.yocto.toString(), cents: Number((Number(p.usd12) / 1e10).toPrecision(2)) };
}

/** What one search costs the pet: the project's fee × 1.2, in usd12. */
export function searchFeeUsd12(env: Pick<ErrandPriceEnv, 'SEARCH_USD_PER_CALL'>): bigint {
  return (BigInt(Math.round(Number(env.SEARCH_USD_PER_CALL) * 1e12)) * 12n + 9n) / 10n;
}

/** The price of an errand's thought by usage: every call's tokens × 1.2, each search that ran at the fee × 1.2, and the
 * gas share once (`Errand price data`). */
export function errandPrice(env: ErrandPriceEnv, calls: { tokensIn: number; tokensOut: number }[], searches: number): bigint {
  let usd12 = GAS_SHARE_USD12 + BigInt(searches) * searchFeeUsd12(env);
  for (const call of calls) usd12 += marked(env, call.tokensIn, call.tokensOut);
  return usd12ToYocto(env, usd12);
}

/** Charge only what the pet can pay; the rest of a completed usage price is project spend. */
export async function cutPrice(env: Env, fs: Pick<FoodState, 'room' | 'capLeft'>, usage: bigint): Promise<bigint> {
  let price = usage;
  if (price > fs.room) price = fs.room;
  if (price > fs.capLeft) price = fs.capLeft;
  if (price > MAX_THOUGHT_PRICE_YOCTO) price = MAX_THOUGHT_PRICE_YOCTO;
  if (usage > price) {
    await projectPays(env, 'edge', yoctoMicros(env, usage - price));
    console.log('thought_edge');
  }
  return price;
}

/** What a search call that was cut costs the project at most, in USD: the call at its bound plus one search fee, an
 * upper bound (ADR-026) — no `usage` ever came for it. */
export function cutBoundUsd(env: ErrandPriceEnv, ran: number): number {
  const input = SEARCH_IN[Math.min(Math.max(ran, 1), 3) - 1]!;
  return (Number(costUsd12(env, input, SEARCH_OUT_BOUND)) / 1e12) + Number(env.SEARCH_USD_PER_CALL);
}

/** The report's input in tokens when it holds results (and the data of a pet with sources). */
export function reportInput(hasData: boolean): number {
  return LAYER_TOKENS + RESULTS_TOKENS + (hasData ? DATA_TOKENS : 0);
}

/** `U(n)`: the «up to» of n searches. n = 1, 2: the search call at its bound, n searches, the report at its fuse
 * and the re-ask. n = 3: the fixed ceiling of the spec. */
export function upToFor(env: ErrandPriceEnv, n: 1 | 2 | 3, hasData = false): Priced {
  if (n === 3) return priced(env, THREE_SEARCHES_USD12);
  const input = reportInput(hasData);
  const usd12 =
    GAS_SHARE_USD12 +
    marked(env, SEARCH_IN[n - 1]!, SEARCH_OUT_BOUND) +
    BigInt(n) * searchFeeUsd12(env) +
    marked(env, input, REPORT_FUSE) +
    marked(env, input, REASK_FUSE);
  return priced(env, usd12);
}

/** The searches the pet may run: 3, or 2 with sources or code; the third falls away when ≈ 2.05¢ passes the
 * thought's limit at the rate (`Errand price data`: «below ≈ $4.10»). */
export function allowanceFor(env: ErrandPriceEnv, hasData: boolean): 1 | 2 | 3 {
  if (hasData) return 2;
  return upToFor(env, 3).yocto > MAX_THOUGHT_PRICE_YOCTO ? 2 : 3;
}

/** A typical «Read this»: 3,000 tokens of page, 700 out (§4: ≈ 0.19¢). */
export function typicalRead(env: PriceEnv): Priced {
  return priced(env, GAS_SHARE_USD12 + marked(env, LAYER_TOKENS + TYPICAL_PAGE_TOKENS, TYPICAL_REPORT_OUT));
}

/** The price of a read of `pageTokens`, typical output: the sheet's estimate by the pasted text's length. */
export function readFor(env: PriceEnv, pageTokens: number): Priced {
  return priced(env, GAS_SHARE_USD12 + marked(env, LAYER_TOKENS + pageTokens, TYPICAL_REPORT_OUT));
}

/** `{ base, perToken }` in yocto, so the client prices a pasted text with no request per keystroke: `base` the price
 * with no page, `perToken` what each token of page adds (rounded up, so the estimate is never below the server's). */
export function readCoefficients(env: PriceEnv): { base: string; perToken: string } {
  const base = readFor(env, 0);
  const per = priced(env, marked(env, 1_000_000, 0)).yocto;
  return { base: base.yocto.toString(), perToken: ((per + 999_999n) / 1_000_000n).toString() };
}

/** A full read with its worst report (8,000 tokens of page, the fuse and the re-ask): ≈ 0.50¢. */
export function fullRead(env: PriceEnv): Priced {
  const input = LAYER_TOKENS + READ_LIMIT_TOKENS;
  return priced(env, GAS_SHARE_USD12 + marked(env, input, REPORT_FUSE) + marked(env, input, REASK_FUSE));
}

/** §4's typical one-search errand: the search call at 8,900 in and 70 out, one search, the report at 4,000 in and
 * 700 out (≈ 0.85¢). */
export function typicalSearch(env: ErrandPriceEnv): Priced {
  return priced(
    env,
    GAS_SHARE_USD12 + marked(env, SEARCH_IN[0], SEARCH_OUT_TYPICAL) + searchFeeUsd12(env) + marked(env, reportInput(false), TYPICAL_REPORT_OUT),
  );
}

/** What a start needs (`Errand flow` › «can't pay»): a full read, or the typical one-search errand and one scale
 * thought (`STARTER_FOOD / 12`): ≈ 0.93¢. A scale thought is not a whole number of cents: the cents shown follow
 * the rate of NEAR for that part. */
export function need(env: ErrandPriceEnv, form: ErrandForm): Priced {
  if (form === 'read') return fullRead(env);
  const search = typicalSearch(env);
  const scale = STARTER_FOOD_YOCTO / 12n;
  return { usd12: search.usd12 + yoctoToUsd12(env, scale), yocto: search.yocto + scale };
}

/** What the sheet shows for a search form: `upTo = min(room, U(allowance))`, whether it is the whole (`full`), and the
 * searches the server lets run: the largest n ≤ allowance with `U(n) ≤ upTo`, at least 1. */
export function searchQuote(env: ErrandPriceEnv, room: bigint, hasData: boolean): { upTo: Priced; full: boolean; searches: 1 | 2 | 3; allowance: 1 | 2 | 3 } {
  const allowance = allowanceFor(env, hasData);
  const top = upToFor(env, allowance, hasData);
  const full = room >= top.yocto;
  const upTo: Priced = full ? top : { usd12: yoctoToUsd12(env, room), yocto: room };
  let searches: 1 | 2 | 3 = 1;
  for (const n of [2, 3] as const) if (n <= allowance && upToFor(env, n, hasData).yocto <= upTo.yocto) searches = n;
  return { upTo, full, searches, allowance };
}

/** yocto to usd12 at the rate of NEAR, rounded down (a price the food covers is never shown higher than it is). */
export function yoctoToUsd12(env: Pick<PriceEnv, 'NEAR_USD_RATE'>, yocto: bigint): bigint {
  const rate6 = BigInt(Math.round(Number(env.NEAR_USD_RATE) * 1_000_000));
  return (yocto * rate6) / 10n ** 18n;
}
