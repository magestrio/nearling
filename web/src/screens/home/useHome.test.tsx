// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthContext, type AuthApi } from '../../seams/auth-context';
import { WorkerError } from '../../seams/worker-types';
import { useHome } from './useHome';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({ signInState: vi.fn(), me: vi.fn(), track: vi.fn(), endSession: vi.fn() }));
vi.mock('../../seams/worker', async (original) => ({
  ...(await original<typeof import('../../seams/worker')>()),
  workerApi: { signInState: mocks.signInState, me: mocks.me },
}));
vi.mock('../../track', () => ({ track: mocks.track }));

const UNTIL = '2026-12-01T00:00:00.000Z';
let root: Root | null = null;
let home: ReturnType<typeof useHome>;

function Probe() {
  home = useHome();
  return null;
}

const auth = (over: Partial<AuthApi> = {}): AuthApi => ({
  ready: true,
  authenticated: false,
  nearAccountId: null,
  walletFailed: false,
  email: null,
  freshSignIn: false,
  signInError: null,
  login() {},
  clearSignInError() {},
  async logout() {},
  async createNearWallet() {
    return 'a';
  },
  async getIdentityToken() {
    return 'identity-token';
  },
  async signNearHash() {
    return new Uint8Array(64);
  },
  refusal: null,
  unreachable: false,
  retrySession() {},
  sessionEnded: false,
  sessionLine: false,
  endSession: mocks.endSession,
  needSession: () => true,
  ...over,
});

async function show(api: AuthApi) {
  root ??= createRoot(document.createElement('div'));
  await act(async () => {
    root!.render(
      <AuthContext.Provider value={api}>
        <Probe />
      </AuthContext.Provider>,
    );
  });
}

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  window.history.replaceState(null, '', '/');
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
});

describe('the closed view', () => {
  // spec: add-account › Home screen › signed-out (вход закрыт)
  it('tells the event once per load, with the reason of the answer: mau for closed to new players', async () => {
    mocks.signInState.mockResolvedValue({ state: 'closed_new', until: UNTIL });
    await show(auth());
    expect(home.view).toEqual({ kind: 'closed', all: false, until: UNTIL });
    expect(mocks.track).toHaveBeenCalledTimes(1);
    expect(mocks.track).toHaveBeenCalledWith('sign_in_blocked', { reason: 'mau', step: 'before_google', from: 'home' });
    // a render of the page tells nothing more
    await show(auth());
    expect(mocks.track).toHaveBeenCalledTimes(1);
  });

  // spec: add-account › Home screen › signed-out (вход закрыт)
  it('ceiling for closed to everyone', async () => {
    mocks.signInState.mockResolvedValue({ state: 'closed_all', until: UNTIL });
    await show(auth());
    expect(home.view).toEqual({ kind: 'closed', all: true, until: UNTIL });
    expect(mocks.track).toHaveBeenCalledWith('sign_in_blocked', { reason: 'ceiling', step: 'before_google', from: 'home' });
  });

  // spec: add-account › Home screen › signed-out
  it('tells nothing while sign-in is open', async () => {
    mocks.signInState.mockResolvedValue({ state: 'open' });
    await show(auth());
    expect(home.view).toEqual({ kind: 'signed-out' });
    expect(mocks.track).not.toHaveBeenCalled();
  });
});

describe('a signed-in player', () => {
  // spec: add-account › Home screen › success
  it('is led to the current pet, and to the Hatch screen with none', async () => {
    mocks.me.mockResolvedValue({ accountId: 'a', hatched: null, currentPet: { tokenId: '9', name: 'Pixel' }, ownedCount: 1 });
    await show(auth({ authenticated: true }));
    expect(window.location.pathname).toBe('/pet/9');
    expect(home.view).toEqual({ kind: 'leaving' });
    expect(mocks.signInState).not.toHaveBeenCalled();
  });

  // spec: add-account › Home screen › success
  it('is led to the Hatch screen with no current pet', async () => {
    mocks.me.mockResolvedValue({ accountId: 'a', hatched: null, currentPet: null, ownedCount: 0 });
    await show(auth({ authenticated: true }));
    expect(window.location.pathname).toBe('/hatch');
  });

  // spec: add-account › Home screen › success
  it('is not asked who they are while `ReturnToPlace` has moved the address on', async () => {
    window.history.replaceState(null, '', '/pet/2');
    await show(auth({ authenticated: true }));
    expect(mocks.me).not.toHaveBeenCalled();
  });

  // spec: add-account › Session expiry flow › session ended, no tap yet × 401 на первой загрузке
  it('a 401 on the first read ends the session at once, with nothing held', async () => {
    mocks.me.mockRejectedValue(new WorkerError(401, 'signed_out'));
    await show(auth({ authenticated: true }));
    expect(mocks.endSession).toHaveBeenCalledWith(false);
    expect(home.view).toEqual({ kind: 'loading' });
  });
});

describe('the page that cannot be read', () => {
  // spec: add-account › Home screen › error
  it('is the error, busy for a 429', async () => {
    mocks.signInState.mockRejectedValue(new WorkerError(429, 'rate_limited'));
    await show(auth());
    expect(home.view).toEqual({ kind: 'error', busy: true });
    mocks.signInState.mockRejectedValue(new WorkerError(0, 'unreachable'));
    await act(async () => home.tryAgain());
    expect(home.view).toEqual({ kind: 'error', busy: false });
  });

  // spec: add-account › Home screen › error × Try again
  it('«Try again» asks the exchange again when it was the exchange that got no answer', async () => {
    const retrySession = vi.fn();
    await show(auth({ authenticated: true, unreachable: true, retrySession }));
    expect(home.view).toEqual({ kind: 'error', busy: false });
    await act(async () => home.tryAgain());
    expect(retrySession).toHaveBeenCalledTimes(1);
    expect(mocks.signInState).not.toHaveBeenCalled();
  });
});
