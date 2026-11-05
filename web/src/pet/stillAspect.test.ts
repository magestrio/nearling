import { describe, expect, it } from 'vitest';
import { heroAspect } from './stillAspect';

// width / height of `design/pet/<seed>-adult-full-three-quarter.png`, as the frames draw them
const STILLS: Array<[string, number]> = [
  ['9', 1192 / 1423],
  ['2', 1884 / 1361],
  ['0', 1946 / 1080],
  ['1', 1729 / 1515],
];

describe('the proportion of a hero pet\'s box', () => {
  // spec: add-pet › Pet screen › success (гость)
  it('follows the proportion of the pet\'s still: a wide pet is wide, a tall one is tall', () => {
    for (const [seed, still] of STILLS) {
      const aspect = heroAspect(seed, 'adult');
      expect(aspect / still, `${seed}`).toBeGreaterThan(0.75);
      expect(aspect / still, `${seed}`).toBeLessThan(1.1);
    }
    expect(heroAspect('2', 'adult')).toBeGreaterThan(heroAspect('9', 'adult'));
  });
});
