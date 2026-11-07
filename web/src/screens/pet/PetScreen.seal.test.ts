import { expect, it } from 'vitest';
import { sealLine } from './PetScreen';

// spec: add-verification › Seal of character rule › character checked
it('uses the birth seal wording on the Pet screen', () => {
  expect(sealLine('Pixel', { kind: 'checked', hash: 'a'.repeat(64) })).toBe('This mark checks that Pixel has the character sealed at birth. Game updates may change how we check it.');
});
