// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { GuestFeedSheet, closeGuestFeed, guestFeedNow } from './guestFeed';
import { backPay, closeAddress, closePay, payRequestNow } from './request';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLElement;
const signIn = vi.fn();
const request = { tokenId: '9', name: 'Pixel', signIn };
beforeEach(async () => {
  window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<GuestFeedSheet request={request} />));
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); closeGuestFeed(); closePay(); closeAddress(); signIn.mockReset();
});
const click = (name: string) => act(async () => {
  [...host.querySelectorAll('button')].find((button) => button.textContent === name)!.click();
});

// spec: add-any-chain-feed › Cross-chain quote flow › guest quote
it('opens the guest quote path without starting Google and Back restores Feed', async () => {
  await click('Pay from another chain');
  expect(payRequestNow()).toMatchObject({ tokenId: '9', name: 'Pixel' });
  expect(signIn).not.toHaveBeenCalled();
  await act(async () => backPay());
  expect(payRequestNow()).toBeNull();
  expect(guestFeedNow()).toBe(request);
  expect(signIn).not.toHaveBeenCalled();
});

// spec: add-any-chain-feed › Cross-chain quote flow › feed entry
it('keeps sign-in as an explicit separate action for NEAR feeding', async () => {
  await click('Sign in');
  expect(signIn).toHaveBeenCalledTimes(1);
});
