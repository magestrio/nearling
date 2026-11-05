import { assemblePet } from './proto/assemble.js';

// The frames draw a pet as its still: a picture cropped to the silhouette and the light on the ground, so a wide pet's
// picture is wide and short and the plate stands right under it. The live figure has no picture to take that proportion
// from; it takes the estimate below from the pet's own geometry (assemble.js › bounds, pool). Fitted to the full-state stills of
// `design/pet/` (three-quarter, full, every stage): within 10% on average. The camera fits the silhouette inside the box
// (PetFigure.tsx › frameOf), so a box wider than the silhouette's own proportion makes the pet stand small in it:
// the estimate never goes over `SILHOUETTE_SLACK` times the silhouette's width to height. The state does not enter: the box
// must not change when a pet falls asleep or wakes.
const BODY_SHARE = 0.6;
const POOL_SHARE = 3.5;
const MARGIN = 0.1;
const SILHOUETTE_SLACK = 1.2;

export function heroAspect(tokenId: string, stage: 'baby' | 'teen' | 'adult'): number {
  const { bounds, pool } = assemblePet(tokenId, 'full', stage) as {
    bounds: { top: number; width34: number };
    pool: { radius: number[] };
  };
  const reach = Math.max(bounds.width34 * BODY_SHARE, (pool.radius[0] ?? 0) * POOL_SHARE);
  return Math.min((reach + MARGIN) / (bounds.top + MARGIN), (SILHOUETTE_SLACK * bounds.width34) / bounds.top);
}
