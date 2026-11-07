import { describe, expect, it } from 'vitest';
import type { OutfitSlug, WardrobeView } from '../seams/worker-types';
import { LINE, wardrobeView, wishEarnedLine, type TileDraw, type WardrobeInput } from './wardrobeView';

const view = (patch: Partial<WardrobeView> = {}): WardrobeView => ({
  owned: ['daisy-crown', 'thinking-cap', 'party-hat'],
  worn: 'thinking-cap',
  price: { cents: 0.76, yocto: '1660000000000000000000' },
  short: false,
  shopPaused: false,
  buying: null,
  outcome: null,
  ...patch,
});
const input = (patch: Partial<WardrobeInput> = {}): WardrobeInput => ({
  name: 'Pixel',
  status: 'ready',
  asleep: false,
  pet: { outfits: ['daisy-crown', 'thinking-cap', 'party-hat'], worn: 'thinking-cap', outfitPrice: { cents: 0.76 } },
  view: view(),
  failed: null,
  tapped: null,
  ...patch,
});
const slugs = (tiles: TileDraw[]) => tiles.map((t) => t.slug);
const buyTiles = (patch: Partial<WardrobeInput> = {}) => wardrobeView(input(patch)).tiles!.toBuy;

describe('what Wardrobe screen draws', () => {
  // spec: add-pet-will › Wish pursuit flow › automatic purchase
  it('announces only a confirmed pet wish purchase as earned', () => {
    const bought = { id: 'wish-buy', item: 'smart-glasses' as const, status: 'bought' as const, code: null, source: 'pet_wish' as const };
    expect(wishEarnedLine('Pixel', view({ outcome: bought }))).toBe('Pixel earned Smart glasses!');
    expect(wishEarnedLine('Pixel', view({ outcome: { ...bought, source: 'owner' } }))).toBeNull();
    expect(wishEarnedLine('Pixel', view({ outcome: { ...bought, status: 'failed' } }))).toBeNull();
  });
  // spec: add-wardrobe › Wardrobe screen › success × the order of the tiles
  it("puts the own items first, then the earned not yet, then the ones to buy, each in the catalogue's order", () => {
    const draw = wardrobeView(input());
    expect(slugs(draw.tiles!.mine)).toEqual(['daisy-crown', 'thinking-cap', 'party-hat']);
    expect(slugs(draw.tiles!.notYet)).toEqual(['cozy-scarf']);
    expect(slugs(draw.tiles!.toBuy)).toEqual(['smart-glasses', 'bow-tie', 'headphones']);
  });

  // spec: add-wardrobe › Wardrobe screen › success
  it('gives the worn item «Take off», ringed, and the others «Wear»; the earned ones their condition, the bought ones «Buy» with the price', () => {
    const draw = wardrobeView(input());
    expect(draw.tiles!.mine.map((t) => [t.slug, t.action, t.worn, t.does])).toEqual([
      ['daisy-crown', 'Wear', false, 'wear'],
      ['thinking-cap', 'Take off', true, 'takeoff'],
      ['party-hat', 'Wear', false, 'wear'],
    ]);
    expect(draw.tiles!.notYet[0]).toMatchObject({ slug: 'cozy-scarf', condition: 'Reach a 3-day streak' });
    expect(draw.tiles!.notYet[0]!.action).toBeUndefined();
    expect(draw.tiles!.toBuy[0]).toMatchObject({ action: 'Buy', price: '0.76¢', does: 'buy', off: false, pending: false });
    expect(draw.worn).toBe('thinking-cap');
    expect(draw.top).toBeNull();
    expect(draw.listLines).toEqual([]);
    expect(draw.buyLine).toBeNull();
  });

  // spec: add-wardrobe › Wardrobe screen › success
  it("says the condition of each earned item in the spec's words", () => {
    const draw = wardrobeView(input({ view: view({ owned: [], worn: null }) }));
    expect(draw.tiles!.notYet.map((t) => t.condition)).toEqual(['Reach a 1-day streak', 'Reach a 3-day streak', 'Solve your first riddle']);
  });

  // spec: add-wardrobe › Wardrobe screen › empty × the line and the conditions
  it('says «Nothing to wear yet!» with every earned item on its condition and every Buy off on starter food', () => {
    const draw = wardrobeView(input({ view: view({ owned: [], worn: null, short: true }) }));
    expect(draw.listLines).toEqual([
      { id: LINE.empty, text: 'Nothing to wear yet! Pixel earns outfits for daily rituals and riddles — and a well-fed Pixel can buy one below.' },
    ]);
    expect(draw.tiles!.mine).toEqual([]);
    expect(draw.tiles!.notYet.every((t) => t.condition !== undefined)).toBe(true);
    expect(draw.buyLine).toEqual({ id: LINE.short, text: 'Pixel needs a little more food before buying this.' });
    for (const t of draw.tiles!.toBuy) expect(t).toMatchObject({ action: 'Buy', price: '0.76¢', off: true, why: LINE.short });
  });

  // spec: add-wardrobe › Wardrobe screen › loading
  it('draws the opening line and the tiles of what the page knows, every action disabled', () => {
    const draw = wardrobeView(input({ status: 'loading', view: null }));
    expect(draw.top).toEqual({ tone: 'status', text: "Opening Pixel's wardrobe…", action: null });
    expect(draw.listLines).toEqual([]);
    const all = [...draw.tiles!.mine, ...draw.tiles!.toBuy];
    expect(all.length).toBe(6);
    for (const t of all) expect(t.disabled).toBe(true);
    expect(draw.tiles!.mine.map((t) => t.action)).toEqual(['Wear', 'Take off', 'Wear']);
    expect(draw.tiles!.toBuy[0]).toMatchObject({ action: 'Buy', price: '0.76¢' });
  });

  // spec: add-wardrobe › Wardrobe screen › error
  it('draws the error line with «Try again» and no tile, the pet in its last known outfit', () => {
    const draw = wardrobeView(input({ status: 'error', view: null }));
    expect(draw.top).toEqual({ tone: 'error', text: "We couldn't open Pixel's wardrobe right now. Try again in a moment.", action: 'try-again' });
    expect(draw.tiles).toBeNull();
    expect(draw.worn).toBe('thinking-cap');
  });

  // spec: add-wardrobe › Wardrobe screen › asleep
  it('says the pet fell asleep with «Back to {name}», every Buy off and described by that line, Wear and Take off working', () => {
    const draw = wardrobeView(input({ asleep: true, view: view({ short: true }) }));
    expect(draw.top).toEqual({ tone: 'plain', text: 'Pixel fell asleep. A meal will wake Pixel up — you can still change outfits.', action: 'back', id: LINE.asleep });
    // asleep has no food line: the page's line is the reason
    expect(draw.buyLine).toBeNull();
    for (const t of draw.tiles!.toBuy) expect(t).toMatchObject({ off: true, why: LINE.asleep });
    for (const t of draw.tiles!.mine) expect(t.disabled).toBe(false);
  });

  // spec: add-wardrobe › Outfit purchase flow › покупки на паузе
  it('puts the pause line at the top of the list and describes every off Buy by it; the own items stay on', () => {
    const draw = wardrobeView(input({ view: view({ shopPaused: true }) }));
    expect(draw.listLines).toEqual([{ id: LINE.paused, text: "Shopping is paused on our side while we top up. Pixel's outfits still work." }]);
    for (const t of draw.tiles!.toBuy) expect(t).toMatchObject({ off: true, why: LINE.paused });
    for (const t of draw.tiles!.mine) expect(t.off).toBeUndefined();
  });

  // spec: add-wardrobe › Outfit purchase flow › покупки на паузе × short of food too
  it('keeps both lines when the pause and the food are both true, and Buy names the pause', () => {
    const draw = wardrobeView(input({ view: view({ shopPaused: true, short: true }) }));
    expect(draw.listLines.map((l) => l.id)).toEqual([LINE.paused]);
    expect(draw.buyLine?.id).toBe(LINE.short);
    for (const t of draw.tiles!.toBuy) expect(t.why).toBe(LINE.paused);
  });

  // spec: add-wardrobe › Outfit purchase flow › мало еды
  it('puts the food line above the Buy items and describes them by it; Wear works', () => {
    const draw = wardrobeView(input({ view: view({ short: true }) }));
    expect(draw.buyLine).toEqual({ id: LINE.short, text: 'Pixel needs a little more food before buying this.' });
    for (const t of draw.tiles!.toBuy) expect(t).toMatchObject({ off: true, why: LINE.short });
    expect(draw.tiles!.mine.every((t) => t.off === undefined)).toBe(true);
  });

  // spec: add-wardrobe › Outfit purchase flow › покупает
  it('turns the tapped Buy to «Buying…» and the others off with no line of their own; the own items stay on', () => {
    const draw = wardrobeView(input({ view: view({ buying: { id: 'b1', item: 'smart-glasses' } }) }));
    expect(draw.buying).toBe('smart-glasses');
    expect(draw.tiles!.toBuy.map((t) => [t.slug, t.pending, t.off, t.why])).toEqual([
      ['smart-glasses', true, false, undefined],
      ['bow-tie', false, true, undefined],
      ['headphones', false, true, undefined],
    ]);
    expect(draw.buyLine).toBeNull();
  });

  // spec: add-wardrobe › Outfit purchase flow › покупает
  it("takes the tapped Buy for the purchase before a read holds it, and the server's row once it does", () => {
    expect(wardrobeView(input({ tapped: 'bow-tie' })).buying).toBe('bow-tie');
    expect(wardrobeView(input({ tapped: 'bow-tie', view: view({ buying: { id: 'b1', item: 'headphones' } }) })).buying).toBe('headphones');
  });

  // spec: add-wardrobe › Outfit purchase flow › покупает
  it('does not say the food is short while the purchase on its way holds the price', () => {
    const draw = wardrobeView(input({ view: view({ short: true, buying: { id: 'b1', item: 'bow-tie' } }) }));
    expect(draw.buyLine).toBeNull();
    expect(draw.tiles!.toBuy.find((t) => t.slug === 'bow-tie')).toMatchObject({ pending: true });
  });

  // spec: add-wardrobe › Outfit purchase flow › куплено
  it('moves a bought item among the own ones, wearing it when the read says so', () => {
    const draw = wardrobeView(input({ view: view({ owned: ['daisy-crown', 'thinking-cap', 'smart-glasses', 'party-hat'], worn: 'smart-glasses' }) }));
    expect(slugs(draw.tiles!.mine)).toEqual(['daisy-crown', 'thinking-cap', 'smart-glasses', 'party-hat']);
    expect(draw.tiles!.mine.find((t) => t.slug === 'smart-glasses')).toMatchObject({ action: 'Take off', worn: true });
    expect(slugs(draw.tiles!.toBuy)).toEqual(['bow-tie', 'headphones']);
  });

  // spec: add-wardrobe › Outfit purchase flow › не прошло
  it('gives the failed tile «Try again» with no price and the line across the grid, described by it', () => {
    const draw = wardrobeView(input({ failed: 'smart-glasses' }));
    const failed = draw.tiles!.toBuy.find((t) => t.slug === 'smart-glasses')!;
    expect(failed).toMatchObject({ action: 'Try again', price: undefined, off: false, why: LINE.failed });
    expect(draw.failedNote).toEqual({ id: LINE.failed, text: "That didn't go through. Nothing was spent — try again." });
    // the others keep their Buy and the price
    expect(draw.tiles!.toBuy.filter((t) => t !== failed).every((t) => t.action === 'Buy' && t.price === '0.76¢')).toBe(true);
  });

  // spec: add-wardrobe › Outfit purchase flow › не прошло × Buy turns off
  it("lets the failed line go when Buy turns off, whichever way: Buy's own line says why", () => {
    for (const patch of [{ view: view({ short: true }) }, { view: view({ shopPaused: true }) }, { asleep: true }]) {
      const draw = wardrobeView(input({ failed: 'smart-glasses', ...patch }));
      expect(draw.failedNote).toBeNull();
      expect(draw.tiles!.toBuy[0]).toMatchObject({ action: 'Buy', off: true });
    }
  });

  // spec: add-wardrobe › Outfit purchase flow › не прошло × the item already on chain
  it("lets the failed line go with the tile when the item turns out to be the pet's already", () => {
    const owns: OutfitSlug[] = ['daisy-crown', 'thinking-cap', 'party-hat', 'smart-glasses'];
    const draw = wardrobeView(input({ failed: 'smart-glasses', view: view({ owned: owns }) }));
    expect(draw.failedNote).toBeNull();
    expect(slugs(draw.tiles!.mine)).toContain('smart-glasses');
    expect(buyTiles({ failed: 'smart-glasses', view: view({ owned: owns }) }).every((t) => t.action === 'Buy')).toBe(true);
  });

  // spec: add-wardrobe › Wardrobe screen › success × the order of the tiles
  it("reads the worn item from the wardrobe's read, and from the pet while the read is on its way", () => {
    expect(wardrobeView(input({ view: view({ worn: null }) })).worn).toBeNull();
    expect(wardrobeView(input({ status: 'loading', view: null })).worn).toBe('thinking-cap');
  });
});
