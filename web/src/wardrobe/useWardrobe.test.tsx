// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthContext, type AuthApi } from '../seams/auth-context';
import { WorkerError, type WardrobeView } from '../seams/worker-types';
import { useWardrobe } from './useWardrobe';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({ wardrobe: vi.fn(), wear: vi.fn(), endSession: vi.fn() }));
vi.mock('../seams/worker', async (original) => ({
  ...(await original<typeof import('../seams/worker')>()),
  workerApi: { wardrobe: mocks.wardrobe, wear: mocks.wear },
}));

const view = (worn: WardrobeView['worn']): WardrobeView => ({
  owned: ['thinking-cap', 'daisy-crown'],
  worn,
  price: { cents: 0.76, yocto: '1660000000000000000000' },
  short: false,
  shopPaused: false,
  buying: null,
  outcome: null,
});

const auth = {
  ready: true,
  authenticated: true,
  nearAccountId: 'a'.repeat(64),
  async getIdentityToken() {
    return 'identity-token';
  },
  sessionEnded: false,
  sessionLine: false,
  endSession: mocks.endSession,
  needSession: () => true,
} as unknown as AuthApi;

let root: Root | null = null;
let w: ReturnType<typeof useWardrobe>;
// the Pet screen's callbacks are stable; new ones each render would read the wardrobe afresh each render
const reread = () => undefined;
const askLook = () => undefined;
function Probe() {
  w = useWardrobe({ tokenId: '9', active: true, reread, askLook });
  return null;
}
async function show() {
  await act(async () => {
    root = createRoot(document.createElement('div'));
    root.render(
      <AuthContext.Provider value={auth}>
        <Probe />
      </AuthContext.Provider>,
    );
  });
}
const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
});

describe('a poll that began before a wear', () => {
  // spec: add-wardrobe › Outfit rule › надел
  it('does not put the old outfit back over the answer of the wear', async () => {
    mocks.wardrobe.mockResolvedValueOnce(view('thinking-cap'));
    await show();
    await vi.waitFor(() => expect(w.view?.worn).toBe('thinking-cap'));
    // a poll is on its way with the old outfit ...
    const poll = deferred<WardrobeView>();
    mocks.wardrobe.mockReturnValueOnce(poll.promise);
    await act(async () => void document.dispatchEvent(new Event('visibilitychange')));
    expect(mocks.wardrobe).toHaveBeenCalledTimes(2);
    // ... when «Wear» lands
    mocks.wear.mockResolvedValueOnce({ worn: 'daisy-crown' });
    await act(async () => w.wear('daisy-crown', 'daisy-crown'));
    expect(w.view?.worn).toBe('daisy-crown');
    await act(async () => poll.resolve(view('thinking-cap')));
    expect(w.view?.worn).toBe('daisy-crown');
    // and the next read goes out, a poll in flight not standing in for it
    mocks.wardrobe.mockResolvedValueOnce(view('daisy-crown'));
    await act(async () => void document.dispatchEvent(new Event('visibilitychange')));
    expect(mocks.wardrobe).toHaveBeenCalledTimes(3);
  });
});

describe('a session that ended under a read', () => {
  // spec: add-wardrobe › Wardrobe screen › signed-out
  it('on the first read asks for the page\'s line, so the signed-out line and «Sign in» come', async () => {
    mocks.wardrobe.mockRejectedValueOnce(new WorkerError(401, 'signed_out'));
    await show();
    await vi.waitFor(() => expect(mocks.endSession).toHaveBeenCalledTimes(1));
    expect(mocks.endSession).toHaveBeenCalledWith(true, true);
  });

  // spec: add-wardrobe › Wardrobe screen › signed-out × no tap yet
  it('over a wardrobe already shown asks for no line: the page stands as it was', async () => {
    mocks.wardrobe.mockResolvedValueOnce(view('thinking-cap'));
    await show();
    await vi.waitFor(() => expect(w.view?.worn).toBe('thinking-cap'));
    mocks.wardrobe.mockRejectedValueOnce(new WorkerError(401, 'signed_out'));
    await act(async () => void document.dispatchEvent(new Event('visibilitychange')));
    await vi.waitFor(() => expect(mocks.endSession).toHaveBeenCalledTimes(1));
    expect(mocks.endSession).toHaveBeenCalledWith(true, false);
  });
});
