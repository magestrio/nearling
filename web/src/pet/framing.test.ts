import { describe, expect, it } from 'vitest';
import { assemblePet } from './proto/assemble.js';
import { BLEED, frameOf } from './PetFigure';

const FIGURE = 1192 / 1423;
const ELEVATION = (9 * Math.PI) / 180;
const PETS = [['9', 'baby'], ['2', 'baby'], ['2', 'adult'], ['9', 'adult'], ['0', 'teen']] as const;

describe('the camera of the pet\'s canvas', () => {
  // spec: add-pet › Pet screen › empty
  it('keeps the light on the ground inside the canvas, for a baby and a wide pet', () => {
    for (const [seed, stage] of PETS) {
      const a = assemblePet(seed, 'full', stage, 'none');
      const { centerY, half } = frameOf(a, FIGURE);
      const [rx, rz] = a.pool.radius as [number, number];
      const reach = 2.2 * Math.hypot(rx, rz) * Math.SQRT1_2;
      expect(reach, `${seed} ${stage} across`).toBeLessThanOrEqual(half * FIGURE);
      expect(reach * Math.sin(ELEVATION), `${seed} ${stage} below`).toBeLessThanOrEqual(half + centerY);
    }
  });

  // spec: add-pet › Pet screen › success (владелец)
  it('leaves the pet the size of its box: the room for the light is around the box, not taken from the pet', () => {
    for (const [seed, stage] of PETS) {
      const a = assemblePet(seed, 'full', stage, 'none');
      const silhouette = Math.max(a.bounds.top / 2, a.bounds.width34 / 2 / FIGURE) * 1.25;
      // a pet whose light reaches further stands a little smaller, never by a tenth
      const share = frameOf(a, FIGURE).half / silhouette / BLEED;
      expect(share, `${seed} ${stage}`).toBeGreaterThanOrEqual(1);
      expect(share, `${seed} ${stage}`).toBeLessThan(1.1);
    }
  });
});
