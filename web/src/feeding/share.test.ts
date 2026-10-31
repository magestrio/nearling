// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock('../track', () => ({ track: mocks.track }));

import { feedLink, inviteText, shareFeedLink, whole } from './share';

const origin = window.location.origin;

beforeEach(() => mocks.track.mockReset());
afterEach(() => vi.unstubAllGlobals());

const stubNavigator = (over: Record<string, unknown>) => vi.stubGlobal('navigator', over);

describe('the feed link', () => {
  // spec: add-feeding › Feed link share data › ссылка ушла
  it('is the pet\'s address with the feed mark and nothing else: no account, no tab id, no in-app mark', () => {
    expect(feedLink('9')).toBe(`${origin}/pet/9?via=feed`);
    expect([...new URL(feedLink('9')).searchParams.keys()]).toEqual(['via']);
    // the text names the pet by its own name, never «your {my_pet}»: the friend who reads it is not its owner
    expect(inviteText('Pixel')).toBe('Pixel could use a snack! Feed Pixel here:');
    expect(whole('9', 'Pixel')).toBe(`Pixel could use a snack! Feed Pixel here: ${origin}/pet/9?via=feed`);
  });
});

describe('«Ask friends to feed {name}»', () => {
  // spec: add-feeding › Feed link sharing flow › делится
  // spec: add-feeding › Feed link share data › ссылка ушла
  it('hands the system menu the link and the text, and nothing else; the event goes once, without an address or a token_id', async () => {
    const share = vi.fn(async () => undefined);
    const writeText = vi.fn(async () => undefined);
    stubNavigator({ share, clipboard: { writeText } });
    expect(await shareFeedLink('9', 'Pixel')).toBe('shared');
    expect(share).toHaveBeenCalledTimes(1);
    expect(share).toHaveBeenCalledWith({ text: 'Pixel could use a snack! Feed Pixel here:', url: `${origin}/pet/9?via=feed` });
    expect(writeText).not.toHaveBeenCalled();
    expect(mocks.track).toHaveBeenCalledTimes(1);
    expect(mocks.track).toHaveBeenCalledWith('feed_link_shared');
  });

  // spec: add-feeding › Feed link sharing flow › делится
  it('the player closing the menu (AbortError) changes nothing: no copy, no message', async () => {
    const writeText = vi.fn(async () => undefined);
    stubNavigator({ share: vi.fn(async () => Promise.reject(new DOMException('closed', 'AbortError'))), clipboard: { writeText } });
    expect(await shareFeedLink('9', 'Pixel')).toBe('cancelled');
    expect(writeText).not.toHaveBeenCalled();
  });

  // spec: add-feeding › Feed link sharing flow › делится
  it('a browser with no menu copies the link with its text', async () => {
    const writeText = vi.fn(async () => undefined);
    stubNavigator({ clipboard: { writeText } });
    expect(await shareFeedLink('9', 'Pixel')).toBe('copied');
    expect(writeText).toHaveBeenCalledWith(`Pixel could use a snack! Feed Pixel here: ${origin}/pet/9?via=feed`);
  });

  // spec: add-feeding › Feed link sharing flow › делится
  it('any other refusal of the menu falls to the copy', async () => {
    const writeText = vi.fn(async () => undefined);
    stubNavigator({ share: vi.fn(async () => Promise.reject(new DOMException('no', 'NotAllowedError'))), clipboard: { writeText } });
    expect(await shareFeedLink('9', 'Pixel')).toBe('copied');
    expect(writeText).toHaveBeenCalledTimes(1);
  });

  // spec: add-feeding › Feed link sharing flow › скопировать не вышло
  it('with no menu and a copy that fails, the player is left with the text to select', async () => {
    stubNavigator({ clipboard: { writeText: vi.fn(async () => Promise.reject(new Error('denied'))) } });
    expect(await shareFeedLink('9', 'Pixel')).toBe('manual');
    // no clipboard at all is the same
    stubNavigator({});
    expect(await shareFeedLink('9', 'Pixel')).toBe('manual');
    expect(mocks.track).toHaveBeenCalledTimes(2);
  });
});
