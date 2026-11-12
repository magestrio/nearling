// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { navigate } from '../route';
import { ProviderContext, useAuth, type AuthApi, type ProviderApi } from '../seams/auth-context';
import { makeTokenKeeper } from '../seams/token';
import { WorkerError } from '../seams/worker-types';
import { keepJudgeCode, readJudgeCode } from './judgeCode';
import { markSignInUnderWay, peekReturnPlace, rememberReturnPlace, signInUnderWay } from './returnPlace';
import { SessionProvider } from './session';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const worker = vi.hoisted(() => ({ session: vi.fn() }));
vi.mock('../seams/worker', async (original) => ({ ...(await original<typeof import('../seams/worker')>()), workerApi: worker }));

let root: Root | null = null;
let seen: AuthApi;
const finishRetry = async () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 700)); });

function Probe() {
  seen = useAuth();
  return null;
}

function provider(over: Partial<ProviderApi> = {}): ProviderApi {
  return {
    ready: true,
    authenticated: true,
    nearAccountId: 'player.testnet',
    walletFailed: false,
    email: 'sam@example.com',
    freshSignIn: false,
    signInError: null,
    login: vi.fn(),
    clearSignInError: vi.fn(),
    logout: vi.fn(async () => undefined),
    createNearWallet: async () => 'player.testnet',
    getIdentityToken: async () => 'identity-token',
    signNearHash: async () => new Uint8Array(64),
    ...over,
  };
}

async function show(api: ProviderApi, children?: ReactNode) {
  root ??= createRoot(document.createElement('div'));
  await act(async () => {
    root!.render(
      <ProviderContext.Provider value={api}>
        <SessionProvider>
          <Probe />
          {children}
        </SessionProvider>
      </ProviderContext.Provider>,
    );
  });
}

beforeEach(() => {
  worker.session.mockReset();
  worker.session.mockResolvedValue({ ok: true });
  markSignInUnderWay(false);
  sessionStorage.clear();
  window.history.replaceState(null, '', '/pet/9');
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
});

