import { expect, it } from 'vitest';
import { linkedFood, nearAmount } from './sharedApproval';

// spec: add-pet-errands › Friend-funded errand flow › old reserve after memory clear and gift
it('shows the exact linked NEAR food without rounding away a reserved snack', () => {
  const food = linkedFood({ hash: 'b'.repeat(64), state: 'transferred', linked_near: '1700000000000000000000', linked_snack: '3400000000000000000000' });
  expect(nearAmount(food)).toBe('0.0051 NEAR');
});
