// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { lineOf } from '../screens/pet/usePetScreen';

// spec: add-gift › Gift rule › разговор и память
it('writes the gift boundary from the chain block time and pet name', () => {
  const line = lineOf({ id: 'gift:1', who: 'event', code: 'gift', name: 'Pixel', at: Date.parse('2026-11-12T10:00:00Z') }, 'Pixel', false);
  expect(line).toEqual([{ id: 'gift:1', who: 'event', text: 'Pixel came to you as a gift on Nov 12, 2026. The chats above are from before.', fresh: undefined }]);
});
