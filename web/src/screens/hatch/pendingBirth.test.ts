// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { clearPendingBirths, clearPendingName, keepPendingName, pendingName } from './pendingBirth';

beforeEach(() => sessionStorage.clear());

describe('a birth awaiting its original transaction outcome', () => {
  // spec: add-pet › Birth flow › birth pending
  // spec: add-hatch-again › Repeat birth flow › unknown outcome
  it('keeps the exact typed name across a reload, scoped to the player', () => {
    keepPendingName('alice.testnet', ' Pixel ');
    expect(pendingName('alice.testnet')).toBe(' Pixel ');
    expect(pendingName('bob.testnet')).toBeNull();
    expect(sessionStorage.getItem('nearling:hatch:alice.testnet')).toBe(' Pixel ');
  });

  // spec: add-pet › Birth flow › birth pending
  // spec: add-pet › Birth flow › не вылупился
  // spec: add-hatch-again › Repeat birth flow › confirmed failure
  it('removes the pending name only when the outcome has settled', () => {
    keepPendingName('alice.testnet', 'Pixel');
    expect(pendingName('alice.testnet')).toBe('Pixel');
    clearPendingName('alice.testnet');
    expect(pendingName('alice.testnet')).toBeNull();
  });

  // spec: add-pet › Birth flow › birth pending
  // spec: add-hatch-again › Hatch again screen › success × sign-out
  it('clears every account on sign-out', () => {
    keepPendingName('alice.testnet', 'Pixel');
    keepPendingName('bob.testnet', 'Biscuit');
    clearPendingBirths();
    expect(pendingName('alice.testnet')).toBeNull();
    expect(pendingName('bob.testnet')).toBeNull();
  });
});
