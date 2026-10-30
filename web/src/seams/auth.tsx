import { Component, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { SessionProvider } from '../signin/session';
import { ProviderContext, type ProviderApi, type SignInError } from './auth-context';

export { useAuth, type AuthApi, type SignInError } from './auth-context';

// `Conversation access data`: a browser with no session never calls Privy before a tap. So the Privy SDK is not even
// loaded then: it mounts when this browser already holds a Privy session (to keep the player signed in), or when the
// player taps something that needs a sign-in (`login()`), and that tap begins the sign-in as soon as Privy is ready.
type Host = ComponentType<{ onApi: (api: ProviderApi) => void }>;
const loadHost = (): Host => lazy(() => import('./auth.privy').then((m) => ({ default: m.PrivyHost })));

/** Privy that does not report ready in this long (blocked, or down) stops holding the page: it opens as signed-out. */
export const PRIVY_WAIT_MS = 6000;

/** The SDK's chunk that will not load (the connection dropped at the tap, a deploy replaced the file) is no reason to
 *  lose the page. The player stays a visitor, and the next tap tries again. */
class HostBoundary extends Component<{ onFail: () => void; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(): void {
    this.props.onFail();
  }

  override render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

/** The return from Google carries the OAuth code in the address, until Privy reads it. */
const codeInAddress = () => /[?&]privy_oauth_code=/.test(window.location.search);

/** Whether this browser holds a Privy session. Privy's documented session cookies (`privy-session`, `privy-token`) and
 *  the keys its SDK keeps in localStorage (`privy:token`, `privy:refresh_token` — SDK internals, not documented) are
 *  looked at, never read. A browser that has one of them gets Privy at once; one that has none and does hold a
 *  session shows signed-out until its first tap. */
export function hasPrivySession(): boolean {
  try {
    // Privy must be there to finish the sign-in
    if (codeInAddress()) return true;
    if (/(?:^|;\s*)privy-(?:session|token)=/.test(document.cookie)) return true;
    return localStorage.getItem('privy:token') !== null || localStorage.getItem('privy:refresh_token') !== null;
  } catch {
    return false;
  }
}

const IDLE: ProviderApi = {
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
    throw new Error('not signed in');
  },
  async getIdentityToken() {
    return null;
  },
  async signNearHash() {
    throw new Error('not signed in');
  },
};

export function RealAuthProvider({ children }: { children: ReactNode }) {
  const [wanted, setWanted] = useState(hasPrivySession);
  const [privy, setPrivy] = useState<ProviderApi | null>(null);
  const [Host, setHost] = useState<Host>(loadHost);
  const [gaveUp, setGaveUp] = useState(false);
  // taps that needed Privy and found it not there: the count re-arms the wait, `tapError` is what the player gets of it
  const [taps, setTaps] = useState(0);
  const [tapError, setTapError] = useState<SignInError | null>(null);
  const loginAfterLoad = useRef(false);

  // The tap that needs a sign-in: mount Privy, and start the sign-in when it is ready.
  const login = useCallback(() => {
    loginAfterLoad.current = true;
    setTapError(null);
    setTaps((n) => n + 1);
    setWanted(true);
  }, []);

  useEffect(() => {
    if (privy?.ready && loginAfterLoad.current) {
      loginAfterLoad.current = false;
      if (!privy.authenticated) privy.login();
    }
  }, [privy]);

  const privyReady = privy?.ready ?? false;
  useEffect(() => {
    setGaveUp(false);
    if (!wanted || privyReady) return undefined;
    const timer = setTimeout(() => {
      setGaveUp(true);
      // `Sign-in flow` › «вход не удался»: a Privy that never got ready after the tap is a sign-in that failed, and it is
      // not started late, when the player has long since looked elsewhere
      if (loginAfterLoad.current) {
        loginAfterLoad.current = false;
        setTapError('failed');
      }
    }, PRIVY_WAIT_MS);
    return () => clearTimeout(timer);
  }, [wanted, privyReady, taps]);

  // A failed lazy() stays failed: the next tap gets a new one.
  const hostFailed = useCallback(() => {
    if (loginAfterLoad.current) setTapError('failed');
    loginAfterLoad.current = false;
    setWanted(false);
    setPrivy(null);
    setHost(() => loadHost());
  }, []);

  const clearTapError = useCallback(() => setTapError(null), []);

  const api = useMemo<ProviderApi>(() => {
    const idle = { ...IDLE, signInError: tapError, login, clearSignInError: clearTapError };
    // A return from Google that Privy has not read yet is no plain load: the page opens as signed-out, and the code and the
    // place stay for a Privy that comes late, or for a reload.
    if (!wanted || (gaveUp && !privyReady)) return { ...idle, freshSignIn: codeInAddress() };
    // Privy is loading: not ready, so no screen shows signed-out for a player who is only being recognised.
    if (!privy) return { ...idle, ready: false };
    return {
      ...privy,
      signInError: tapError ?? privy.signInError,
      login() {
        setTapError(null);
        privy.login();
      },
      clearSignInError() {
        setTapError(null);
        privy.clearSignInError();
      },
    };
  }, [wanted, gaveUp, privyReady, privy, login, clearTapError, tapError]);

  return (
    <ProviderContext.Provider value={api}>
      <SessionProvider>{children}</SessionProvider>
      {wanted ? (
        <HostBoundary onFail={hostFailed}>
          <Suspense fallback={null}>
            <Host onApi={setPrivy} />
          </Suspense>
        </HostBoundary>
      ) : null}
    </ProviderContext.Provider>
  );
}

export const AuthProvider: ComponentType<{ children: ReactNode }> =
  import.meta.env.VITE_FAKES === 'true' ? (await import('./auth.fake')).FakeAuthProvider : RealAuthProvider;
