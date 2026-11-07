// Money of the pet: the starter food, the fullness scale, the project's own costs in USD.
// The thought's price (usage, the ceiling, the reserve) is added here by the thought stage.
import { PET_FEED_FEES_TGAS, PET_FEED_TGAS } from './chain';

/** The starter food of a newborn: 12 typical thoughts, 0.0020 NEAR. The same number as
 * `STARTER_FOOD` in `contract/src/limits.rs`; `server/vitest.config.ts` hands that file's value
 * to the tests, which compare (`test/pricing.test.ts`). */
export const STARTER_FOOD_YOCTO = 2_000_000_000_000_000_000_000n;

/** The storage a birth locks, in yoctoNEAR: 1,966 bytes x 1e19, measured by
 * `contract/tests/pet_mint.rs`: 1,463 birth bytes, 430 next-owner bytes and 73 generation bytes. */
export const BIRTH_STORAGE_YOCTO = 19_660_000_000_000_000_000_000n;

/** A pre-check of the pool before a birth: `MAX_BIRTH_COST` of `contract/src/limits.rs`. */
export const MAX_BIRTH_COST_YOCTO = 23_000_000_000_000_000_000_000n;

export const YOCTO_PER_NEAR = 1_000_000_000_000_000_000_000_000n;

// ---------------------------------------------------------------------------------------------
// Feeding (`add-feeding`): the three portions, the snack, the gas of a portion.

/** What one snack puts into a pet's project food, from the pool: `SNACK_AMOUNT` of
 * `contract/src/limits.rs` (0.0017 NEAR). `server/vitest.config.ts` hands the contract's value to
 * `test/pricing.test.ts`, which compares. */
export const SNACK_YOCTO = 1_700_000_000_000_000_000_000n;

/** The owner's snack comes once in 72 hours (`OWNER_SNACK_EVERY_NS` of the contract), in milliseconds. */
export const OWNER_SNACK_EVERY_MS = 259_200_000n;

/** Snacks from friends one pet takes in a UTC day (`FRIEND_SNACKS_PER_DAY` of the contract). */
export const PET_FRIEND_SNACKS_PER_DAY = 3;

/** Different pets one friend gives snacks to in a UTC day (`Snack rule`; the server's rule, §8 ›
 * Перекусы друзей: the contract does not see it). */
export const FRIEND_SNACK_PETS_PER_DAY = 3;

/** What an acquaintance's record costs the pool: `KNOWN_RECORD_BYTES` (72, `contract/src/limits.rs`) x 1e19. */
export const KNOWN_RECORD_YOCTO = 720_000_000_000_000_000_000n;

/** The most gas a portion may prepay, Tgas: the browser's and the server's check both refuse a larger
 * buy, since it would need more balance than the sheet promised (`design.md` › Решения). */
export const MAX_FEED_GAS_TGAS = 30n;

/** The portions the sheet offers (OD-211): 0.01 / 0.05 / 0.2 NEAR. The smallest is `MIN_FEED` of
 * `contract/src/limits.rs`, the least `pet_feed` takes. `near` is the text the sheet and the browser's
 * check use. */
export const FEED_PORTIONS = [
  { near: '0.01', yocto: 10_000_000_000_000_000_000_000n },
  { near: '0.05', yocto: 50_000_000_000_000_000_000_000n },
  { near: '0.2', yocto: 200_000_000_000_000_000_000_000n },
] as const;
export type PortionNear = (typeof FEED_PORTIONS)[number]['near'];

/** What a wallet must hold for the gas of a portion, yoctoNEAR: the prepaid gas and the receipt's fees,
 * (`PET_FEED_TGAS` 5 + `PET_FEED_FEES_TGAS` 1) x 0.001 NEAR per Tgas, 0.006 NEAR (the user, 2026-10-31).
 * The protocol buys both up front; `contract/tests/feed.rs` feeds from a wallet of exactly this. */
export const FEED_GAS_YOCTO = (PET_FEED_TGAS + PET_FEED_FEES_TGAS) * 1_000_000_000_000_000_000_000n;

/** What the project puts into a wallet that has a portion but no gas for it, once per player (ADR-006). */
export const GAS_TOPUP_YOCTO = FEED_GAS_YOCTO;

/** A portion's price in whole US cents at `rate` USD per NEAR, rounded to the nearest (the frames'
 * 5 / 23 / 92 at $4.59). The rate of NEAR moves only this (§4). */
export function portionCents(yocto: bigint, rate: number): number {
  const rate6 = BigInt(Math.round(rate * 1_000_000));
  const denom = YOCTO_PER_NEAR * 1_000_000n;
  return Number((yocto * rate6 * 100n + denom / 2n) / denom);
}

