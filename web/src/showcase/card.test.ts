import { describe, expect, it, vi } from 'vitest';
import { renderShowcaseCard, showcaseFacts } from './card';

vi.mock('../errands/card', async (original) => {
  const real = await original<typeof import('../errands/card')>();
  return { ...real, petImage: () => null };
});

const thought = { tokenId: '9', name: 'Pixel', kind: 'thought' as const, thoughtId: 'a', line: 'A retained thought.' };

describe('Showcase card', () => {
  // spec: add-showcase › Pet share card screen › success
  it('keeps the selected line and printed public pet link in one set of facts', () => {
    expect(showcaseFacts(thought, 'https://example.test')).toEqual({ name: 'Pixel', kind: 'thought', line: 'A retained thought.', link: 'example.test/pet/9' });
    expect(showcaseFacts({ tokenId: '9', name: 'Pixel', kind: 'growth', stage: 'adult' }, 'https://example.test')).toMatchObject({ stage: 'Grown-up', link: 'example.test/pet/9' });
    expect(showcaseFacts({ tokenId: '9', name: 'Pixel', kind: 'outfit', worn: 'thinking-cap' }, 'https://example.test')).toMatchObject({ outfit: 'Thinking cap', link: 'example.test/pet/9' });
  });

  // spec: add-showcase › Pet share card screen › success
  it('paints the exact selected words and public link into the PNG source', async () => {
    const words: string[] = [];
    const ctx = { fillRect: () => undefined, beginPath: () => undefined, roundRect: () => undefined, stroke: () => undefined,
      fillText: (word: string) => words.push(word), measureText: (word: string) => ({ width: word.length * 8 }), drawImage: () => undefined };
    const canvas = { getContext: () => ctx, toBlob: (done: (blob: Blob) => void) => done(new Blob(['png'])) };
    vi.stubGlobal('document', { fonts: { load: async () => [] }, createElement: () => canvas });
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }));
    try {
      const image = await renderShowcaseCard(thought, { stage: 'adult', state: 'full', worn: null }, {} as Element, 'https://example.test');
      expect(image.size).toBe(3);
      expect(words.join(' ')).toContain('A retained thought.');
      expect(words).toContain('example.test/pet/9');
      expect(words.join(' ')).not.toContain('another thought');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  // spec: add-showcase › Pet card sharing flow › choose growth
  // spec: add-showcase › Pet card sharing flow › choose outfit
  it('paints the reached stage and worn outfit, each with the public link', async () => {
    const words: string[] = [];
    const ctx = { fillRect: () => undefined, beginPath: () => undefined, roundRect: () => undefined, stroke: () => undefined,
      fillText: (word: string) => words.push(word), measureText: (word: string) => ({ width: word.length * 8 }), drawImage: () => undefined };
    vi.stubGlobal('document', { fonts: { load: async () => [] }, createElement: () => ({ getContext: () => ctx, toBlob: (done: (blob: Blob) => void) => done(new Blob(['png'])) }) });
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }));
    try {
      await renderShowcaseCard({ tokenId: '9', name: 'Pixel', kind: 'growth', stage: 'adult' }, { stage: 'adult', state: 'full', worn: null }, {} as Element, 'https://example.test');
      await renderShowcaseCard({ tokenId: '9', name: 'Pixel', kind: 'outfit', worn: 'thinking-cap' }, { stage: 'adult', state: 'full', worn: 'thinking-cap' }, {} as Element, 'https://example.test');
      expect(words).toContain('Grown-up');
      expect(words).toContain('Thinking cap');
      expect(words.filter((word) => word === 'example.test/pet/9')).toHaveLength(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  // spec: add-showcase › Pet share card screen › success
  it('does not cut a long chosen line from the image', async () => {
    const words: string[] = [];
    const ctx = { fillRect: () => undefined, beginPath: () => undefined, roundRect: () => undefined, stroke: () => undefined,
      fillText: (word: string) => words.push(word), measureText: (word: string) => ({ width: word.length * 14 }), drawImage: () => undefined };
    vi.stubGlobal('document', { fonts: { load: async () => [] }, createElement: () => ({ getContext: () => ctx, toBlob: (done: (blob: Blob) => void) => done(new Blob(['png'])) }) });
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }));
    try {
      const line = `${'one two three four five six seven eight nine ten '.repeat(10)}last word`;
      await renderShowcaseCard({ ...thought, line }, { stage: 'adult', state: 'full', worn: null }, {} as Element, 'https://example.test');
      expect(words.join(' ')).toContain('last word');
      expect(words.join(' ')).not.toContain('…');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  // spec: add-showcase › Pet share card screen › error
  it('reports a canvas draw failure and permits a fresh draw', async () => {
    vi.stubGlobal('document', { fonts: { load: async () => [] }, createElement: () => ({ getContext: () => null }) });
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }));
    try {
      await expect(renderShowcaseCard(thought, { stage: 'adult', state: 'full', worn: null }, {} as Element, 'https://example.test')).rejects.toThrow('no 2d canvas');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
