import { expect, it } from 'vitest';
import { SAMPLE_SHOWCASE } from '../../seams/showcase.sample';
import { meadowNumbers, meadowPets } from './showcase';

// spec: add-account › Home screen › meadow numbers
it('formats contract counters with the singular, grouped thousands, one decimal and sub-1 significant digits', () => {
  expect(meadowNumbers(SAMPLE_SHOWCASE)).toEqual([
    { value: '1,204', label: 'pets hatched' },
    { value: '58,310', label: 'thoughts paid for' },
    { value: '41.2 NEAR', label: 'spent on thinking' },
    { value: '312', label: 'hires', since: undefined },
    { value: '87', label: 'friend snacks', since: undefined },
  ]);
  expect(meadowNumbers({ ...SAMPLE_SHOWCASE, numbers: { ...SAMPLE_SHOWCASE.numbers!, pets_hatched: 1, thoughts_paid: 1, spent: '420000000000000000000000' } })).toEqual([
    { value: '1', label: 'pet hatched' },
    { value: '1', label: 'thought paid for' },
    { value: '0.42 NEAR', label: 'spent on thinking' },
    { value: '312', label: 'hires', since: undefined },
    { value: '87', label: 'friend snacks', since: undefined },
  ]);
});

// spec: add-showcase › Home evidence flow › public totals
it('adds two public counters from the chain copy', () => {
  expect(meadowNumbers(SAMPLE_SHOWCASE)?.slice(3)).toEqual([
    { value: '312', label: 'hires', since: undefined },
    { value: '87', label: 'friend snacks', since: undefined },
  ]);
});

// spec: add-showcase › Home evidence flow › partial history
it('labels both new counters with the UTC upgrade day', () => {
  const numbers = meadowNumbers({ ...SAMPLE_SHOWCASE, numbers: { ...SAMPLE_SHOWCASE.numbers!, counted_since: Date.UTC(2026, 10, 5) * 1_000_000 } });
  expect(numbers?.slice(3)).toEqual([
    { value: '312', label: 'hires', since: 'since November 5' },
    { value: '87', label: 'friend snacks', since: 'since November 5' },
  ]);
});

// spec: add-showcase › Showcase totals rule › no new activity
it('keeps zeroes and their partial-history captions visible', () => {
  const numbers = meadowNumbers({ ...SAMPLE_SHOWCASE, numbers: { ...SAMPLE_SHOWCASE.numbers!, hires_completed: 0, friend_snacks: 0, counted_since: Date.UTC(2026, 10, 5) * 1_000_000 } });
  expect(numbers?.slice(3)).toEqual([
    { value: '0', label: 'hires', since: 'since November 5' },
    { value: '0', label: 'friend snacks', since: 'since November 5' },
  ]);
});

// spec: add-showcase › Home evidence flow › totals unavailable
it('does not present an absent copy as live', () => {
  expect(meadowNumbers({ ...SAMPLE_SHOWCASE, numbers: null })).toBeUndefined();
});

// spec: add-account › Home screen › meadow
it('uses the returned token, stage, condition and outfit and stops at ten pets', () => {
  const pets = meadowPets({ ...SAMPLE_SHOWCASE, pets: [...SAMPLE_SHOWCASE.pets, ...SAMPLE_SHOWCASE.pets] });
  expect(pets).toHaveLength(10);
  expect(pets[1]).toMatchObject({ seed: 49, stage: 'adult', state: 'full', outfit: 'party-hat', href: '/pet/49' });
  expect(pets[2]).toMatchObject({ seed: 47, stage: 'teen', state: 'asleep', tag: 'Lumen · asleep — out of food' });
  expect(pets.filter((pet) => pet.wide)).toHaveLength(5);
});

// spec: add-account › Home screen › meadow unavailable
it('leaves out numbers when there are no hatched pets', () => {
  expect(meadowNumbers({ pets: [], numbers: SAMPLE_SHOWCASE.numbers })).toBeUndefined();
});
