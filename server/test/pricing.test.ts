import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { PET_FEED_TGAS } from '../src/chain';
import {
  BIRTH_STORAGE_YOCTO,
  FEED_GAS_YOCTO,
  FEED_PORTIONS,
  fullness,
  GAS_TOPUP_YOCTO,
  HIRE_AUTO_LIMIT_YOCTO,
  HIRE_FEE_MAX_YOCTO,
  HIRE_FEE_MIN_YOCTO,
  HIRE_FEE_STEP_YOCTO,
  hireCents,
  MAX_BIRTH_COST_YOCTO,
  MAX_JOBS_PER_DAY,
  nearUsdRate,
  OUTFIT_PRICE_YOCTO,
  outfitCents,
  OWNER_SNACK_EVERY_MS,
  PET_FRIEND_SNACKS_PER_DAY,
  portionCents,
  SNACK_YOCTO,
  STARTER_FOOD_YOCTO,
  workerPrice,
  yoctoToUsdMicros,
} from '../src/pricing';

const S = STARTER_FOOD_YOCTO;

describe('the numbers the Worker shares with the contract', () => {
  // spec: add-pet › Pet food data › курс сменился
  it('has the starter food and the birth cost pre-check of contract/src/limits.rs', () => {
    expect(S).toBe(BigInt(env.STARTER_FOOD));
    expect(MAX_BIRTH_COST_YOCTO).toBe(BigInt(env.MAX_BIRTH_COST));
    // the longest birth: 1,893 bytes of storage and the starter food stay under the pre-check
    expect(BIRTH_STORAGE_YOCTO + S).toBeLessThanOrEqual(MAX_BIRTH_COST_YOCTO);
  });

  // spec: add-wardrobe › Outfit purchase contract › вещь куплена × the price in the Worker
  it('has the price of an outfit of the contract, and shows it as «0.76¢» at $4.59', () => {
    expect(OUTFIT_PRICE_YOCTO).toBe(BigInt(env.OUTFIT_PRICE));
    expect(outfitCents(4.59)).toBe(0.76);
    // two significant digits, whatever the rate: $2 and $10 a NEAR
    expect(outfitCents(2)).toBe(0.33);
    expect(outfitCents(10)).toBe(1.7);
  });

  // spec: add-feeding › Pet feed contract › меньше минимума
  it('has the smallest portion, the snack and the gas of a portion of the contract', () => {
    expect(FEED_PORTIONS[0].yocto).toBe(BigInt(env.MIN_FEED));
    expect(SNACK_YOCTO).toBe(BigInt(env.SNACK_AMOUNT));
    // 5 Tgas prepaid and 1 Tgas of fees at 0.001 NEAR a Tgas (the user, 2026-10-31)
    expect(FEED_GAS_YOCTO).toBe((PET_FEED_TGAS + 1n) * 10n ** 21n);
    expect(GAS_TOPUP_YOCTO).toBe(6n * 10n ** 21n);
    expect(FEED_PORTIONS.map((p) => p.near)).toEqual(['0.01', '0.05', '0.2']);
    expect(FEED_PORTIONS.map((p) => p.yocto)).toEqual([10n ** 22n, 5n * 10n ** 22n, 2n * 10n ** 23n]);
    // the longest birth, the longest feed and the cap of a snack's day stay what the contract says
    expect(BigInt(env.OWNER_SNACK_EVERY_NS)).toBe(OWNER_SNACK_EVERY_MS * 1_000_000n);
    expect(Number(env.FRIEND_SNACKS_PER_DAY)).toBe(PET_FRIEND_SNACKS_PER_DAY);
  });
});

describe('the price of a portion', () => {
  // spec: add-feeding › Feed sheet screen › success (владелец)
  it('is whole cents at the rate: 5, 23 and 92 at $4.59', () => {
    expect(FEED_PORTIONS.map((p) => portionCents(p.yocto, 4.59))).toEqual([5, 23, 92]);
    // rounded to the nearest: 0.01 x 3.5 = 3.5 cents, 0.01 x 3.49 = 3.49
    expect(portionCents(FEED_PORTIONS[0].yocto, 3.5)).toBe(4);
    expect(portionCents(FEED_PORTIONS[0].yocto, 3.49)).toBe(3);
  });
});

