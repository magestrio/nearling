import { describe, expect, it } from 'vitest';
import fixture from './generator.fixture.json';
import { makePet, STAGES } from './proto/generator.js';
import { STATE_NAMES } from './proto/states.js';

// The fixture is what pet-proto's own generator returned (read-only, its snapshot before the motion work, whose
// stills are design/pet/*.png; `states.js` is the prototype's current one — the asleep light 0.3, PROTO DRIFT of
// 2026-10-30) for the seeds of those stills: 0, 1, 2, 5, 9, 12, every stage and state. The port must
// give the same pet for the same token_id, so the pet on the screen is the pet of the design stills.
const SEEDS = ['0', '1', '2', '5', '9', '12'];

describe('the ported pet generator', () => {
  it('has a fixture entry for every seed, stage and state', () => {
    expect(Object.keys(fixture)).toHaveLength(SEEDS.length * STAGES.length * STATE_NAMES.length);
  });

  for (const seed of SEEDS) {
    for (const stage of STAGES) {
      for (const state of STATE_NAMES) {
        it(`gives the pet of the stills for token_id ${seed}, ${stage}, ${state}`, () => {
          const expected = (fixture as Record<string, unknown>)[`${seed}-${stage}-${state}`];
          expect(JSON.parse(JSON.stringify(makePet(seed, { stage, state })))).toEqual(expected);
        });
      }
    }
  }

  it('turns a token_id into the same pet every time, and a different one for another', () => {
    expect(makePet('9')).toEqual(makePet('9'));
    expect(makePet('9').hue).toBeTypeOf('string');
    expect(JSON.stringify(makePet('3'))).not.toEqual(JSON.stringify(makePet('4')));
  });
});
