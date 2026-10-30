// Money of the pet: the starter food, the fullness scale, the project's own costs in USD.
// The thought's price (usage, the ceiling, the reserve) is added here by the thought stage.

/** The starter food of a newborn: 12 typical thoughts, 0.0020 NEAR. The same number as
 * `STARTER_FOOD` in `contract/src/limits.rs`; `server/vitest.config.ts` hands that file's value
 * to the tests, which compare (`test/pricing.test.ts`). */
export const STARTER_FOOD_YOCTO = 2_000_000_000_000_000_000_000n;

/** The storage a birth locks, in yoctoNEAR, at its upper bound: 1,856 bytes x 1e19
 * (design.md › Контракт › Хранилище, measured by `contract/tests/pet_mint.rs`). */
export const BIRTH_STORAGE_YOCTO = 18_560_000_000_000_000_000_000n;

/** A pre-check of the pool before a birth: `MAX_BIRTH_COST` of `contract/src/limits.rs`. */
export const MAX_BIRTH_COST_YOCTO = 22_000_000_000_000_000_000_000n;

export const YOCTO_PER_NEAR = 1_000_000_000_000_000_000_000_000n;

export type FullnessState = 'full' | 'hungry' | 'asleep';
export interface Fullness {
  state: FullnessState;
  /** food / starter food, at most 1; the client draws cells from it (DS Fullness). */
  level: number;
}

/** The pet's state from its food in yoctoNEAR (`Pet condition rule`, `Pet food data`). The scale
 * is in scale thoughts, STARTER_FOOD / 12 each: «Full» is more than 11.5, «Asleep» is less than
 * one, and the rate of NEAR does not enter. A scale thought is not a whole number of yocto, so the
 * comparisons are products, not quotients. */
export function fullness(food: bigint, starter: bigint = STARTER_FOOD_YOCTO): Fullness {
  const eff = food < 0n ? 0n : food;
  let state: FullnessState = 'hungry';
  if (24n * eff > 23n * starter) state = 'full';
  else if (12n * eff < starter) state = 'asleep';
  const level = eff >= starter ? 1 : Number((eff * 1_000_000_000n) / starter) / 1e9;
  return { state, level };
}

/** NEAR_USD_RATE as a number, or null when the var is empty or not a positive number. */
export function nearUsdRate(raw: string): number | null {
  const rate = Number(raw);
  return Number.isFinite(rate) && rate > 0 ? rate : null;
}

/** yoctoNEAR to USD micro-dollars at `rate` USD per NEAR, rounded up. */
export function yoctoToUsdMicros(yocto: bigint, rate: number): number {
  // rate in micro-USD per NEAR as an integer, so that the product stays in bigint.
  const rateMicros = BigInt(Math.round(rate * 1_000_000));
  const product = yocto * rateMicros;
  return Number((product + YOCTO_PER_NEAR - 1n) / YOCTO_PER_NEAR);
}

// ---------------------------------------------------------------------------------------------
// The price of a thought (PRODUCT.md §4, ADR-004 › «Paid by usage»): by what the call used.
// Money is computed in "usd12" = 1e-12 USD, an integer: a token at P USD per million tokens costs
// P x 1e6 usd12 (so the rates stay exact), and the result goes to yocto by the rate of NEAR, up.

/** The per-thought cap and the daily cap of the contract (`contract/src/limits.rs`). */
export const MAX_THOUGHT_PRICE_YOCTO = 5_000_000_000_000_000_000_000n;
export const DAILY_CAP_YOCTO = 50_000_000_000_000_000_000_000n;
/** The fuses of one call: an ordinary thought, the re-ask, and «Think hard» (§4 › Предохранители). */
export const FUSE_CHAT = 2_000;
export const FUSE_DEEP = 3_000;
/** The ceiling of the call at the edge of sleep (`Thought request data`). */
export const EDGE_CEILING = 40;
/** A typical thought: 2,300 tokens in, 30 out; «Think hard»: 300 out (§4). */
export const TYPICAL_IN = 2_300;
export const TYPICAL_OUT = 30;
export const TYPICAL_DEEP_OUT = 300;
const MARKUP_NUM = 12n;
const MARKUP_DEN = 10n;
/** The share of gas in the price of a thought: $0.0006, fixed in USD (§4). */
const GAS_SHARE_USD12 = 600_000_000n;

export interface PriceEnv {
  PRICE_IN_USD_PER_MTOK: string;
  PRICE_OUT_USD_PER_MTOK: string;
  NEAR_USD_RATE: string;
}

