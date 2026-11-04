import { describe, expect, it } from 'vitest';
import { boardMatches } from './board';
import type { HireBoard } from '../seams/worker-types';

const pet = (name: string, label: string): HireBoard['pets'][number] => ({
  tokenId: name, opaqueId: name, name, label, price: { cents: 0.38, yocto: '380000000000000000000' },
  status: 'available', yours: false,
});

describe('Hire board label search', () => {
  // spec: add-pet-work › Hire board flow › label searched
  // spec: add-pet-work › Hire board screen › success × Search skills
  it('uses a case-insensitive substring of checked labels, never name or status', () => {
    const pets = [pet('Nori', 'copywriting'), pet('Biscuit', 'storytelling'), pet('Garden', 'puzzles')];
    expect(boardMatches(pets, 'WRIT')).toEqual([pets[0]]);
    expect(boardMatches(pets, 'Garden')).toEqual([]);
    expect(boardMatches(pets, '')).toEqual(pets);
  });

  // spec: add-pet-work › Hire board flow › label searched × edit
  it('follows each edit of the query: narrowing, widening and clearing give the matching cards again', () => {
    const pets = [pet('Nori', 'copywriting'), pet('Biscuit', 'storytelling')];
    expect(boardMatches(pets, 'st')).toEqual([pets[1]]);
    expect(boardMatches(pets, 't')).toEqual(pets);
    expect(boardMatches(pets, 'stx')).toEqual([]);
    expect(boardMatches(pets, '')).toEqual(pets);
  });
});
