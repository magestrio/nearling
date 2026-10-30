import { describe, expect, it } from 'vitest';
import { queueAction, registerAction, runAction, takePendingAction } from './parts';

const ctx = { tokenId: '9', name: 'Pixel', viewer: 'owner' as const };

describe('the Pet screen parts registry', () => {
  // spec: add-pet › Pet screen › signed-out (вошёл владелец)
  it('hands «Feed {name}», tapped before the sign-in, to the screen once after it', () => {
    queueAction('feed');
    expect(takePendingAction()).toBe('feed');
    expect(takePendingAction()).toBeNull();
    queueAction(undefined);
    expect(takePendingAction()).toBeNull();
  });

  it('does nothing for an action whose change is not built, and runs it once registered', () => {
    expect(runAction('gift', ctx)).toBe(false);
    const seen: string[] = [];
    registerAction('gift', (c) => seen.push(`${c.viewer}:${c.name}`));
    expect(runAction('gift', ctx)).toBe(true);
    expect(seen).toEqual(['owner:Pixel']);
  });
});
