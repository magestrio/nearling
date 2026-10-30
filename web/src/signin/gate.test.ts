import { describe, expect, it } from 'vitest';
import { gateBlocks, monthOf } from './gate';

describe('gateBlocks', () => {
  // spec: add-account › Sign-in flow › вход закрыт
  it('lets a tap through while open, and stops every tap at the ceiling', () => {
    expect(gateBlocks({ state: 'open' }, false)).toBeNull();
    expect(gateBlocks({ state: 'closed_all', until: '2026-12-01T00:00:00.000Z' }, false)).toBe('closed_all');
    expect(gateBlocks({ state: 'closed_all', until: '2026-12-01T00:00:00.000Z' }, true)).toBe('closed_all');
  });

  // spec: add-account › Sign-in flow › вернувшийся входит
  it('stops a new player when closed for new, and lets «Played here before?» through to Google', () => {
    const closed = { state: 'closed_new', until: '2026-12-01T00:00:00.000Z' } as const;
    expect(gateBlocks(closed, false)).toBe('closed_new');
    expect(gateBlocks(closed, true)).toBeNull();
  });
});

describe('monthOf', () => {
  // spec: add-account › Sign-in flow › новый после Google
  it('names the month of the 1st that opens the sign-in, in UTC', () => {
    expect(monthOf('2026-12-01T00:00:00.000Z')).toBe('December');
    expect(monthOf('2027-01-01T00:00:00.000Z')).toBe('January');
  });
});
