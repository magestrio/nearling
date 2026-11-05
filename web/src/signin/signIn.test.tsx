// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthContext, type AuthApi } from '../seams/auth-context';
import { WorkerError } from '../seams/worker-types';
import { markSignInUnderWay, peekReturnPlace, rememberReturnPlace, signInUnderWay } from './returnPlace';
import { SignInLayer, useSignIn, type SignInApi } from './signIn';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({ signInState: vi.fn(), judgeCheck: vi.fn(), track: vi.fn(), login: vi.fn(), clearSignInError: vi.fn() }));
vi.mock('../seams/worker', async (original) => ({ ...(await original<typeof import('../seams/worker')>()), workerApi: { signInState: mocks.signInState, judgeCheck: mocks.judgeCheck } }));
vi.mock('../track', () => ({ track: mocks.track }));

const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const CLOSED = '2026-12-01T00:00:00.000Z';

let root: Root | null = null;
let host: HTMLDivElement;
let sign: SignInApi;

function Probe() {
  sign = useSignIn();
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
  login: mocks.login,
  clearSignInError: mocks.clearSignInError,
  async logout() {},
  async createNearWallet() {
    return 'a';
  },
  async getIdentityToken() {
    return null;
  },
  async signNearHash() {
    return new Uint8Array(64);
  },
  refusal: null,
  unreachable: false,
  retrySession() {},
  sessionEnded: false,
  sessionLine: false,
  endSession() {},
  needSession: () => true,
  ...over,
});

async function mount(over: Partial<AuthApi> = {}) {
  if (!root) { host = document.createElement('div'); root = createRoot(host); }
  await act(async () => {
    root!.render(
      <AuthContext.Provider value={auth(over)}>
        <SignInLayer>
          <Probe />
        </SignInLayer>
      </AuthContext.Provider>,
    );
  });
}

/** the tap, and what comes of the gate read */
async function tap(...args: Parameters<SignInApi['begin']>) {
  await act(async () => sign.begin(...args));
}

function userAgent(value: string) {
  Object.defineProperty(navigator, 'userAgent', { value, configurable: true });
}

const DESKTOP_UA = navigator.userAgent;

