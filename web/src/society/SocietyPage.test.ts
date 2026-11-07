import { expect, it } from 'vitest';
import { relationshipLabel } from './SocietyPage';

// spec: add-pet-society › Society summary screen › success
it('uses the four public stance labels and drops an expired break', () => {
  const row = { tokenId: '2', name: 'Biscuit', stance: 'neutral' as const, breakUntil: null };
  expect(relationshipLabel(row)).toBe('Getting to know');
  expect(relationshipLabel({ ...row, stance: 'liked' })).toBe('Likes');
  expect(relationshipLabel({ ...row, stance: 'strained' })).toBe('Strained');
  expect(relationshipLabel({ ...row, stance: 'strained', breakUntil: 2000 }, 1000)).toContain('Taking a break until ');
  expect(relationshipLabel({ ...row, stance: 'strained', breakUntil: 2000 }, 2000)).toBe('Strained');
});
