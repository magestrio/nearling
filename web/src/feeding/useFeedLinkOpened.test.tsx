// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ track: vi.fn(), auth: { freshSignIn: false } }));
vi.mock('../track', () => ({ track: mocks.track }));
vi.mock('../seams/auth', () => ({ useAuth: () => mocks.auth }));

import { useFeedLinkOpened } from './useFeedLinkOpened';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Screen() {
  useFeedLinkOpened();
  return null;
}

let root: Root | null = null;
async function mount() {
  const host = document.createElement('div');
  root = createRoot(host);
  await act(async () => root!.render(<Screen />));
}

beforeEach(() => {
  mocks.track.mockReset();
  mocks.auth.freshSignIn = false;
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  window.history.replaceState(null, '', '/');
});

describe('the feed link opened', () => {
  // spec: add-feeding › Feed link sharing flow › ссылку открыли
  it('counts the opening of /pet/<id>?via=feed once, at the mount, with nothing about who shared it', async () => {
    window.history.replaceState(null, '', '/pet/9?via=feed');
    await mount();
    expect(mocks.track).toHaveBeenCalledTimes(1);
    expect(mocks.track).toHaveBeenCalledWith('feed_link_opened');
    // a render of the same screen counts nothing more
    await act(async () => root!.render(<Screen />));
    expect(mocks.track).toHaveBeenCalledTimes(1);
  });

  // spec: add-feeding › Feed link sharing flow › ссылку открыли
  it('counts nothing for a pet\'s address with no mark, and nothing on the return from Google', async () => {
    window.history.replaceState(null, '', '/pet/9');
    await mount();
    expect(mocks.track).not.toHaveBeenCalled();
    await act(async () => root?.unmount());
    root = null;
    window.history.replaceState(null, '', '/pet/9?via=feed');
    mocks.auth.freshSignIn = true;
    await mount();
    expect(mocks.track).not.toHaveBeenCalled();
  });
});