beforeEach(() => {
  mocks.signInState.mockReset();
  mocks.signInState.mockResolvedValue({ state: 'open' });
  mocks.judgeCheck.mockReset();
  mocks.judgeCheck.mockResolvedValue({ ok: true });
  mocks.track.mockReset();
  mocks.login.mockReset();
  mocks.clearSignInError.mockReset();
  markSignInUnderWay(false);
  sessionStorage.clear();
  window.history.replaceState(null, '', '/pet/9');
  userAgent(DESKTOP_UA);
  // `SignInLayer` asks whether the viewport is a desktop (the sheets' modality); jsdom has no media queries
  window.matchMedia = ((query: string) => ({ matches: true, media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  userAgent(DESKTOP_UA);
});

describe('begin', () => {
  // spec: add-account › Sign-in return data › вход со ссылки подарка
  it('puts the place and the action in the tab and starts Google, for a place that is not a pet\'s page', async () => {
    window.history.replaceState(null, '', '/gift/abc123?c=pet_fans');
    await mount();
    await tap('signin');
    expect(peekReturnPlace()).toEqual({ path: '/gift/abc123?c=pet_fans', action: 'signin' });
    expect(mocks.login).toHaveBeenCalledTimes(1);
    expect(mocks.track).toHaveBeenCalledWith('sign_in_started', { from: 'link', in_app: 'none' });
    // Privy gets `/` from the provider, at the moment it reads it (auth.privy.test.tsx); the tab's address stays the place's
    expect(window.location.pathname).toBe('/gift/abc123');
  });

  // spec: add-account › Sign-in flow › вошёл с главной × старое место вкладки
  it('marks a tap on Home as Home\'s in the tab, in place of the record an earlier sign-in left', async () => {
    rememberReturnPlace({ path: '/pet/9', action: 'feed', cancelled: true });
    window.history.replaceState(null, '', '/');
    await mount();
    await tap('signin');
    expect(peekReturnPlace()).toEqual({ path: '/', action: 'signin' });
    expect(mocks.login).toHaveBeenCalledTimes(1);
    expect(mocks.track).toHaveBeenCalledWith('sign_in_started', { from: 'home', in_app: 'none' });
  });

  // spec: add-account › Sign-in flow › отменил вход × Sign in сохраняет Feed
  it('keeps the tapped «Feed» when «Sign in» is tapped at the same place after a cancel, and nothing else', async () => {
    await mount();
    rememberReturnPlace({ path: '/pet/9', action: 'feed', cancelled: true });
    await tap('signin');
    expect(peekReturnPlace()).toEqual({ path: '/pet/9', action: 'feed' });

    // that sign-in came back cancelled, from another place
    markSignInUnderWay(false);
    rememberReturnPlace({ path: '/pet/2', action: 'feed', cancelled: true });
    await tap('signin');
    expect(peekReturnPlace()).toEqual({ path: '/pet/9', action: 'signin' });
  });

  // spec: add-account › Session expiry flow › typed text after sign-in
  it('puts the text of an ended session in the record beside the place', async () => {
    await mount();
    await tap('signin', { text: 'And if they ask why the chart matters?' });
    expect(peekReturnPlace()).toEqual({ path: '/pet/9', action: 'signin', text: 'And if they ask why the chart matters?' });
  });

  // spec: add-account › Sign-in flow › вход начат
  it('changes nothing for a second tap while the gate is being read', async () => {
    let answer: (v: { state: 'open' }) => void = () => undefined;
    mocks.signInState.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    await mount();
    await tap('signin');
    await tap('signin');
    expect(mocks.signInState).toHaveBeenCalledTimes(1);
    await act(async () => answer({ state: 'open' }));
    expect(mocks.login).toHaveBeenCalledTimes(1);
  });

  // spec: add-account › Sign-in flow › вход начат × второй тап
  it('changes nothing for a second tap while Google is starting: the address is `/` then, and the record stays the place\'s', async () => {
    await mount();
    await tap('feed');
    // what the provider does at `login()`
    window.history.replaceState(null, '', '/');
    await tap('signin');
    expect(mocks.login).toHaveBeenCalledTimes(1);
    expect(mocks.signInState).toHaveBeenCalledTimes(1);
    expect(peekReturnPlace()).toEqual({ path: '/pet/9', action: 'feed' });
  });

  // spec: add-account › Sign-in flow › вход начат × второй тап
  it('takes a tap again once the sign-in answered with an error', async () => {
    await mount();
    await tap('feed');
    expect(signInUnderWay()).toBe(true);
    await mount({ signInError: 'failed' });
    expect(signInUnderWay()).toBe(false);
    await tap('feed');
    expect(mocks.login).toHaveBeenCalledTimes(2);
  });

  // spec: add-account › Sign-in flow › вход начат × второй тап
  it.each([
    ['the wallet failed', { walletFailed: true }],
    ['the server refused', { refusal: { reason: 'mau', until: CLOSED } }],
    ['the exchange got no answer', { unreachable: true }],
  ] as const)('takes a tap again once %s', async (_, answer) => {
    await mount();
    await tap('signin');
    await mount(answer);
    expect(signInUnderWay()).toBe(false);
  });

  // spec: add-account › Sign-in flow › вход не удался × Try again
  it('clears the last error at the tap, before the gate is read: the same error can come back at once and be seen', async () => {
    let answer: (v: { state: 'open' }) => void = () => undefined;
    mocks.signInState.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    await mount();
    await tap('signin');
    expect(mocks.clearSignInError).toHaveBeenCalledTimes(1);
    expect(mocks.login).not.toHaveBeenCalled();
    await act(async () => answer({ state: 'open' }));
  });
});

describe('the gate', () => {
  // spec: add-showcase › Judge admission flow › invalid code
  // spec: add-showcase › Judge admission flow › valid code
  it('keeps an invalid draft, then checks before Google and preserves the tapped action', async () => {
    mocks.signInState.mockResolvedValue({ state: 'closed_new', until: CLOSED });
    mocks.judgeCheck.mockRejectedValueOnce(new WorkerError(403, 'judge_invalid'));
    await mount();
    await tap('feed');
    await act(async () => sign.openJudge());
    const input = host.querySelector('input')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'sample-private-code');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const submit = () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await act(async () => submit());
    expect(host.textContent).toContain("That code doesn't work. Check it and try again.");
    expect(input.value).toBe('sample-private-code');
    expect(mocks.login).not.toHaveBeenCalled();
    await act(async () => submit());
    expect(mocks.judgeCheck).toHaveBeenCalledWith('sample-private-code');
    expect(peekReturnPlace()).toEqual({ path: '/pet/9', action: 'feed', judge: true });
    expect(mocks.login).toHaveBeenCalledTimes(1);
  });
  // spec: add-account › Sign-in flow › вход закрыт
  it('shows the closed sheet for a new player, and starts no Google', async () => {
    mocks.signInState.mockResolvedValue({ state: 'closed_new', until: CLOSED });
    await mount();
    await tap('feed');
    expect(sign.sheet).toEqual({ kind: 'closed_new', until: CLOSED, action: 'feed' });
    expect(mocks.login).not.toHaveBeenCalled();
    expect(peekReturnPlace()).toBeNull();
    expect(mocks.track).toHaveBeenCalledWith('sign_in_blocked', { reason: 'mau', step: 'before_google', from: 'link' });
    await act(async () => sign.closeSheet());
    expect(sign.sheet).toBeNull();
  });

  // spec: add-account › Sign-in flow › вход закрыт для всех
  it('shows the sheet for everyone at the ceiling, a returning player too', async () => {
    mocks.signInState.mockResolvedValue({ state: 'closed_all', until: CLOSED });
    await mount();
    await tap('signin', { returning: true });
    expect(sign.sheet).toMatchObject({ kind: 'closed_all', until: CLOSED });
    expect(mocks.login).not.toHaveBeenCalled();
    expect(mocks.track).toHaveBeenCalledWith('sign_in_blocked', { reason: 'ceiling', step: 'before_google', from: 'link' });
  });

  // spec: add-account › Sign-in flow › вернувшийся входит
  it('lets «Played here before? Sign in» through to Google while closed for new, with the action carried on', async () => {
    mocks.signInState.mockResolvedValue({ state: 'closed_new', until: CLOSED });
    await mount();
    await tap('feed', { returning: true });
    expect(sign.sheet).toBeNull();
    expect(mocks.login).toHaveBeenCalledTimes(1);
    expect(peekReturnPlace()).toEqual({ path: '/pet/9', action: 'feed' });
  });

  // spec: add-account › Sign-in flow › вход начат × чтение входа не удалось
  it('does not walk to Google when the gate cannot be read, and the next tap tries again', async () => {
    mocks.signInState.mockRejectedValueOnce(new WorkerError(0, 'unreachable'));
    await mount();
    await tap('signin');
    expect(sign.readFailed).toBe('unreachable');
    expect(mocks.login).not.toHaveBeenCalled();
    expect(peekReturnPlace()).toBeNull();
    await tap('signin');
    expect(sign.readFailed).toBeNull();
    expect(mocks.login).toHaveBeenCalledTimes(1);
  });

  // spec: add-account › Sign-in flow › вход начат × чтение входа не удалось
  it('keeps the rate limit of the gate apart from a server that is out of reach', async () => {
    mocks.signInState.mockRejectedValueOnce(new WorkerError(429, 'rate_limited'));
    await mount();
    await tap('signin');
    expect(sign.readFailed).toBe('busy');
    expect(mocks.login).not.toHaveBeenCalled();
  });

  // spec: add-account › Sign-in flow › вход закрыт × встроенный браузер
  it('shows the closed sheet before the Open in browser sheet in an in-app browser', async () => {
    userAgent(`${IPHONE} Twitter for iPhone`);
    mocks.signInState.mockResolvedValue({ state: 'closed_new', until: CLOSED });
    await mount();
    await tap('signin');
    expect(sign.sheet?.kind).toBe('closed_new');
  });
});

describe('an in-app browser', () => {
  // spec: add-account › Sign-in flow › встроенный браузер
  it('shows Open in browser sheet in place of Google, and the pet on the screen does not change', async () => {
    userAgent(`${IPHONE} Telegram/10.14`);
    await mount();
    await tap('feed');
    expect(sign.sheet).toEqual({ kind: 'open_browser', inApp: 'telegram', action: 'feed', place: '/pet/9' });
    expect(mocks.login).not.toHaveBeenCalled();
    expect(peekReturnPlace()).toBeNull();
    expect(mocks.track).toHaveBeenCalledWith('sign_in_started', { from: 'link', in_app: 'telegram' });
    expect(window.location.pathname).toBe('/pet/9');
  });
});
