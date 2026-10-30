import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { SessionProvider } from '../signin/session';
import { ProviderContext, type ProviderApi, type SignInError } from './auth-context';
import { fakeState, recordCall } from './fakes';

const FAKE_ACCOUNT = 'a'.repeat(64);

/** Behaves as the real provider does where a test can see it: «Privy» is loaded (`privy:load` in
 *  `__NEARLING_CALLS__`) only when the page starts with a session or after a tap that signs in; a visitor's page load
 *  makes no call. A sign-in is in place (no page leaves): the address goes to `/` as it does when Privy reads it, and
 *  the outcome is what `fakes.auth.outcome` says, after the tap, as it comes in the real provider: a sign-in that never
 *  started puts the address back, one that came back from Google stays at `/` for `ReturnToPlace`, one that is `held` stays
 *  in the window where Google is starting. The exchange with the server is the real one, against the fake Worker. */
export function FakeAuthProvider({ children }: { children: ReactNode }) {
  const initial = fakeState().auth;
  const [authenticated, setAuthenticated] = useState(initial?.authenticated ?? false);
  const [nearAccountId, setNearAccountId] = useState<string | null>(initial?.nearAccountId ?? null);
  const [fresh, setFresh] = useState(initial?.fresh ?? false);
  const [signInError, setSignInError] = useState<SignInError | null>(null);
  // a ref: the load renders nothing, so the address can stand at `/` under the page as it does while Google starts
  const loaded = useRef(false);
  if (!loaded.current && (initial?.authenticated ?? false)) {
    loaded.current = true;
    recordCall('privy:load');
  }

  // Another tab of this browser signed out: Privy in this tab loses its session from under the open page. A test dispatches
  // `nearling:fake-session-lost` for it.
  useEffect(() => {
    const lost = () => setAuthenticated(false);
    window.addEventListener('nearling:fake-session-lost', lost);
    return () => window.removeEventListener('nearling:fake-session-lost', lost);
  }, []);

  const api = useMemo<ProviderApi>(
    () => ({
      ready: true,
      authenticated,
      nearAccountId,
      walletFailed: false,
      email: authenticated ? (initial?.email === undefined ? 'sam@example.com' : initial.email) : null,
      freshSignIn: fresh,
      signInError,
      login() {
        if (!loaded.current) {
          loaded.current = true;
          recordCall('privy:load');
        }
        recordCall('privy:login');
        setSignInError(null);
        const place = window.location.pathname + window.location.search;
        if (place !== '/') window.history.replaceState(null, '', '/');
        const outcome = fakeState().auth?.outcome ?? 'ok';
        if (outcome === 'ok') {
          setFresh(true);
          setAuthenticated(true);
        } else if (outcome !== 'held') {
          setTimeout(() => {
            if (outcome === 'start_failed' && window.location.pathname === '/') window.history.replaceState(null, '', place);
            setSignInError(outcome === 'start_failed' ? 'failed' : outcome);
          });
        }
      },
      clearSignInError() {
        setSignInError(null);
      },
      async logout() {
        recordCall('privy:logout');
        setAuthenticated(false);
        setNearAccountId(null);
        setFresh(false);
      },
      async createNearWallet() {
        setNearAccountId(FAKE_ACCOUNT);
        return FAKE_ACCOUNT;
      },
      async getIdentityToken() {
        return authenticated ? (initial?.identityToken ?? 'fake-identity-token') : null;
      },
      async signNearHash() {
        return new Uint8Array(64);
      },
    }),
    [authenticated, nearAccountId, fresh, signInError, initial],
  );

  return (
    <ProviderContext.Provider value={api}>
      <SessionProvider>{children}</SessionProvider>
    </ProviderContext.Provider>
  );
}
