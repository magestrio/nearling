import { describe, expect, it } from 'vitest';
import { chooseTrait, energyLeft, growthLine, moodOf, TRAIT_WORD } from '../src/pet/life';

const none = { riddles: 0, friends: 0, works: 0, deeps: 0 };

describe('Trait rule', () => {
  // spec: add-pet-life › Trait rule › ничья
  it('takes the first of the tied deeds in the order clever, sociable, hard-working, thoughtful', () => {
    expect(chooseTrait({ riddles: 2, friends: 2, works: 2, deeps: 2 })).toBe('clever');
    expect(chooseTrait({ ...none, friends: 3, works: 3, deeps: 3 })).toBe('sociable');
    expect(chooseTrait({ ...none, works: 1, deeps: 1 })).toBe('hard_working');
    expect(chooseTrait({ riddles: 1, friends: 0, works: 0, deeps: 2 })).toBe('thoughtful');
    // a tie below the top does not matter
    expect(chooseTrait({ riddles: 1, friends: 1, works: 0, deeps: 5 })).toBe('thoughtful');
  });

  // spec: add-pet-life › Trait rule › дел не было
  it('gives cozy to a window with no deed at all', () => {
    expect(chooseTrait(none)).toBe('cozy');
  });

  // spec: add-pet-life › Trait rule › черта по делам
  it('gives the trait of the deed that was more frequent than the rest', () => {
    expect(chooseTrait({ riddles: 1, friends: 0, works: 4, deeps: 3 })).toBe('hard_working');
    expect(chooseTrait({ riddles: 0, friends: 0, works: 0, deeps: 1 })).toBe('thoughtful');
  });

  // spec: add-pet-life › Trait rule › черта по делам
  it('spells the traits as the transition line and the contract do', () => {
    expect(TRAIT_WORD).toEqual({ clever: 'clever', sociable: 'sociable', hard_working: 'hard-working', thoughtful: 'thoughtful', cozy: 'cozy' });
  });
});

describe('Growth flow', () => {
  // spec: add-pet-life › Growth flow › стал подростком
  it('says the teen line verbatim', () => {
    expect(growthLine('teen', 'Pixel', 'clever', false)).toBe('Pixel is a teen now — and turned out clever!');
    expect(growthLine('teen', 'Pixel', 'hard_working', false)).toBe('Pixel is a teen now — and turned out hard-working!');
  });

  // spec: add-pet-life › Growth flow › стал взрослым
  it('says the adult line verbatim for a new trait', () => {
    expect(growthLine('adult', 'Pixel', 'sociable', false)).toBe('Pixel is all grown up — and has become sociable too!');
  });

  // spec: add-pet-life › Trait rule › черта уже есть
  it('says the strengthened line verbatim for a repeated trait', () => {
    expect(growthLine('adult', 'Pixel', 'clever', true)).toBe('Pixel is all grown up — and even more clever!');
  });
});

describe('Mood rule', () => {
  const TODAY = 20_000;

  // spec: add-pet-life › Mood rule › радостный
  it('is happy for a full pet with an event today', () => {
    expect(moodOf('full', TODAY, TODAY)).toBe('happy');
  });

  // spec: add-pet-life › Mood rule › новые сутки
  it('is calm for a full pet whose last event was yesterday or never', () => {
    expect(moodOf('full', TODAY - 1, TODAY)).toBe('calm');
    expect(moodOf('full', null, TODAY)).toBe('calm');
    // the same row, one tick of 00:00 UTC later
    expect(moodOf('full', TODAY, TODAY + 1)).toBe('calm');
  });

  // spec: add-pet-life › Mood rule › сонный
  it('is sleepy while hungry, over the events of the day', () => {
    expect(moodOf('hungry', TODAY, TODAY)).toBe('sleepy');
    expect(moodOf('hungry', null, TODAY)).toBe('sleepy');
  });

  // spec: add-pet-life › Mood rule › после отсутствия
  it('is never a sad mood: three moods only, none for a sleeping pet', () => {
    expect(moodOf('asleep', TODAY, TODAY)).toBeNull();
    const seen = new Set([moodOf('full', 1, TODAY), moodOf('full', TODAY, TODAY), moodOf('hungry', 1, TODAY)]);
    expect([...seen].sort()).toEqual(['calm', 'happy', 'sleepy']);
  });
});

describe('Energy rule', () => {
  const TODAY = 20_000;

  // spec: add-pet-life › Energy rule › энергия на нуле
  it('is full with no row, full on another day than the steps were spent, and counts down in a day', () => {
    expect(energyLeft(null, TODAY)).toBe(10);
    expect(energyLeft({ energyDay: TODAY - 1, energyUsed: 10 }, TODAY)).toBe(10);
    expect(energyLeft({ energyDay: TODAY, energyUsed: 3 }, TODAY)).toBe(7);
    expect(energyLeft({ energyDay: TODAY, energyUsed: 10 }, TODAY)).toBe(0);
    // 00:00 UTC refills it with no write
    expect(energyLeft({ energyDay: TODAY, energyUsed: 10 }, TODAY + 1)).toBe(10);
  });
});
