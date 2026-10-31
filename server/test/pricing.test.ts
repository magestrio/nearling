import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { PET_FEED_TGAS } from '../src/chain';
import {
  BIRTH_STORAGE_YOCTO,
  FEED_GAS_YOCTO,
  FEED_PORTIONS,
  fullness,
  GAS_TOPUP_YOCTO,
  MAX_BIRTH_COST_YOCTO,
  nearUsdRate,
  OWNER_SNACK_EVERY_MS,
  PET_FRIEND_SNACKS_PER_DAY,
  portionCents,
  SNACK_YOCTO,
  STARTER_FOOD_YOCTO,
  yoctoToUsdMicros,
} from '../src/pricing';

const S = STARTER_FOOD_YOCTO;

describe('the numbers the Worker shares with the contract', () => {
  // spec: add-pet › Pet food data › курс сменился
  it('has the starter food and the birth cost pre-check of contract/src/limits.rs', () => {
    expect(S).toBe(BigInt(env.STARTER_FOOD));
    expect(MAX_BIRTH_COST_YOCTO).toBe(BigInt(env.MAX_BIRTH_COST));
    // the longest birth: 1,873 bytes of storage and the starter food stay under the pre-check
    expect(BIRTH_STORAGE_YOCTO + S).toBeLessThanOrEqual(MAX_BIRTH_COST_YOCTO);
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
    expect(yoctoToUsdMicros(BIRTH_STORAGE_YOCTO, 4.59)).toBe(85_971);
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