describe('the exchange', () => {
  // spec: add-showcase › Judge admission data › admitted Google return
  it('carries the checked bearer in the session body on a fresh judge return, then erases it', async () => {
    rememberReturnPlace({ path: '/pet/2', action: 'feed', judge: true });
    keepJudgeCode('sample-private-code');
    await show(provider({ freshSignIn: true }));
    expect(worker.session).toHaveBeenCalledWith('identity-token', { fresh: true, from: 'link', judgeCode: 'sample-private-code' });
    expect(readJudgeCode()).toBeNull();
  });
  // spec: add-account › Sign-in flow › вошёл со страницы
  it('holds the page unready while it runs, and is signed in only after the 200', async () => {
    let answer: (v: { ok: true }) => void = () => undefined;
    worker.session.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    await show(provider());
    expect(seen).toMatchObject({ ready: false, authenticated: false });
    expect(worker.session).toHaveBeenCalledTimes(1);
    expect(worker.session).toHaveBeenCalledWith('identity-token', { fresh: false });
    await act(async () => answer({ ok: true }));
    expect(seen).toMatchObject({ ready: true, authenticated: true, refusal: null, unreachable: false });
    // a render of the provider asks for nothing more
    await show(provider());
    expect(worker.session).toHaveBeenCalledTimes(1);
  });

  // spec: add-account › Sign-in flow › вошёл с главной
  it('says where a fresh sign-in began: a pet\'s address is a link, any other is home', async () => {
    rememberReturnPlace({ path: '/pet/2?from=9' });
    await show(provider({ freshSignIn: true }));
    expect(worker.session).toHaveBeenLastCalledWith('identity-token', { fresh: true, from: 'link' });

    sessionStorage.clear();
    await show(provider({ freshSignIn: true, nearAccountId: 'other.testnet' }));
    expect(worker.session).toHaveBeenLastCalledWith('identity-token', { fresh: true, from: 'home' });
  });

  it('asks nothing of a visitor', async () => {
    await show(provider({ authenticated: false, nearAccountId: null }));
    expect(worker.session).not.toHaveBeenCalled();
    expect(seen).toMatchObject({ ready: true, authenticated: false });
  });

  // spec: add-account › Sign-in flow › новый после Google × действие не продолжается
  it('ends the browser\'s session at Privy on a refusal, and keeps what the player is told', async () => {
    worker.session.mockResolvedValue({ refused: { reason: 'mau', until: '2026-12-01T00:00:00.000Z' } });
    const api = provider({ freshSignIn: true });
    await show(api);
    expect(api.logout).toHaveBeenCalledTimes(1);
    expect(seen).toMatchObject({ ready: true, authenticated: false, refusal: { reason: 'mau', until: '2026-12-01T00:00:00.000Z' } });
    // Privy has let go of the session: the refusal outlives it, and the next sign-in clears it
    await show(provider({ authenticated: false, nearAccountId: null }));
    expect(seen.refusal).toMatchObject({ reason: 'mau' });
    await act(async () => seen.login());
    expect(seen.refusal).toBeNull();
  });

  // spec: add-account › Sign-in flow › вход не удался
  it('is a failed sign-in when a fresh exchange answers 401', async () => {
    worker.session.mockRejectedValue(new WorkerError(401, 'signed_out'));
    await show(provider({ freshSignIn: true }));
    expect(seen).toMatchObject({ ready: true, authenticated: false, signInError: 'failed' });
  });

  // spec: add-account › Sign-in flow › вход не удался × Try again
  it('forgets a failed sign-in at the tap, without a new `login()`', async () => {
    worker.session.mockRejectedValue(new WorkerError(401, 'signed_out'));
    const api = provider({ freshSignIn: true });
    await show(api);
    await act(async () => seen.clearSignInError());
    expect(seen.signInError).toBeNull();
    expect(api.clearSignInError).toHaveBeenCalledTimes(1);
    expect(api.login).not.toHaveBeenCalled();
  });

  // spec: add-account › Sign-in flow › вход начат × второй тап
  it('ends a sign-in under way when a session turns up: Privy held one the tap did not know of, and no Google is coming', async () => {
    markSignInUnderWay(true);
    worker.session.mockRejectedValue(new WorkerError(401, 'signed_out'));
    await show(provider());
    expect(signInUnderWay()).toBe(false);
  });

  // spec: add-account › Session expiry flow › session ended, no tap yet × 401 на первой загрузке
  it('is a visitor, with no error, when an exchange on a page load answers 401', async () => {
    worker.session.mockRejectedValue(new WorkerError(401, 'signed_out'));
    await show(provider());
    expect(seen).toMatchObject({ ready: true, authenticated: false, signInError: null, sessionEnded: false });
  });

  // spec: add-pet › Connection rule › сервер недоступен
  it('is unreachable when the server gives no answer, and asks again on retry', async () => {
    worker.session.mockRejectedValue(new WorkerError(0, 'unreachable'));
    await show(provider());
    await finishRetry();
    expect(seen).toMatchObject({ ready: true, authenticated: false, unreachable: true });
    await act(async () => seen.retrySession());
    await finishRetry();
    expect(worker.session).toHaveBeenCalledTimes(4);
    expect(seen).toMatchObject({ authenticated: false, unreachable: true });
  });

  // spec: add-pet › Connection rule › сервер недоступен
  it('is unreachable on a 503 as well', async () => {
    worker.session.mockRejectedValue(new WorkerError(503, 'auth_unavailable'));
    await show(provider());
    await finishRetry();
    expect(seen.unreachable).toBe(true);
  });

  // spec: D-165 › transient session exchange keeps the Feed return place
  it('retries one transient exchange with the same fresh Feed return place', async () => {
    rememberReturnPlace({ path: '/pet/9', action: 'feed' });
    worker.session.mockRejectedValueOnce(new WorkerError(503, 'auth_unavailable'));
    await show(provider({ freshSignIn: true }));
    await finishRetry();
    expect(worker.session).toHaveBeenCalledTimes(2);
    expect(worker.session).toHaveBeenNthCalledWith(1, 'identity-token', { fresh: true, from: 'link' });
    expect(worker.session).toHaveBeenNthCalledWith(2, 'identity-token', { fresh: true, from: 'link' });
    expect(seen).toMatchObject({ ready: true, authenticated: true, unreachable: false });
  });

  // spec: D-165 › Privy 429/5xx during sign-in keeps the Feed return place
  it.each([429, 503])('retries a Privy %i once, then opens the session with Feed still pending', async (status) => {
    rememberReturnPlace({ path: '/pet/9', action: 'feed' });
    const askPrivy = vi.fn().mockRejectedValueOnce(Object.assign(new Error('Privy unavailable'), { status }))
      .mockResolvedValue('identity-token');
    const tokens = makeTokenKeeper(askPrivy);
    await show(provider({ freshSignIn: true, getIdentityToken: tokens.get }));
    expect(seen.ready).toBe(false);
    await finishRetry();
    expect(askPrivy).toHaveBeenCalledTimes(2);
    expect(worker.session).toHaveBeenCalledWith('identity-token', { fresh: true, from: 'link' });
    expect(seen).toMatchObject({ ready: true, authenticated: true, unreachable: false });
    expect(peekReturnPlace()).toMatchObject({ path: '/pet/9', action: 'feed' });
  });

  // spec: D-165 › Privy 429 during sign-in exhausts the bounded retry
  it('shows unreachable after the token keeper exhausts Privy 429 retries, keeping Feed pending', async () => {
    rememberReturnPlace({ path: '/pet/9', action: 'feed' });
    vi.useFakeTimers();
    try {
      const askPrivy = vi.fn().mockRejectedValue(Object.assign(new Error('rate limit'), { status: 429 }));
      const tokens = makeTokenKeeper(askPrivy);
      await show(provider({ freshSignIn: true, getIdentityToken: tokens.get }));
      await act(async () => { await vi.advanceTimersByTimeAsync(5_100); });
      expect(askPrivy).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
    expect(worker.session).not.toHaveBeenCalled();
    expect(seen).toMatchObject({ ready: true, authenticated: false, unreachable: true });
    expect(peekReturnPlace()).toMatchObject({ path: '/pet/9', action: 'feed' });
  });
});

describe('an ended session', () => {
  async function signedIn() {
    await show(provider());
    expect(seen.authenticated).toBe(true);
  }

  // spec: add-account › Session expiry flow › session ended, no tap yet × опрос видит 401
  it('holds the page as it is: still signed in, no line, until a tap', async () => {
    await signedIn();
    await act(async () => seen.endSession());
    expect(seen).toMatchObject({ authenticated: true, sessionEnded: true, sessionLine: false });
  });

  // spec: add-account › Session expiry flow › сессия кончилась при открытом экране
  it('answers the tap with the line, and the action is not sent', async () => {
    await signedIn();
    expect(seen.needSession()).toBe(true);
    await act(async () => seen.endSession());
    let allowed = true;
    await act(async () => {
      allowed = seen.needSession();
    });
    expect(allowed).toBe(false);
    expect(seen).toMatchObject({ authenticated: true, sessionLine: true });
  });

  // spec: add-account › Session expiry flow › session ended, no tap yet × переход на другой адрес
  it('lets go at the first change of address: the new screen is a visitor\'s', async () => {
    await signedIn();
    await act(async () => seen.endSession());
    expect(seen.authenticated).toBe(true);
    await act(async () => navigate('/hatch'));
    expect(seen).toMatchObject({ authenticated: false, sessionEnded: true });
  });

  // spec: add-account › Session expiry flow › session ended, no tap yet × переход на другой адрес
  it('takes the line along when it lets go: the visitor\'s next screen has none', async () => {
    await signedIn();
    await act(async () => seen.endSession());
    await act(async () => void seen.needSession());
    expect(seen.sessionLine).toBe(true);
    await act(async () => navigate('/hatch'));
    expect(seen).toMatchObject({ authenticated: false, sessionLine: false });
  });

  // spec: add-account › Session expiry flow › session ended, no tap yet × переход на другой адрес
  it('has no line to give a visitor: a late tap or a late `401` past the change of address adds none', async () => {
    await signedIn();
    await act(async () => seen.endSession());
    await act(async () => navigate('/hatch'));
    await act(async () => void seen.needSession());
    expect(seen.sessionLine).toBe(false);
    await act(async () => seen.endSession(true, true));
    expect(seen.sessionLine).toBe(false);
  });

  // spec: add-account › Session expiry flow › session ended, no tap yet × 401 на первой загрузке
  it('lets go at once when nothing was shown yet', async () => {
    await signedIn();
    await act(async () => seen.endSession(false));
    expect(seen.authenticated).toBe(false);
  });

  // spec: add-account › Session expiry flow › session ended, no tap yet × опрос видит 401
  it('is ended by a token keeper that answers null for a signed-in page', async () => {
    const api = provider();
    await show(api);
    await show({ ...api, getIdentityToken: async () => null });
    await act(async () => void (await seen.getIdentityToken()));
    expect(seen).toMatchObject({ authenticated: true, sessionEnded: true });
  });

  // spec: add-account › Session expiry flow › session ended, no tap yet × вторая вкладка после выхода
  it('is ended when the provider\'s own session goes from under an open page', async () => {
    await signedIn();
    await show(provider({ authenticated: false, nearAccountId: null }));
    expect(seen).toMatchObject({ authenticated: true, sessionEnded: true });
  });

  // spec: add-account › Sign-out flow › вышел
  it('is a visitor after a sign-out of this tab, with nothing held', async () => {
    const api = provider();
    await show(api);
    await act(async () => seen.logout());
    expect(api.logout).toHaveBeenCalled();
    expect(seen).toMatchObject({ authenticated: false, sessionEnded: false, sessionLine: false });
  });

  // spec: add-account › Session expiry flow › сессия кончилась при открытом экране
  it('is signed in again by the next exchange: the hold and the line are cleared', async () => {
    await signedIn();
    await act(async () => seen.endSession());
    await act(async () => navigate('/hatch'));
    expect(seen.authenticated).toBe(false);
    // the player signs in again: a fresh exchange for the same account
    await show(provider({ freshSignIn: true }));
    expect(seen).toMatchObject({ authenticated: true, sessionEnded: false, sessionLine: false });
  });
});
