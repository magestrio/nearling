import { describe, expect, it } from 'vitest';
import { hatchPath, parseRoute, petPath } from './route';

describe('parseRoute', () => {
  it('reads the Pet screen and the Hatch screen with the friend in the address', () => {
    expect(parseRoute('/pet/9')).toEqual({ name: 'pet', tokenId: '9', from: null });
    expect(parseRoute('/pet/9?from=2')).toEqual({ name: 'pet', tokenId: '9', from: '2' });
    expect(parseRoute('/hatch')).toEqual({ name: 'hatch', from: null });
    expect(parseRoute('/hatch?from=2')).toEqual({ name: 'hatch', from: '2' });
    expect(parseRoute('/')).toEqual({ name: 'home' });
    expect(parseRoute('/__day1')).toEqual({ name: 'day1' });
  });

  it('takes a ?from= that is not a token_id for no friend', () => {
    expect(parseRoute('/hatch?from=abc')).toEqual({ name: 'hatch', from: null });
    expect(parseRoute('/hatch?from=')).toEqual({ name: 'hatch', from: null });
  });

  // spec: add-pet › Pet screen › error
  it('takes a cut or mangled pet link for the dead-link page, and leaves the other surfaces of a pet alone', () => {
    expect(parseRoute('/pet/x')).toEqual({ name: 'pet-broken' });
    expect(parseRoute('/pet/abc')).toEqual({ name: 'pet-broken' });
    expect(parseRoute('/pet')).toEqual({ name: 'pet-broken' });
    expect(parseRoute('/pet/')).toEqual({ name: 'pet-broken' });
    expect(parseRoute('/pet/123456789012345678901')).toEqual({ name: 'pet-broken' });
    expect(parseRoute('/pet/9/diary')).toEqual({ name: 'unknown' });
    expect(parseRoute('/somewhere')).toEqual({ name: 'unknown' });
  });

  it('builds the paths it reads', () => {
    expect(petPath('9', '2')).toBe('/pet/9?from=2');
    expect(petPath('9')).toBe('/pet/9');
    expect(hatchPath('2')).toBe('/hatch?from=2');
    expect(hatchPath()).toBe('/hatch');
  });
});
