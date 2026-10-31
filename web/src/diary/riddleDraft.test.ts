// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearRiddleDrafts, eraseRiddleDraft, loadRiddleDraft, saveRiddleDraft } from './riddleDraft';

beforeEach(() => {
  sessionStorage.clear();
  vi.restoreAllMocks();
});

describe('the riddle answer typed and not sent', () => {
  // spec: add-daily-ritual › Ritual data › typed riddle answer
  it('stays with the day it was typed for, and a reload in that day brings it back', () => {
    saveRiddleDraft('9', { day: 20757, text: 'a clock' });
    expect(JSON.parse(sessionStorage.getItem('nearling.riddleDraft.9')!)).toEqual({ day: 20757, text: 'a clock' });
    expect(loadRiddleDraft('9', 20757)).toEqual({ day: 20757, text: 'a clock' });
  });

  // spec: add-daily-ritual › Ritual data › typed riddle answer
  it('is removed and not returned by a reload after its day', () => {
    saveRiddleDraft('9', { day: 20757, text: 'a clock' });
    expect(loadRiddleDraft('9', 20758)).toBeNull();
    expect(sessionStorage.getItem('nearling.riddleDraft.9')).toBeNull();
  });

  // spec: add-daily-ritual › Ritual data › typed riddle answer
  it('keeps one draft for each pet, and an empty one is no draft', () => {
    saveRiddleDraft('9', { day: 20757, text: 'a clock' });
    saveRiddleDraft('2', { day: 20757, text: 'a piano' });
    expect(loadRiddleDraft('2', 20757)?.text).toBe('a piano');
    saveRiddleDraft('9', { day: 20757, text: '' });
    expect(sessionStorage.getItem('nearling.riddleDraft.9')).toBeNull();
    saveRiddleDraft('2', null);
    expect(loadRiddleDraft('2', 20757)).toBeNull();
  });

  // spec: add-daily-ritual › Ritual data › typed riddle answer
  it('is erased by a send, and by a sign-out for every pet of the tab at once, and nothing else of the tab', () => {
    saveRiddleDraft('9', { day: 20757, text: 'a clock' });
    saveRiddleDraft('2', { day: 20757, text: 'a piano' });
    sessionStorage.setItem('nearling.returnPlace', '{}');
    eraseRiddleDraft('9');
    expect(loadRiddleDraft('9', 20757)).toBeNull();
    clearRiddleDrafts();
    expect(loadRiddleDraft('2', 20757)).toBeNull();
    expect(sessionStorage.getItem('nearling.returnPlace')).toBe('{}');
  });

  // spec: add-daily-ritual › Ritual data › typed riddle answer
  it('takes a broken record, or storage that is blocked, for no draft', () => {
    sessionStorage.setItem('nearling.riddleDraft.9', 'not json');
    expect(loadRiddleDraft('9', 20757)).toBeNull();
    sessionStorage.setItem('nearling.riddleDraft.9', JSON.stringify({ day: 'x', text: 1 }));
    expect(loadRiddleDraft('9', 20757)).toBeNull();
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(loadRiddleDraft('9', 20757)).toBeNull();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(() => saveRiddleDraft('9', { day: 20757, text: 'x' })).not.toThrow();
  });
});
