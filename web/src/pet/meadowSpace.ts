import { ELEVATION } from './PetFigure';

const COS = Math.cos(ELEVATION);
const SIN = Math.sin(ELEVATION);

/** World units along the view between the farthest meadow pet (depth 0) and the nearest (depth 1). */
export const DEPTH_SPREAD = 100;
/** The orthographic camera stands this far from the ground's middle, in front of the nearest pet. */
export const CAMERA_DISTANCE = 2 * DEPTH_SPREAD;

/**
 * Where a meadow pet stands in the scene: the point `screenY` world units above the ground's middle on screen, at `depth`.
 * The camera looks down by ELEVATION, so a point's screen height is y·cos − z·sin and its distance along the view
 * y·sin + z·cos. The pets of neighbouring rows sit a few CSS pixels apart on screen but are about a world unit deep
 * each; `depth` alone as z let a farther pet's hat or brim reach in front of a nearer pet's body. Spread over
 * DEPTH_SPREAD, the nearest of two rows 0.05 apart is still 5 world units nearer, and the screen place is unchanged.
 */
export function standAt(screenY: number, depth: number): { y: number; z: number } {
  const z = depth * DEPTH_SPREAD;
  return { y: (screenY + z * SIN) / COS, z };
}

/** A meadow pet's body on the ground's screen, in CSS pixels: its centre across, half its width, its top and its feet. */
export type Body = { center: number; half: number; top: number; bottom: number };

/** Two pets walk in the same row when they share more than this part of the shorter one's height on screen. */
const SHARED_HEIGHT = 0.25;

function sameRow(a: Body, b: Body): boolean {
  const shared = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return shared > SHARED_HEIGHT * Math.min(a.bottom - a.top, b.bottom - b.top);
}

/**
 * True when moving the pet `index` (now at `me`) to the centre `next` would push its body into another pet of its row:
 * the bodies would overlap and come closer. Pets already overlapping may still move apart.
 */
export function blocked(crowd: ReadonlyMap<number, Body>, index: number, me: Body, next: number): boolean {
  for (const [other, body] of crowd) {
    if (other === index || !sameRow(me, body)) continue;
    const after = Math.abs(body.center - next);
    if (after < me.half + body.half && after < Math.abs(body.center - me.center)) return true;
  }
  return false;
}
