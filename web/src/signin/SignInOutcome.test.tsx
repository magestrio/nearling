// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthContext, type AuthApi } from '../seams/auth-context';
import { clearOutcome, setOutcome } from './outcome';
import { SESSION_LINE } from './session';
import { LIVE_WAIT_MS, SignInOutcome } from './SignInOutcome';
import { SignInLayer } from './signIn';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../seams/worker', async (original) => ({
  ...(await original<typeof import('../seams/worker')>()),
  workerApi: { signInState: async () => ({ state: 'open' }) },
}));
vi.mock('../track', () => ({ track: () => undefined }));

const FAILED = "We couldn't sign you in with Google. Try again in a moment.";

let root: Root | null = null;
let page: HTMLDivElement;

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

async function mount(over: Partial<AuthApi> = {}, column = false) {
  page = document.createElement('div');
  root = createRoot(page);
  await act(async () => {
    root!.render(
      <AuthContext.Provider value={auth(over)}>
        <SignInLayer>
          <SignInOutcome column={column} />
        </SignInLayer>
      </AuthContext.Provider>,
    );
  });
}

const live = () => page.querySelector('[role="status"]')?.textContent;

beforeEach(() => {
  vi.useFakeTimers();
  clearOutcome();
  window.history.replaceState(null, '', '/pet/2');
  // `SignInLayer` asks whether the viewport is a desktop; jsdom has no media queries
  window.matchMedia = ((query: string) => ({ matches: true, media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  vi.useRealTimers();
});

describe('the line of a sign-in', () => {
  // spec: add-account › Sign-in flow › вход не удался
  it('comes after its region: a Live mounted together with its words is not heard', async () => {
    setOutcome({ kind: 'failed', place: '/pet/2' });
    await mount();
    expect(page.textContent).toContain(FAILED);
    expect(live()).toBe('');
    await act(async () => vi.advanceTimersByTime(LIVE_WAIT_MS));
    expect(live()).toBe(FAILED);
  });

  // spec: add-account › Sign-in flow › вход не удался
  it('of a failure outranks the ended session\'s: the session line would only ask for the same tap again', async () => {
    setOutcome({ kind: 'failed', place: '/pet/2' });
    await mount({ sessionLine: true });
    expect(page.textContent).toContain(FAILED);
    expect(page.textContent).not.toContain(SESSION_LINE);
  });

  // spec: add-account › Session expiry flow › сессия кончилась при открытом экране
  it('of a cancel leaves the ended session\'s where it was: «Sign in» is still the way on', async () => {
    setOutcome({ kind: 'cancelled', place: '/pet/2' });
    await mount({ sessionLine: true });
    expect(page.textContent).toContain(SESSION_LINE);
  });

  // spec: add-account › Sign-in flow › вход не удался
  it('on the guest\'s page (column) draws the failure with its coral icon and «Try again» as a compact secondary button', async () => {
    setOutcome({ kind: 'failed', place: '/pet/2' });
    await mount({}, true);
    expect(page.querySelector('.ds-note--error')?.textContent).toContain(FAILED);
    expect(page.querySelector('.ds-button--secondary.ds-button--compact')?.textContent).toBe('Try again');
  });
});
