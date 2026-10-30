import { describe, expect, it } from 'vitest';
import { formatCents } from './price';

describe('{price}', () => {
  it('writes cents with two significant digits and the cent sign', () => {
    expect(formatCents(0.12)).toBe('0.12¢');
    expect(formatCents(0.13)).toBe('0.13¢');
    expect(formatCents(0.4)).toBe('0.40¢');
    expect(formatCents(0.076)).toBe('0.076¢');
    expect(formatCents(1.234)).toBe('1.2¢');
    expect(formatCents(12.3)).toBe('12¢');
  });

  it('does not use an exponent for a large or an odd value', () => {
    expect(formatCents(250)).toBe('250¢');
    expect(formatCents(NaN)).toBe('0¢');
    expect(formatCents(-1)).toBe('0¢');
  });
});
