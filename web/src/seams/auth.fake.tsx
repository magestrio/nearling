import { useMemo, useState, type ReactNode } from 'react';
import { AuthContext, type AuthApi } from './auth-context';
import { fakeState, recordCall } from './fakes';

const FAKE_ACCOUNT = 'a'.repeat(64);

/** Behaves as the real provider does where a test can see it: «Privy» is loaded (`privy:load` in
 *  `__NEARLING_CALLS__`) only when the page starts with a session or after a tap that signs in; a visitor's page load
 *  makes no call. */
export function FakeAuthProvider({ children }: { children: ReactNode }) {
  const initial = fakeState().auth;
  const [authenticated, setAuthenticated] = useState(initial?.authenticated ?? false);
  const [nearAccountId, setNearAccountId] = useState<string | null>(initial?.nearAccountId ?? null);
  const [loaded, setLoaded] = useState(() => {
    const has = initial?.authenticated ?? false;
    if (has) recordCall('privy:load');
    return has;
  });

  const api = useMemo<AuthApi>(
    () => ({
      ready: true,
      authenticated,
      nearAccountId,
      walletFailed: false,
      login() {
        if (!loaded) {
          recordCall('privy:load');
          setLoaded(true);
        }
        recordCall('privy:login');
        setAuthenticated(true);
      },
      async logout() {
        setAuthenticated(false);
        setNearAccountId(null);
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
    [authenticated, nearAccountId, initial, loaded],
  );

  return <AuthContext.Provider value={api}>{children}</AuthContext.Provider>;
}
