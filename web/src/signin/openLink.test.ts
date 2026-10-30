// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { androidIntentFor, copyLink, linkFor } from './openLink';

afterEach(() => vi.unstubAllGlobals());

describe('linkFor', () => {
  const origin = window.location.origin;

  // spec: add-account › Sign-in data › ссылка в настоящий браузер
  it('carries the place, the mark of the in-app browser and the invitation\'s label, and nothing else', () => {
    expect(linkFor('/pet/2', 'x', 'pet_fans')).toBe(`${origin}/pet/2?ib=x&c=pet_fans`);
    expect(linkFor('/hatch?from=2', 'telegram', null)).toBe(`${origin}/hatch?from=2&ib=telegram`);
  });

  // spec: add-account › Sign-in data › ссылка в настоящий браузер × телефон без встроенного браузера
  it('has no mark of an in-app browser on a phone that is in none (the fallback path)', () => {
    expect(linkFor('/pet/2', null, null)).toBe(`${origin}/pet/2`);
    expect(linkFor('/pet/2', null, 'crypto')).toBe(`${origin}/pet/2?c=crypto`);
  });

  // spec: add-account › Sign-in data › ссылка в настоящий браузер
  it('sets the marks itself, whatever the place\'s own query says, and leaves its other parameters alone', () => {
    expect(linkFor('/pet/2?ib=evil&c=evil&from=9', 'x', null)).toBe(`${origin}/pet/2?from=9&ib=x`);
  });

  // spec: add-account › Sign-in data › ссылка в настоящий браузер × набранный текст
  it('has no way to carry a typed text: three inputs, and the place stays the only thing of the tab in it', () => {
    expect(linkFor.length).toBe(3);
    const link = linkFor('/pet/2', 'x', null);
    expect([...new URL(link).searchParams.keys()].sort()).toEqual(['ib']);
  });
});

describe('the ways to open it', () => {
  // spec: add-account › Open in browser sheet screen › success (Android)
  it('asks Android to open the address in the default browser with an intent', () => {
    expect(androidIntentFor('https://nearling.example/pet/2?ib=x&c=pet_fans')).toBe(
      'intent://nearling.example/pet/2?ib=x&c=pet_fans#Intent;scheme=https;end',
    );
  });

  // spec: add-account › Open in browser sheet screen › success (iPhone)
  it('copies the link on an iPhone, and says when the copy did not work', async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    expect(await copyLink('https://nearling.example/pet/2')).toBe(true);
    expect(writeText).toHaveBeenCalledWith('https://nearling.example/pet/2');
    writeText.mockRejectedValueOnce(new Error('denied'));
    expect(await copyLink('https://nearling.example/pet/2')).toBe(false);
  });
});
