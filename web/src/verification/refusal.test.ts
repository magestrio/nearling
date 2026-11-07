import { expect, it } from 'vitest';
import { refusalSignature } from './refusal';

// spec: add-pet-will › Refusal privacy data › receipt read
it('shows only a signature from the private signed bytes, never a made-up chain receipt', () => {
  const signature = '8k2RsignatureFromProviderS4Hq';
  expect(refusalSignature(btoa(JSON.stringify({ signature, response: [1, 2, 3] })))).toBe(signature);
  expect(refusalSignature(btoa(JSON.stringify({ resSha: 'f'.repeat(64) })))).toBeNull();
  expect(refusalSignature('invalid')).toBeNull();
});
