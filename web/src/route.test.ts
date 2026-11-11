import { describe, expect, it } from 'vitest';
import { adaptersPath, diaryPath, hatchPath, parseRoute, petPath, relationshipsPath, sharedErrandPath, wardrobePath, verifyPath } from './route';

describe('parseRoute', () => {
  // spec: add-any-chain-feed › Cross-chain payment status screen › loading
  it('accepts only a pet-bound opaque any-chain payment status address', () => {
    const id = 'a'.repeat(32);
    expect(parseRoute(`/pet/9/feed/status/${id}`)).toEqual({ name: 'feed-status', tokenId: '9', paymentId: id });
    expect(parseRoute('/pet/9/feed/status/short').name).toBe('unknown');
  });
  // spec: add-pet-society › Society summary screen › success
  it('routes only a pet token to its relationship summary', () => {
    expect(parseRoute('/pet/9/relationships')).toEqual({ name: 'relationships', tokenId: '9' });
    expect(parseRoute('/pet/nine/relationships').name).toBe('unknown');
    expect(relationshipsPath('9')).toBe('/pet/9/relationships');
  });
  it('reads the Pet screen and the Hatch screen with the friend in the address', () => {
    expect(parseRoute('/pet/9')).toEqual({ name: 'pet', tokenId: '9', from: null });
    expect(parseRoute('/pet/9?from=2')).toEqual({ name: 'pet', tokenId: '9', from: '2' });
    expect(parseRoute('/hatch')).toEqual({ name: 'hatch', from: null });
    expect(parseRoute('/hatch?from=2')).toEqual({ name: 'hatch', from: '2' });
    expect(parseRoute('/')).toEqual({ name: 'home' });
    expect(parseRoute('/__day1')).toEqual({ name: 'day1' });
  });

  // spec: add-gift › Gift screen › loading
  // spec: add-gift › Gift screen › error
  it('reads a gift code and sends a cut or malformed gift link to its error state', () => {
    expect(parseRoute(`/gift/${'a'.repeat(48)}`)).toEqual({ name: 'gift', code: 'a'.repeat(48) });
    expect(parseRoute('/gift/short')).toEqual({ name: 'gift', code: '' });
    expect(parseRoute('/gift')).toEqual({ name: 'gift', code: '' });
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
    expect(parseRoute('/somewhere')).toEqual({ name: 'unknown' });
  });

  // spec: add-daily-ritual › Diary screen › success
  it('reads the Diary screen at /pet/<token_id>/diary, with a trailing slash too, and no other address as one', () => {
    expect(parseRoute('/pet/9/diary')).toEqual({ name: 'diary', tokenId: '9' });
    expect(parseRoute('/pet/9/diary/')).toEqual({ name: 'diary', tokenId: '9' });
    expect(parseRoute('/pet/abc/diary')).toEqual({ name: 'unknown' });
    expect(parseRoute('/pet/9/diary/extra')).toEqual({ name: 'unknown' });
    expect(diaryPath('9')).toBe('/pet/9/diary');
  });

  // spec: add-wardrobe › Wardrobe screen › success
  it('reads the Wardrobe screen at /pet/<token_id>/wardrobe, with a trailing slash too, and no other address as one', () => {
    expect(parseRoute('/pet/9/wardrobe')).toEqual({ name: 'wardrobe', tokenId: '9' });
    expect(parseRoute('/pet/9/wardrobe/')).toEqual({ name: 'wardrobe', tokenId: '9' });
    expect(parseRoute('/pet/abc/wardrobe')).toEqual({ name: 'unknown' });
    expect(parseRoute('/pet/9/wardrobe/extra')).toEqual({ name: 'unknown' });
    expect(wardrobePath('9')).toBe('/pet/9/wardrobe');
  });

  // spec: add-pet-errands › Adapter catalog screen › success
  it('reads the Adapter catalog at /adapters, with the pet of the skill it was opened from, and no pet for a mangled one', () => {
    expect(parseRoute('/adapters')).toEqual({ name: 'adapters', pet: null });
    expect(parseRoute('/adapters/')).toEqual({ name: 'adapters', pet: null });
    expect(parseRoute('/adapters?pet=9')).toEqual({ name: 'adapters', pet: '9' });
    expect(parseRoute('/adapters?pet=nine')).toEqual({ name: 'adapters', pet: null });
    expect(parseRoute('/adapters/9')).toEqual({ name: 'unknown' });
    expect(adaptersPath('9')).toBe('/adapters?pet=9');
    expect(adaptersPath()).toBe('/adapters');
  });

  // spec: add-pet-errands › Shared errand screen › success
  it('reads only a full shared errand code and builds its public route', () => {
    const code = 'a'.repeat(64);
    expect(parseRoute(`/pet/9/errand/${code}`)).toEqual({ name: 'shared-errand', tokenId: '9', code });
    expect(parseRoute('/pet/9/errand/short')).toEqual({ name: 'unknown' });
    expect(sharedErrandPath('9', code)).toBe(`/pet/9/errand/${code}`);
  });

  // spec: add-verification › Verification screen › success
  // spec: add-verification › Receipt link flow › visitor opens link
  it('reads record, selected thought and one shared receipt addresses', () => {
    const thought = 'a'.repeat(24);
    const code = 'b'.repeat(64);
    expect(parseRoute('/pet/9/verify')).toEqual({ name: 'verify', tokenId: '9', thoughtId: null });
    expect(parseRoute(`/pet/9/verify/${thought}`)).toEqual({ name: 'verify', tokenId: '9', thoughtId: thought });
    expect(parseRoute(`/receipt/${code}`)).toEqual({ name: 'receipt', code });
    expect(parseRoute('/pet/9/verify/short')).toEqual({ name: 'unknown' });
    expect(verifyPath('9', thought)).toBe(`/pet/9/verify/${thought}`);
  });

  it('builds the paths it reads', () => {
    expect(petPath('9', '2')).toBe('/pet/9?from=2');
    expect(petPath('9')).toBe('/pet/9');
    expect(hatchPath('2')).toBe('/hatch?from=2');
    expect(hatchPath()).toBe('/hatch');
  });
});
