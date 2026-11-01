import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { known, nameOf, outfitOf, OUTFITS, pictureOf, wearProps } from './catalogue';
import { noticeErrorLine, noticeLine } from './lines';
import { OUTFITS as PROTOTYPE } from '../pet/proto/outfits.js';

describe("the client's catalogue", () => {
  // spec: add-wardrobe › Outfit catalogue rule › умные очки × the catalogue of the client
  it('holds the seven items in the catalogue order: three earned, four bought, with the names of the spec', () => {
    expect(OUTFITS.map((o) => [o.slug, o.name, o.kind])).toEqual([
      ['daisy-crown', 'Daisy crown', 'streak'],
      ['cozy-scarf', 'Cozy scarf', 'streak'],
      ['thinking-cap', 'Thinking cap', 'riddle'],
      ['smart-glasses', 'Smart glasses', 'bought'],
      ['bow-tie', 'Bow tie', 'bought'],
      ['headphones', 'Headphones', 'bought'],
      ['party-hat', 'Party hat', 'bought'],
    ]);
  });

  // spec: add-wardrobe › Outfit catalogue rule › умные очки × the catalogue of the client
  it("is the pet's model's own list: every item has a model and the same name, and a picture to put on its tile", () => {
    for (const o of OUTFITS) {
      expect((PROTOTYPE as Record<string, { name: string }>)[o.slug]?.name).toBe(o.name);
      expect(existsSync(`public${pictureOf(o.slug)}`), o.slug).toBe(true);
    }
  });

  // spec: add-wardrobe › Outfit catalogue rule › умные очки × the catalogue of the client
  it('gives only the earned ones a condition, and the spec\'s words for it', () => {
    expect(OUTFITS.map((o) => o.condition)).toEqual(['Reach a 1-day streak', 'Reach a 3-day streak', 'Solve your first riddle', undefined, undefined, undefined, undefined]);
  });

  // spec: add-wardrobe › New outfit notice screen › success × a streak and a riddle item
  it("says what earned an item in the notice's words: the streak's days, or the first solved riddle", () => {
    expect(noticeLine('Pixel', 'daisy-crown')).toBe('Pixel earned the Daisy crown for a 1-day streak.');
    expect(noticeLine('Pixel', 'cozy-scarf')).toBe('Pixel earned the Cozy scarf for a 3-day streak.');
    expect(noticeLine('Pixel', 'thinking-cap')).toBe('Pixel earned the Thinking cap for the first solved riddle.');
    expect(noticeErrorLine('Pixel', 'Cozy scarf')).toBe("Couldn't put it on just now. The Cozy scarf is waiting in Pixel's wardrobe.");
  });

  // spec: add-wardrobe › Outfit rule › надел
  it("names the worn item for the picture's alt, and leaves a slug it does not know out", () => {
    expect(wearProps('thinking-cap')).toEqual({ outfit: 'thinking-cap', wearing: 'Thinking cap' });
    expect(wearProps(null)).toEqual({});
    expect(wearProps('top-hat')).toEqual({});
    expect(nameOf('bow-tie')).toBe('Bow tie');
    expect(nameOf('top-hat')).toBeUndefined();
    expect(outfitOf('headphones').kind).toBe('bought');
    expect(known(['party-hat', 'top-hat', 'daisy-crown'])).toEqual(['daisy-crown', 'party-hat']);
  });
});
