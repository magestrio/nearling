import { expect, it } from 'vitest';
import { Animator } from './proto/animator.js';
import { assemblePet } from './proto/assemble.js';
import { HUE_LIGHT } from './proto/materials.js';

// spec: add-account › Home screen › signed-out
it('uses the meadow hop height without changing the usual pet hop', () => {
  const pet = assemblePet('0', 'full', 'adult');
  const animator = new Animator(HUE_LIGHT[pet.spec.hue as keyof typeof HUE_LIGHT]);
  animator.setAssembly(pet);
  animator.setMoving(true);
  animator.fire('hop', { height: 0.03 });
  expect(animator.hopping!.height).toBeCloseTo(pet.bounds.top * 0.03);
  animator.fire('hop');
  expect(animator.hopping!.height).toBeCloseTo(pet.bounds.top * 0.07);
});
