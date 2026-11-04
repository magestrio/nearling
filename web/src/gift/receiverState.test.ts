import { expect, it } from 'vitest';
import { receiverState } from './receiverState';
import type { PublicGift } from '../seams/worker-types';

const gift = (status: PublicGift['status'], viewer: PublicGift['viewer']): PublicGift => ({
  tokenId: '9', name: 'Pixel', fullness: { state: 'full', level: 1 }, status, viewer, errand: null,
});

// spec: add-gift › Gift screen › signed-out (подарок уже принят)
// spec: add-gift › Gift screen › ссылку открыл дарящий
// spec: add-gift › Gift accept flow › получил без него
it('keeps a held gift behind sign-in, shows the giver their own link and gives the receiver their result', () => {
  expect(receiverState(gift('accepted', 'visitor'), false)).toBe('signed-out-held');
  expect(receiverState(gift('transferred', 'visitor'), false)).toBe('signed-out-held');
  expect(receiverState(gift('waiting', 'giver'), true)).toBe('giver');
  expect(receiverState(gift('accepted', 'receiver'), true)).toBe('accepted');
  expect(receiverState(gift('transferred', 'receiver'), true)).toBe('received');
});

// spec: add-gift › Gift screen › success
// spec: add-gift › Gift screen › signed-out
it('keeps an unaccepted gift open for a signed-in friend or a visitor', () => {
  expect(receiverState(gift('waiting', 'receiver'), true)).toBe('offered');
  expect(receiverState(gift('waiting', 'visitor'), false)).toBe('offered');
});
