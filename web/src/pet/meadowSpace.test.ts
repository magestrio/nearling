import { describe, expect, it } from 'vitest';
import { ELEVATION } from './PetFigure';
import { blocked, standAt, type Body } from './meadowSpace';

const COS = Math.cos(ELEVATION);
const SIN = Math.sin(ELEVATION);
// MeadowScene's feet line, in world units above the ground's middle, for a ground `height` CSS pixels tall
const screenY = (depth: number, height: number) => (0.5 * height - (0.3 + 0.66 * depth) * height) / 100;
const along = ({ y, z }: { y: number; z: number }) => y * SIN + z * COS;

describe('standAt', () => {
  // spec: add-account › Home screen › meadow
  it('keeps the screen place and puts a nearer row well in front of a farther one on any ground', () => {
    for (const height of [280, 600, 1400]) {
      for (const [far, near] of [[0.3, 0.35], [0.05, 0.12], [0.88, 0.95]] as const) {
        const back = standAt(screenY(far, height), far);
        const front = standAt(screenY(near, height), near);
        expect(back.y * COS - back.z * SIN).toBeCloseTo(screenY(far, height), 9);
        expect(front.y * COS - front.z * SIN).toBeCloseTo(screenY(near, height), 9);
        // a meadow body is at most about 3 world units deep at three-quarter
        expect(along(front) - along(back)).toBeGreaterThan(3);
      }
    }
  });
});

describe('blocked', () => {
  const row = (center: number, half = 50): Body => ({ center, half, top: 100, bottom: 200 });

  // spec: add-account › Home screen › meadow
  it('stops a pet from walking into another pet of its row', () => {
    const crowd = new Map([[0, row(100)], [1, row(205)]]);
    expect(blocked(crowd, 0, row(100), 106)).toBe(true);
    expect(blocked(crowd, 0, row(100), 94)).toBe(false);
  });

  // spec: add-account › Home screen › meadow
  it('lets a pet of another row pass and overlapping pets move apart', () => {
    const lower: Body = { center: 205, half: 50, top: 180, bottom: 280 };
    expect(blocked(new Map([[0, row(100)], [1, lower]]), 0, row(100), 106)).toBe(false);
    const crowd = new Map([[0, row(100)], [1, row(150)]]);
    expect(blocked(crowd, 0, row(100), 94)).toBe(false);
    expect(blocked(crowd, 0, row(100), 106)).toBe(true);
  });
});
