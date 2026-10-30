import { describe, expect, it } from 'vitest';
import { litCells } from './Fullness';

// A scale thought is STARTER_FOOD / 12; `level` is the food's share of the scale's 12 (server: min(1, eff / STARTER_FOOD)).
const level = (scaleThoughts: number) => Math.min(1, scaleThoughts / 12);

describe('Fullness cells', () => {
  // spec: add-pet › Pet condition rule › Голоден × scale cells at 1.5, 11 and 11.5 scale thoughts
  it('lights 1, 7 and 7 cells for «Hungry» at 1.5, 11 and 11.5 scale thoughts', () => {
    expect(litCells('hungry', level(1.5))).toBe(1);
    expect(litCells('hungry', level(11))).toBe(7);
    expect(litCells('hungry', level(11.5))).toBe(7);
  });

  // spec: add-pet › Pet condition rule › Голоден × scale cells at 1.5, 11 and 11.5 scale thoughts
  it('lights all 8 cells for «Full» at any level, and none for «Asleep»', () => {
    for (const l of [0, 0.5, level(11.6), level(12), 1]) expect(litCells('full', l)).toBe(8);
    expect(litCells('full', undefined)).toBe(8);
    expect(litCells('asleep', 0.9)).toBe(0);
  });

  // spec: add-pet › Pet condition rule › Голоден × scale cells at 1.5, 11 and 11.5 scale thoughts
  it('never shows a hungry pet with no cell or with all of them', () => {
    expect(litCells('hungry', 0)).toBe(1);
    expect(litCells('hungry', 1)).toBe(7);
  });
});
