import { expect, it } from 'vitest';
import { hasEvidenceIntent } from './evidenceIntent';

// spec: add-showcase › Public demo flow › README numbers link with a session
it('holds the README numbers intent only at its exact public URL marker', () => {
  expect(hasEvidenceIntent('?showcase=numbers')).toBe(true);
  expect(hasEvidenceIntent('?showcase=numbers&from=readme')).toBe(true);
  expect(hasEvidenceIntent('')).toBe(false);
  expect(hasEvidenceIntent('?showcase=other')).toBe(false);
});
