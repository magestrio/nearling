// @vitest-environment jsdom
import { act, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { takePendingAction } from '../screens/pet/parts';
import { clearOutcome } from '../signin/outcome';
import { markSignInUnderWay, peekReturnPlace, rememberReturnPlace, takeReturnPlace } from '../signin/returnPlace';
import { ReturnToPlace } from '../signin/ReturnToPlace';
import { SessionProvider } from '../signin/session';
import { SignInLayer, useSignIn, type SignInApi } from '../signin/signIn';
import { SignInOutcome } from '../signin/SignInOutcome';
import { ProviderContext, useAuth, type AuthApi, type ProviderApi } from './auth-context';
import { PrivyHost } from './auth.privy';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Every hook hands out new functions on every render, as Privy's do: the page must not depend on them being stable.
const privy = vi.hoisted(() => ({
  authenticated: true,
  linked: 'player.testnet' as string | null,
  oauth: vi.fn(),
  created: vi.fn(),
  createFails: false,
  email: 'sam@example.com' as string | null,
  onError: undefined as ((code: string) => void) | undefined,
  at: [] as string[],
  gate: vi.fn(),
}));

vi.mock('./worker', async (original) => ({
  ...(await original<typeof import('./worker')>()),
  workerApi: { session: vi.fn(async () => ({ ok: true })), signInState: () => privy.gate() },
}));

vi.mock('../config', () => ({ config: { privyAppId: 'app' } }));

vi.mock('@privy-io/react-auth', () => ({
  PrivyProvider: ({ children }: { children: ReactNode }) => children,
  getIdentityToken: async () => 'identity-token',
  useLoginWithOAuth: (callbacks?: { onError?: (code: string) => void }) => {
    privy.onError = callbacks?.onError;
    return { initOAuth: (...args: unknown[]) => privy.oauth(...args) };
  },
  usePrivy: () => ({
    ready: true,
    authenticated: privy.authenticated,
    user: {
      google: privy.email === null ? undefined : { email: privy.email },
      linkedAccounts: privy.linked === null ? [] : [{ type: 'wallet', chainType: 'near', address: privy.linked }],
    },
    logout: async () => undefined,
  }),
}));

vi.mock('@privy-io/react-auth/extended-chains', () => ({
  useCreateWallet: () => ({
    createWallet: async () => {
      privy.created();
      if (privy.createFails) throw new Error('wallet refused');
      return { wallet: { address: 'new.testnet' } };
    },
  }),
  useSignRawHash: () => ({ signRawHash: async () => ({ signature: '0x00' }) }),
}));

let root: Root | null = null;
let published = 0;
let api: ProviderApi | null = null;
/** what the app reads: the session layer over the provider */
let seen: AuthApi | null = null;

function Probe() {
  seen = useAuth();
  return null;
}

// The provider above: a new `api` is its state, so every publish renders the host again. The session layer and
// `ReturnToPlace` stand under it as they do in the app.
function Above({ screen }: { screen?: ReactNode }) {
  const [current, set] = useState<ProviderApi | null>(null);
  return (
    <>
      <PrivyHost
        onApi={(next) => {
          published += 1;
          api = next;
          set(next);
        }}
      />
      {current ? (
        <ProviderContext.Provider value={current}>
          <SessionProvider>
            <Probe />
            <ReturnToPlace />
            {screen}
          </SessionProvider>
        </ProviderContext.Provider>
      ) : null}
    </>
  );
}

async function mount(screen?: ReactNode) {
  const host = document.createElement('div');
  root = createRoot(host);
  await act(async () => {
    root?.render(<Above screen={screen} />);
  });
  return host;
}

beforeEach(() => {
  privy.authenticated = true;
  privy.linked = 'player.testnet';
  privy.createFails = false;
  privy.oauth.mockClear();
  privy.created.mockClear();
  privy.email = 'sam@example.com';
  privy.onError = undefined;
  privy.at = [];
  privy.gate.mockReset();
  privy.gate.mockResolvedValue({ state: 'open' });
  published = 0;
  api = null;
  seen = null;
  sessionStorage.clear();
  takePendingAction();
  clearOutcome();
  markSignInUnderWay(false);
  window.history.replaceState(null, '', '/');
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = null;
});

describe('Bridge against a provider that re-renders it', () => {
  it('publishes once for a signed-in player and stops, with hooks that hand out new functions', async () => {
    await mount();
    expect(api?.authenticated).toBe(true);
    expect(api?.nearAccountId).toBe('player.testnet');
    expect(published).toBeLessThan(5);
  });

  it('makes the wallet of a new player once and stops', async () => {
    privy.linked = null;
    await mount();
    expect(privy.created).toHaveBeenCalledTimes(1);
    expect(api?.ready).toBe(true);
    expect(api?.authenticated).toBe(true);
    expect(api?.nearAccountId).toBe('new.testnet');
    expect(published).toBeLessThan(6);
  });

  it('starts Google through the newest function of the hook', async () => {
    privy.authenticated = false;
    privy.linked = null;
    await mount();
    expect(api?.authenticated).toBe(false);
    api?.login();
    expect(privy.oauth).toHaveBeenCalledWith({ provider: 'google' });
  });

  // spec: add-pet › Pet screen › signed-out × сессия истекла посреди игры
  it('sends a tap to Google when Privy still says signed in and the wallet is there: the retry would change nothing', async () => {
    await mount();
    expect(api?.authenticated).toBe(true);
    api?.login();
    expect(privy.oauth).toHaveBeenCalledWith({ provider: 'google' });
    expect(privy.created).not.toHaveBeenCalled();
  });

  // spec: add-pet › Birth flow › вылупился × вход нового игрока, кошелёк не вышел
  it('leads a new player whose wallet failed back to the place, and the tap there tries the wallet again', async () => {
    privy.linked = null;
    privy.createFails = true;
    rememberReturnPlace({ path: '/pet/9', action: 'feed' });
    await mount();
    expect(privy.created).toHaveBeenCalledTimes(1);
    // not a visitor's black page: the app knows the sign-in stands and the wallet is what is missing
    expect(api).toMatchObject({ ready: true, authenticated: false, walletFailed: true, nearAccountId: null });
    expect(window.location.pathname).toBe('/pet/9');
    expect(takeReturnPlace()).toBeNull();
    // «Feed {name}» waits for a sign-in that is whole
    expect(takePendingAction()).toBeNull();

    // the tap on the place's «Sign in…»: the screen puts the place back, the provider sends the tab to `/` itself
    rememberReturnPlace({ path: '/pet/9', action: 'feed' });
    privy.createFails = false;
    await act(async () => {
      api?.login();
    });
    expect(privy.oauth).not.toHaveBeenCalled();
    expect(privy.created).toHaveBeenCalledTimes(2);
    expect(api).toMatchObject({ ready: true, authenticated: true, walletFailed: false, nearAccountId: 'new.testnet' });
    expect(window.location.pathname).toBe('/pet/9');
    expect(takePendingAction()).toBe('feed');
  });

  // spec: add-pet › Birth flow › вылупился × вход нового игрока, кошелёк не вышел
  it('takes the place again when the retry fails too', async () => {
    privy.linked = null;
    privy.createFails = true;
    rememberReturnPlace('/hatch');
    await mount();
    expect(window.location.pathname).toBe('/hatch');
    rememberReturnPlace('/hatch');
    await act(async () => {
      api?.login();
    });
    expect(privy.created).toHaveBeenCalledTimes(2);
    expect(api).toMatchObject({ ready: true, authenticated: false, walletFailed: true });
    expect(window.location.pathname).toBe('/hatch');
  });
});

describe('Bridge and the sign-in', () => {
  // spec: add-account › Sign-in return data › вход со ссылки подарка
  it('gives Privy the address `/` and nothing of the place, which stays in the tab', async () => {
    privy.authenticated = false;
    privy.linked = null;
    window.history.replaceState(null, '', '/gift/abc123?c=pet_fans');
    privy.oauth.mockImplementation(() => {
      privy.at.push(window.location.pathname + window.location.search + window.location.hash);
    });
    await mount();
    // the tap writes the place after the app has started (a record found at a start elsewhere is erased)
    rememberReturnPlace({ path: '/gift/abc123?c=pet_fans', action: 'signin' });
    await act(async () => {
      api?.login();
    });
    expect(privy.oauth).toHaveBeenCalledTimes(1);
    expect(privy.at).toEqual(['/']);
    expect(takeReturnPlace()).toEqual({ path: '/gift/abc123?c=pet_fans', action: 'signin' });
  });

  // spec: add-account › Sign-in flow › вход не удался
  it('puts the address back and reports a failed sign-in when Google cannot be started', async () => {
    privy.authenticated = false;
    privy.linked = null;
    window.history.replaceState(null, '', '/pet/9');
    privy.oauth.mockRejectedValueOnce(new Error('popup blocked'));
    await mount();
    await act(async () => {
      api?.login();
    });
    expect(window.location.pathname).toBe('/pet/9');
    expect(api?.signInError).toBe('failed');
    expect(seen?.signInError).toBe('failed');

    // the next tap clears it
    privy.oauth.mockResolvedValueOnce(undefined);
    await act(async () => {
      api?.login();
    });
    expect(api?.signInError).toBeNull();
  });

  // spec: add-account › Sign-in flow › отменил вход
  it('tells a closed Google window from an error', async () => {
    privy.authenticated = false;
    privy.linked = null;
    await mount();
    await act(async () => privy.onError?.('oauth_user_denied'));
    expect(api?.signInError).toBe('cancelled');
    await act(async () => privy.onError?.('exited_auth_flow'));
    expect(api?.signInError).toBe('cancelled');
    await act(async () => privy.onError?.('unknown_auth_error'));
    expect(api?.signInError).toBe('failed');
  });

  // spec: add-account › Sign-in flow › вошёл со страницы
  it('knows a load that came back from Google, and the Google account\'s email', async () => {
    window.history.replaceState(null, '', '/?privy_oauth_code=abc&privy_oauth_state=def&privy_oauth_provider=google');
    await mount();
    expect(api).toMatchObject({ freshSignIn: true, email: 'sam@example.com' });
  });

  // spec: add-account › Sign-in flow › вошёл со страницы
  it('is no fresh sign-in on a plain load, and has no email when Privy has none', async () => {
    privy.email = null;
    await mount();
    expect(api).toMatchObject({ freshSignIn: false, email: null });
  });
});

// The whole way from a tap on a page to the line, through the real `Bridge`: the page never left, so the address is the place.
describe('a sign-in that fails before the page leaves', () => {
  const FAILED = "We couldn't sign you in with Google. Try again in a moment.";
  const FALLBACK = 'Trouble signing in? Try it in your browser.';
  const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';
  const DESKTOP = navigator.userAgent;
  let sign: SignInApi;

  function Screen() {
    sign = useSignIn();
    return <SignInOutcome />;
  }
  const screen = (
    <SignInLayer>
      <Screen />
    </SignInLayer>
  );
  const userAgent = (value: string) => Object.defineProperty(navigator, 'userAgent', { value, configurable: true });
  const buttons = (host: HTMLElement) => [...host.querySelectorAll('button')].map((b) => b.textContent);

  beforeEach(() => {
    privy.authenticated = false;
    privy.linked = null;
    privy.oauth.mockReset();
    privy.oauth.mockRejectedValue(new Error("It looks like you're using an in-app browser."));
    window.matchMedia = ((query: string) => ({ matches: true, media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  });

  afterEach(() => {
    userAgent(DESKTOP);
  });

  // spec: add-account › Sign-in flow › вход не удался
  it.each(['/pet/2', '/hatch?from=2'])('draws the line and «Try again» at %s, the address back, the record without its text', async (place) => {
    window.history.replaceState(null, '', place);
    const host = await mount(screen);
    await act(async () => sign.begin('feed', { text: 'And if they ask why?' }));
    expect(window.location.pathname + window.location.search).toBe(place);
    expect(host.textContent).toContain(FAILED);
    expect(buttons(host)).toEqual(['Try again']);
    expect(host.textContent).not.toContain(FALLBACK);
    expect(peekReturnPlace()).toEqual({ path: place, action: 'feed', cancelled: true });
  });

  // spec: add-account › Sign-in flow › запасной путь на телефоне
  it.each(['/pet/2', '/hatch'])('adds the way out to a real browser on a phone, at %s', async (place) => {
    userAgent(ANDROID);
    window.history.replaceState(null, '', place);
    const host = await mount(screen);
    await act(async () => sign.begin('signin'));
    expect(host.textContent).toContain(FAILED);
    expect(host.textContent).toContain(FALLBACK);
    expect(buttons(host)).toEqual(['Try again', 'Open in browser']);
  });

  // Privy refuses some in-app browsers before any request: the second failure comes in the same tick as `login()`. Each step of
  // the tap has its own `act`, so React draws between them as it does in a browser.
  // spec: add-account › Sign-in flow › вход не удался × Try again
  it('brings the line back when «Try again» fails the same way, and the next tap still goes', async () => {
    window.history.replaceState(null, '', '/pet/2');
    const host = await mount(screen);
    await act(async () => sign.begin('signin'));
    expect(host.textContent).toContain(FAILED);

    for (const times of [2, 3]) {
      let open: (gate: { state: 'open' }) => void = () => undefined;
      privy.gate.mockReturnValue(new Promise((resolve) => (open = resolve)));
      await act(async () => sign.begin('signin'));
      expect(host.textContent).not.toContain(FAILED);
      await act(async () => open({ state: 'open' }));
      expect(privy.oauth).toHaveBeenCalledTimes(times);
      expect(window.location.pathname).toBe('/pet/2');
      expect(host.textContent).toContain(FAILED);
    }
  });
});
