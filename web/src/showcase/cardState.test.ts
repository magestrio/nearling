import { describe, expect, it } from 'vitest';
import { cardState, emptyCard } from './cardState';

describe('Showcase card draft', () => {
  // spec: add-showcase › Pet card sharing flow › choose a thought × choose/change
  it('keeps exactly the selected retained line through a draw failure and retry', () => {
    const open = cardState(emptyCard, { type: 'open', kind: 'thought', thoughtId: 'a' });
    const chosen = cardState(open, { type: 'choose', thoughtId: 'b' });
    const drawing = cardState(chosen, { type: 'source', source: { tokenId: '9', name: 'Pixel', kind: 'thought', thoughtId: 'b', line: 'A thought.' } });
    const failed = cardState(drawing, { type: 'draw_failed' });
    expect(cardState(failed, { type: 'retry' })).toMatchObject({ phase: 'drawing', thoughtId: 'b', source: { line: 'A thought.' } });
  });

  // spec: add-showcase › Card eligibility rule › memory cleared × memory clear
  it('drops erased words and asks for another choice', () => {
    const source = { tokenId: '9', name: 'Pixel', kind: 'thought' as const, thoughtId: 'a', line: 'Gone.' };
    const drawing = cardState(cardState(emptyCard, { type: 'open', kind: 'thought', thoughtId: 'a' }), { type: 'source', source });
    const erased = cardState(drawing, { type: 'erased' });
    expect(erased).toEqual({ phase: 'selecting', kind: 'thought', thoughtId: null, note: 'That thought is no longer here. Choose another one.' });
  });

  // spec: add-showcase › Pet card sharing flow › choose a thought × close/reload/sign-out/session expiry/gift/site-data erasure
  it('resets every transient draft without browser storage', () => {
    const source = { tokenId: '9', name: 'Pixel', kind: 'thought' as const, thoughtId: 'a', line: 'Private until chosen.' };
    const drawing = cardState(cardState(emptyCard, { type: 'open', kind: 'thought', thoughtId: 'a' }), { type: 'source', source });
    const ready = cardState(drawing, { type: 'drawn', image: new Blob(['png']) });
    expect(ready.phase).toBe('ready');
    expect(cardState(ready, { type: 'reset' })).toBe(emptyCard);
    expect(cardState(drawing, { type: 'reset' })).toBe(emptyCard);
    expect(cardState(emptyCard, { type: 'reset' })).toBe(emptyCard);
  });
});
