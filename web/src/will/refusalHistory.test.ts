import { expect, it } from 'vitest';
import { lineOf } from '../screens/pet/usePetScreen';
import type { ConversationLine } from '../seams/worker-types';

// spec: add-pet-will › Character refusal flow › character declines pet hire
// spec: add-pet-will › Refusal privacy data › signed refusal
it('restores the private character refusal reason and evidence link from a conversation event', () => {
  const stored: ConversationLine = { id: 'event', who: 'event', code: 'character_refused',
    worker: { tokenId: '5', name: 'Nori' }, hireMode: 'manual',
    refusal: { id: 'f'.repeat(24), reason: 'I would rather leave this to Pixel.' }, at: 1 };
  expect(lineOf(stored, 'Pixel', false)[0]).toMatchObject({
    who: 'event', text: 'I would rather leave this to Pixel. Pixel will answer instead.',
    refusalId: 'f'.repeat(24),
  });
});
