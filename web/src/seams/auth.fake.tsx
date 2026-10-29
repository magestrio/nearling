import { useMemo, useState, type ReactNode } from 'react';
import { AuthContext, type AuthApi } from './auth-context';
import { fakeState } from './fakes';

const FAKE_ACCOUNT = 'a'.repeat(64);

export function FakeAuthProvider({ children }: { children: ReactNode }) {
  const initial = fakeState().auth;
  const [authenticated, setAuthenticated] = useState(initial?.authenticated ?? false);
  const [nearAccountId, setNearAccountId] = useState<string | null>(initial?.nearAccountId ?? null);

  const api = useMemo<AuthApi>(
    () => ({
      ready: true,
      authenticated,
      nearAccountId,
      login() {
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
    [authenticated, nearAccountId, initial],
  );

  return <AuthContext.Provider value={api}>{children}</AuthContext.Provider>;
}
