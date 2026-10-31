import { describe, expect, it } from 'vitest';
import { nextOnOpen, type Due, type Open } from './order';

const none: Due = { feed: false, gift: false, diary: false, notice: false };
const nothingOpen: Open = { feed: false, gift: false, other: false, diary: false };

describe('what opens by itself', () => {
  // spec: add-daily-ritual › Daily ritual flow › сначала действие
  it('opens the Diary when it is due and nothing is open', () => {
    expect(nextOnOpen({ ...none, diary: true }, nothingOpen)).toBe('diary');
    expect(nextOnOpen(none, nothingOpen)).toBeNull();
  });

  // spec: add-daily-ritual › Daily ritual flow › сначала действие
  it('puts Feed sheet first, then Gift sheet, then the Diary', () => {
    expect(nextOnOpen({ ...none, feed: true, gift: true, diary: true }, nothingOpen)).toBe('feed');
    expect(nextOnOpen({ ...none, gift: true, diary: true }, nothingOpen)).toBe('gift');
    expect(nextOnOpen({ ...none, diary: true }, nothingOpen)).toBe('diary');
  });

  // spec: add-daily-ritual › Daily ritual flow › сначала действие
  it('holds the Diary while a sheet, a hand-opened sheet, a dialog or a menu is open, and while the Diary stands', () => {
    for (const open of [{ feed: true }, { gift: true }, { other: true }, { diary: true }]) {
      expect(nextOnOpen({ ...none, diary: true }, { ...nothingOpen, ...open })).toBeNull();
    }
  });

  // spec: add-daily-ritual › Daily ritual flow › сначала действие
  it('opens a due Diary once the way has cleared', () => {
    const due = { ...none, diary: true };
    expect(nextOnOpen(due, { ...nothingOpen, feed: true })).toBeNull();
    expect(nextOnOpen(due, nothingOpen)).toBe('diary');
  });

  // spec: add-daily-ritual › Daily ritual flow › сначала действие × New outfit notice last, over what stands
  it('gives the New outfit notice last, over whatever stands, and after everything that is due', () => {
    expect(nextOnOpen({ ...none, notice: true }, { ...nothingOpen, other: true })).toBe('notice');
    expect(nextOnOpen({ ...none, notice: true }, { ...nothingOpen, diary: true })).toBe('notice');
    expect(nextOnOpen({ ...none, notice: true, diary: true }, nothingOpen)).toBe('diary');
    expect(nextOnOpen({ ...none, notice: true, diary: true }, { ...nothingOpen, other: true })).toBeNull();
    expect(nextOnOpen({ ...none, notice: true, feed: true }, nothingOpen)).toBe('feed');
  });
});
