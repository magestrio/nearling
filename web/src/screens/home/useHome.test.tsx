// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthContext, type AuthApi } from '../../seams/auth-context';
import { WorkerError } from '../../seams/worker-types';
import { useHome } from './useHome';
import { go } from '../../route';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({ signInState: vi.fn(), me: vi.fn(), track: vi.fn(), endSession: vi.fn() }));
vi.mock('../../seams/worker', async (original) => ({
  ...(await original<typeof import('../../seams/worker')>()),
  workerApi: { signInState: mocks.signInState, me: mocks.me },
}));
vi.mock('../../track', () => ({ track: mocks.track }));

const UNTIL = '2026-12-01T00:00:00.000Z';
const PETLESS = { accountId: 'a', hatched: { tokenId: '9', name: 'Pixel' }, currentPet: null, ownedCount: 0,
  knownPets: [{ tokenId: '9', name: 'Pixel', asleep: false }], birth: { open: true } };
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
  // spec: add-showcase › Public demo flow › README numbers link with a session
  it('keeps the public numbers URL visible without reading the player pet', async () => {
    window.history.replaceState(null, '', '/?showcase=numbers');
    await show(auth({ authenticated: true }));
    expect(window.location.pathname + window.location.search).toBe('/?showcase=numbers');
    expect(home.view).toEqual({ kind: 'evidence' });
    expect(mocks.me).not.toHaveBeenCalled();
    mocks.me.mockResolvedValue({ accountId: 'a', hatched: null, currentPet: { tokenId: '9', name: 'Pixel' }, ownedCount: 1 });
    await act(async () => go('/'));
    expect(window.location.pathname).toBe('/pet/9');
  });

  // spec: add-account › Home screen › success
  it('is led to the current pet', async () => {
    mocks.me.mockResolvedValue({ accountId: 'a', hatched: null, currentPet: { tokenId: '9', name: 'Pixel' }, ownedCount: 1 });
    await show(auth({ authenticated: true }));
    expect(window.location.pathname).toBe('/pet/9');
    expect(home.view).toEqual({ kind: 'leaving' });
    expect(mocks.signInState).not.toHaveBeenCalled();
  });

  // spec: add-hatch-again › Petless Home screen › success
  it('stays on Home with fresh known links and birth status after giving away the last pet', async () => {
    mocks.me.mockResolvedValue(PETLESS);
    await show(auth({ authenticated: true }));
    expect(window.location.pathname).toBe('/');
    expect(home.view).toEqual({ kind: 'petless', knownPets: PETLESS.knownPets, birth: PETLESS.birth });
  });

  // spec: add-hatch-again › Petless Home screen › empty
  it('shows no known links when a fresh zero-owner read has none', async () => {
    mocks.me.mockResolvedValue({ ...PETLESS, knownPets: [] });
    await show(auth({ authenticated: true }));
    expect(home.view).toEqual({ kind: 'petless', knownPets: [], birth: { open: true } });
  });

  // spec: add-hatch-again › Petless Home screen › closed birth
  it('uses the fresh closure after midnight instead of historical birth eligibility', async () => {
    mocks.me.mockResolvedValueOnce({ ...PETLESS, birth: { open: false, reason: 'daily' } })
      .mockResolvedValue({ ...PETLESS, birth: { open: true } });
    await show(auth({ authenticated: true }));
    expect(home.view.kind).toBe('petless');
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    expect(home.view).toEqual({ kind: 'petless', knownPets: PETLESS.knownPets, birth: { open: true } });
    expect(mocks.me).toHaveBeenCalledTimes(2);
  });

  // spec: add-hatch-again › Petless Home screen › closed birth × 00:00 UTC
  it('checks birth status again at the UTC day boundary', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-10T23:59:59.000Z'));
    try {
      mocks.me.mockResolvedValueOnce({ ...PETLESS, birth: { open: false, reason: 'daily' } })
        .mockResolvedValue({ ...PETLESS, birth: { open: true } });
      await show(auth({ authenticated: true }));
      await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
      expect(mocks.me).toHaveBeenCalledTimes(2);
      expect(home.view).toEqual({ kind: 'petless', knownPets: PETLESS.knownPets, birth: { open: true } });
    } finally {
      vi.useRealTimers();
    }
  });

  // spec: add-hatch-again › Petless Home screen › closed birth × 00:00 UTC
  it('keeps checking a daily closure when the browser clock is ahead of the Worker', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-11T02:00:00.000Z'));
    try {
      mocks.me.mockResolvedValueOnce({ ...PETLESS, serverTime: '2026-11-10T23:59:55.000Z', birth: { open: false, reason: 'daily', until: '2026-11-11T00:00:00.000Z' } })
        .mockResolvedValue({ ...PETLESS, birth: { open: true } });
      await show(auth({ authenticated: true }));
      await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
      expect(mocks.me).toHaveBeenCalledTimes(1);
      await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
      expect(mocks.me).toHaveBeenCalledTimes(2);
      expect(home.view).toEqual({ kind: 'petless', knownPets: PETLESS.knownPets, birth: { open: true } });
    } finally {
      vi.useRealTimers();
    }
  });

  // spec: add-hatch-again › Petless Home screen › closed birth × 00:00 UTC
  it('retries a missed boundary read after the Worker briefly fails', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-11T02:00:00.000Z'));
    try {
      mocks.me.mockResolvedValueOnce({ ...PETLESS, serverTime: '2026-11-10T23:59:55.000Z', birth: { open: false, reason: 'daily', until: '2026-11-11T00:00:00.000Z' } })
        .mockRejectedValueOnce(new WorkerError(503, 'chain_unreachable'))
        .mockResolvedValue({ ...PETLESS, birth: { open: true } });
      await show(auth({ authenticated: true }));
      await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
      expect(home.view.kind).toBe('petless-error');
      await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
      expect(mocks.me).toHaveBeenCalledTimes(3);
      expect(home.view).toEqual({ kind: 'petless', knownPets: PETLESS.knownPets, birth: { open: true } });
    } finally {
      vi.useRealTimers();
    }
  });

  // spec: add-hatch-again › Petless Home screen › success × reload
  it('re-reads current ownership and links on a new Home mount', async () => {
    mocks.me.mockResolvedValueOnce(PETLESS).mockResolvedValue({ ...PETLESS, knownPets: [] });
    await show(auth({ authenticated: true }));
    await act(async () => root?.unmount());
    root = null;
    await show(auth({ authenticated: true }));
    expect(mocks.me).toHaveBeenCalledTimes(2);
    expect(home.view).toEqual({ kind: 'petless', knownPets: [], birth: { open: true } });
  });

  // spec: add-hatch-again › Petless Home screen › success × receive gift
  it('leads a player to their current pet after a gift arrives', async () => {
    mocks.me.mockResolvedValueOnce(PETLESS).mockResolvedValue({ ...PETLESS, ownedCount: 1, currentPet: { tokenId: '2', name: 'Biscuit' } });
    await show(auth({ authenticated: true }));
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    expect(window.location.pathname).toBe('/pet/2');
  });

  // spec: add-hatch-again › Petless Home screen › signed-out × sign-out
  it('drops private known links when the session ends', async () => {
    mocks.me.mockResolvedValue(PETLESS);
    await show(auth({ authenticated: true }));
    expect(home.view.kind).toBe('petless');
    mocks.signInState.mockResolvedValue({ state: 'open' });
    await show(auth());
    expect(home.view).toEqual({ kind: 'signed-out' });
  });

  // spec: add-hatch-again › Petless Home screen › error
  it('does not guess ownership when the current read fails', async () => {
    mocks.me.mockRejectedValue(new WorkerError(503, 'chain_unreachable'));
    await show(auth({ authenticated: true }));
    expect(home.view).toEqual({ kind: 'petless-error' });
    mocks.me.mockResolvedValue(PETLESS);
    await act(async () => home.tryAgain());
    expect(home.view.kind).toBe('petless');
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
    expect(home.view).toEqual({ kind: 'petless-loading' });
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
    expect(home.view).toEqual({ kind: 'petless-error' });
    await act(async () => home.tryAgain());
    expect(retrySession).toHaveBeenCalledTimes(1);
    expect(mocks.signInState).not.toHaveBeenCalled();
  });
});