describe('fullness', () => {
  // spec: add-pet › Pet condition rule › Голоден
  it('is «Full» above 11.5 scale thoughts and «Hungry» at 11.5 or less', () => {
    const edge = (23n * S) / 24n; // ⌊23·S/24⌋: not above 11.5
    expect(fullness(edge).state).toBe('hungry');
    expect(fullness(edge + 1n).state).toBe('full');
    expect(fullness(S).state).toBe('full');
  });

  // spec: add-pet › Pet condition rule › Голоден
  it('is «Asleep» below one scale thought and «Hungry» from it', () => {
    const one = (S + 11n) / 12n; // ⌈S/12⌉
    expect(fullness(one).state).toBe('hungry');
    expect(fullness(one - 1n).state).toBe('asleep');
    expect(fullness(0n).state).toBe('asleep');
    expect(fullness(-5n).state).toBe('asleep'); // never below nothing
  });

  // spec: add-pet › Pet condition rule › Голоден
  it('has a level of food over the starter food, at most 1', () => {
    expect(fullness(S).level).toBe(1);
    expect(fullness(13n * (S / 12n)).level).toBe(1);
    expect(fullness(12n * (S / 12n) + 5n * S).level).toBe(1);
    expect(fullness(S / 2n).level).toBe(0.5);
    // 1.5 scale thoughts (the frame «pet-hungry») and 11 (the newborn after the greeting)
    expect(fullness((S * 3n) / 24n)).toEqual({ state: 'hungry', level: 0.125 });
    expect(fullness((S * 11n) / 12n).level).toBeCloseTo(11 / 12, 6);
    expect(Math.floor(fullness((S * 11n) / 12n).level * 8)).toBe(7);
  });

});

describe('the project\'s own costs in dollars', () => {
  // spec: add-pet › Birth flow › вылупился
  it('turns yoctoNEAR into micro-dollars at the rate, rounded up', () => {
    expect(yoctoToUsdMicros(S, 4.59)).toBe(9_180);
    expect(yoctoToUsdMicros(BIRTH_STORAGE_YOCTO, 4.59)).toBe(90_240);
    expect(yoctoToUsdMicros(1n, 4.59)).toBe(1);
    expect(yoctoToUsdMicros(0n, 4.59)).toBe(0);
  });

  // spec: add-pet › Birth flow › вылупился
  it('reads the rate of the var, and nothing for an empty or a bad one', () => {
    expect(nearUsdRate('4.59')).toBe(4.59);
    expect(nearUsdRate('')).toBeNull();
    expect(nearUsdRate('abc')).toBeNull();
    expect(nearUsdRate('0')).toBeNull();
  });
});

describe('the price of a worker', () => {
  // spec: add-pet-work › Hire price rule › price climbs
  it('holds the band of the contract: the floor, a step of 0.0004 NEAR an answer, the highest at the tenth, the Auto limit at the third', () => {
    expect(HIRE_FEE_MIN_YOCTO).toBe(BigInt(env.HIRE_FEE_MIN));
    expect(HIRE_FEE_MAX_YOCTO).toBe(BigInt(env.HIRE_FEE_MAX));
    expect(MAX_JOBS_PER_DAY).toBe(Number(env.MAX_JOBS_PER_DAY));
    // without a skill: the floor at every count; with one: floor + a step each, the tenth hire (count 9) at the highest
    for (let count = 0; count < MAX_JOBS_PER_DAY; count += 1) expect(workerPrice(false, count)).toBe(HIRE_FEE_MIN_YOCTO);
    expect(workerPrice(true, 0)).toBe(HIRE_FEE_MIN_YOCTO);
    expect(workerPrice(true, 1)).toBe(HIRE_FEE_MIN_YOCTO + HIRE_FEE_STEP_YOCTO);
    expect(workerPrice(true, 2)).toBe(HIRE_AUTO_LIMIT_YOCTO);
    expect(workerPrice(true, MAX_JOBS_PER_DAY - 1)).toBe(HIRE_FEE_MAX_YOCTO);
    expect(HIRE_FEE_MIN_YOCTO + 9n * HIRE_FEE_STEP_YOCTO).toBe(HIRE_FEE_MAX_YOCTO);
    // a count past the day's limit never goes above the band
    expect(workerPrice(true, 40)).toBe(HIRE_FEE_MAX_YOCTO);
  });

  // spec: add-pet-work › Hire price rule › price climbs
  it('shows the price in cents with two significant digits: 0.38 at the floor, 0.75 at the Auto limit, 2 at the highest ($4.59)', () => {
    expect(hireCents(HIRE_FEE_MIN_YOCTO, 4.59)).toBe(0.38);
    expect(hireCents(HIRE_FEE_STEP_YOCTO, 4.59)).toBe(0.18);
    expect(hireCents(HIRE_AUTO_LIMIT_YOCTO, 4.59)).toBe(0.75);
    expect(hireCents(HIRE_FEE_MAX_YOCTO, 4.59)).toBe(2);
    expect(hireCents(HIRE_FEE_MIN_YOCTO, 10)).toBe(0.83);
  });
});