/** USD per million tokens as an integer of usd12 per token. */
function perToken(rate: string): bigint {
  return BigInt(Math.round(Number(rate) * 1_000_000));
}

/** What a call costs in usd12 before the markup: the tokens it used. */
function tokensUsd12(env: PriceEnv, tokensIn: number, tokensOut: number): bigint {
  return BigInt(tokensIn) * perToken(env.PRICE_IN_USD_PER_MTOK) + BigInt(tokensOut) * perToken(env.PRICE_OUT_USD_PER_MTOK);
}

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

/** The price of one call in usd12 with the markup, without the gas share. */
function marked(env: PriceEnv, tokensIn: number, tokensOut: number): bigint {
  return ceilDiv(tokensUsd12(env, tokensIn, tokensOut) * MARKUP_NUM, MARKUP_DEN);
}

/** usd12 to yoctoNEAR at `NEAR_USD_RATE`, rounded up. An empty rate is a config error. */
export function usd12ToYocto(env: PriceEnv, usd12: bigint): bigint {
  const rate = nearUsdRate(env.NEAR_USD_RATE);
  if (rate === null) throw new Error('rate_missing');
  const rate6 = BigInt(Math.round(rate * 1_000_000));
  return ceilDiv(usd12 * 10n ** 18n, rate6);
}

/** The price of a thought of `calls` calls (usage of each), with the gas share once. */
export function thoughtPrice(env: PriceEnv, calls: { tokensIn: number; tokensOut: number }[]): bigint {
  let usd12 = GAS_SHARE_USD12;
  for (const call of calls) usd12 += marked(env, call.tokensIn, call.tokensOut);
  return usd12ToYocto(env, usd12);
}

/** The price of a call at a ceiling: every input byte counted as a token, the whole ceiling used. */
export function ceilingPrice(env: PriceEnv, inputBound: number, ceiling: number, gasShare = true): bigint {
  return usd12ToYocto(env, (gasShare ? GAS_SHARE_USD12 : 0n) + marked(env, inputBound, ceiling));
}

/** The cheapest call there is: this input and a ceiling of 40 output tokens, with the gas share. */
export function minCallPrice(env: PriceEnv, inputBound: number): bigint {
  return ceilingPrice(env, inputBound, EDGE_CEILING);
}

/** The price of a typical thought (2,300 in, 30 out) and the approximate price of «Think hard». */
export function typicalPrice(env: PriceEnv): bigint {
  return thoughtPrice(env, [{ tokensIn: TYPICAL_IN, tokensOut: TYPICAL_OUT }]);
}

/** The largest `max_tokens` whose price at this input fits `budget` (yocto), at most `fuse`; 0 when
 * even one token does not fit. Binary search: the price grows with the ceiling. */
export function ceilingFor(env: PriceEnv, inputBound: number, budget: bigint, fuse: number, gasShare = true): number {
  let lo = 0;
  let hi = fuse;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ceilingPrice(env, inputBound, mid, gasShare) <= budget) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** «Think hard · ≈ {price}»: the last input of the pet (2,300 for a new one) at 300 out, in
 * yocto; the client shows cents with two significant digits. */
export function deepEstimate(env: PriceEnv, lastPromptTokens: number | null): bigint {
  return thoughtPrice(env, [{ tokensIn: lastPromptTokens ?? TYPICAL_IN, tokensOut: TYPICAL_DEEP_OUT }]);
}

/** Yocto to USD micro-dollars for the project's spend, rounded up; 0 when the rate is missing. */
export function usd12ToMicros(usd12: bigint): number {
  return Number(ceilDiv(usd12, 1_000_000n));
}

/** What a call costs the project in usd12 when nobody pays it (no signature, an empty answer). */
export function callUsd12(env: PriceEnv, tokensIn: number, tokensOut: number): bigint {
  return marked(env, tokensIn, tokensOut) + GAS_SHARE_USD12;
}

/** «Think hard» estimate in usd12 (the cents of the owner's view are USD, whatever the rate). */
export function deepEstimateUsd12(env: PriceEnv, lastPromptTokens: number | null): bigint {
  return callUsd12(env, lastPromptTokens ?? TYPICAL_IN, TYPICAL_DEEP_OUT);
}

/** The gas share of one thought in yocto (a fixed $0.0006 at the current rate). */
export function gasShareYocto(env: PriceEnv): bigint {
  return usd12ToYocto(env, GAS_SHARE_USD12);
}