// ---------------------------------------------------------------------------------------------
// The wardrobe (`add-wardrobe`).

/** What a bought outfit costs, taken from the pet's food: `OUTFIT_PRICE` of `contract/src/limits.rs`
 * (0.00166 NEAR, `Outfit purchase contract`). `server/vitest.config.ts` hands the contract's value to
 * `test/pricing.test.ts`, which compares. */
export const OUTFIT_PRICE_YOCTO = 1_660_000_000_000_000_000_000n;

/** The price of an outfit in cents at `rate` USD per NEAR, two significant digits (the frames'
 * «0.76¢» at $4.59), as the «Think hard» estimate is shown. The rate of NEAR moves only this. */
export function outfitCents(rate: number): number {
  return Number(((Number(OUTFIT_PRICE_YOCTO) * rate) / 1e22).toPrecision(2));
}

// ---------------------------------------------------------------------------------------------
// The price of a worker (`add-pet-work` › `Hire price rule`, `Hire quote data`, ADR-011 › «A band»).

/** The undiscounted base price, 0.00083 NEAR (≈ 0.38¢): the price of a pet without a skill,
 * and the first answer of a day of a pet with one. The contract's accepted `HIRE_FEE_MIN` is
 * separately 0.00074 NEAR so a liked pair can pay 10% less than this base price. */
export const HIRE_FEE_MIN_YOCTO = 830_000_000_000_000_000_000n;

/** What each answer of its UTC day adds to the price of a pet with a skill, 0.0004 NEAR (≈ 0.18¢). The
 * contract has only the band, so this number is the Worker's alone. */
export const HIRE_FEE_STEP_YOCTO = 400_000_000_000_000_000_000n;

/** The highest fee, 0.00443 NEAR (≈ 2¢): a skilled worker's tenth hire of a day, floor + 9 steps.
 * `HIRE_FEE_MAX` of `contract/src/limits.rs`. */
export const HIRE_FEE_MAX_YOCTO = 4_430_000_000_000_000_000_000n;

/** The most a pet pays in Auto, 0.00163 NEAR (≈ 0.75¢): the price of the third answer of a day (floor +
 * 2 steps). Above it Auto does not hire, Manual offers (`Hire eligibility rule` › «over the Auto limit»). */
export const HIRE_AUTO_LIMIT_YOCTO = 1_630_000_000_000_000_000_000n;

/** The answers a pet gives other pets in a UTC day: `MAX_JOBS_PER_DAY` of `contract/src/limits.rs`. At this
 * count, the answers of the day plus the places held, a pet is no worker (`Hire eligibility rule`). */
export const MAX_JOBS_PER_DAY = 10;

/** A worker's price when `count` answers of its UTC day, with the places held, came before: without a
 * skill always the floor; with one the floor plus a step each, never above the highest fee. */
export function workerPrice(skilled: boolean, count: number): bigint {
  if (!skilled) return HIRE_FEE_MIN_YOCTO;
  const price = HIRE_FEE_MIN_YOCTO + HIRE_FEE_STEP_YOCTO * BigInt(count);
  return price > HIRE_FEE_MAX_YOCTO ? HIRE_FEE_MAX_YOCTO : price;
}

/** A worker's price in cents at `rate` USD per NEAR, two significant digits (the frames' «0.38¢» at $4.59),
 * as `outfitCents` and the «Think hard» estimate are shown. The rate of NEAR moves only this. */
export function hireCents(yocto: bigint, rate: number): number {
  return Number(((Number(yocto) * rate) / 1e22).toPrecision(2));
}

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
export const GAS_SHARE_USD12 = 600_000_000n;

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
export function marked(env: PriceEnv, tokensIn: number, tokensOut: number): bigint {
  return ceilDiv(tokensUsd12(env, tokensIn, tokensOut) * MARKUP_NUM, MARKUP_DEN);
}

/** usd12 to yoctoNEAR at `NEAR_USD_RATE`, rounded up. An empty rate is a config error. */
export function usd12ToYocto(env: PriceEnv, usd12: bigint): bigint {
  const rate = nearUsdRate(env.NEAR_USD_RATE);
  if (rate === null) throw new Error('rate_missing');
  const rate6 = BigInt(Math.round(rate * 1_000_000));
  return ceilDiv(usd12 * 10n ** 18n, rate6);
}

/** What tokens cost the project before the markup and the gas share, in usd12 (the `cost_usd` of an event). */
export function costUsd12(env: PriceEnv, tokensIn: number, tokensOut: number): bigint {
  return tokensUsd12(env, tokensIn, tokensOut);
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
