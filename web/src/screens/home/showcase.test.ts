import { expect, it } from 'vitest';
import { SAMPLE_SHOWCASE } from '../../seams/showcase.sample';
import { meadowNumbers, meadowPets } from './showcase';

// spec: add-account › Home screen › meadow numbers
it('formats contract counters with the singular, grouped thousands, one decimal and sub-1 significant digits', () => {
  expect(meadowNumbers(SAMPLE_SHOWCASE)).toEqual([
    { value: '1,204', label: 'pets hatched' },
    { value: '58,310', label: 'thoughts paid for' },
    { value: '41.2 NEAR', label: 'spent on thinking' },
  ]);
  expect(meadowNumbers({ ...SAMPLE_SHOWCASE, numbers: { pets_hatched: 1, thoughts_paid: 1, spent: '420000000000000000000000' } })).toEqual([
    { value: '1', label: 'pet hatched' },
    { value: '1', label: 'thought paid for' },
    { value: '0.42 NEAR', label: 'spent on thinking' },
  ]);
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
