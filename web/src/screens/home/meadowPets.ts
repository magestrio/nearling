import type { MeadowPet } from '../../pet/MeadowScene';

// The sample pets of design/bundle/screens/account.js › CROWD. They are decoration, never fetched from a player or chain.
export const MEADOW_PETS: MeadowPet[] = [
  { seed: 0, stage: 'adult', state: 'full', view: 'three-quarter', x: 0.04, depth: 0.95 },
  { seed: 9, stage: 'adult', state: 'full', outfit: 'party-hat', view: 'three-quarter', x: 0.97, depth: 0.88, flip: true },
  { seed: 7, stage: 'teen', state: 'asleep', view: 'three-quarter', x: 0.5, depth: 0.5 },
  { seed: 2, stage: 'baby', state: 'full', view: 'three-quarter', x: 0.1, depth: 0.2 },
  { seed: 5, stage: 'adult', state: 'hungry', view: 'three-quarter', x: 0.92, depth: 0.12, flip: true },
  { seed: 12, stage: 'adult', state: 'full', view: 'three-quarter', x: 0.72, depth: 0.3, wide: true },
  { seed: 6, stage: 'adult', state: 'full', view: 'three-quarter', x: 0.3, depth: 0.35, flip: true, wide: true },
  { seed: 1, stage: 'adult', state: 'asleep', view: 'three-quarter', x: 0.4, depth: 0.05, wide: true },
  { seed: 258, stage: 'adult', state: 'full', view: 'three-quarter', x: 0.68, depth: 0.68, flip: true, wide: true },
  { seed: 1, stage: 'teen', state: 'full', view: 'three-quarter', x: 0.27, depth: 0.8, wide: true },
];
