import { createContext, useContext } from 'react';

/** What the client knows about the player's sign-in, whatever provides it (Privy, or a fake in tests). */
export interface AuthApi {
  ready: boolean;
  authenticated: boolean;
  /** The 64-hex implicit account of the player's embedded NEAR wallet; null until the wallet exists. */
  nearAccountId: string | null;
  /** Google sign-in. Call it straight from the tap's handler: iOS Safari blocks anything later. */
  login(): void;
  logout(): Promise<void>;
  /** Creates the embedded NEAR wallet and returns its account id. */
  createNearWallet(): Promise<string>;
  /** Privy's identity token for the Worker (`privy-id-token`); never logged, never stored. */
  getIdentityToken(): Promise<string | null>;
  /** Signs a 32-byte hash (hex, no 0x) with the embedded wallet; returns the 64-byte ed25519 signature. */
  signNearHash(hashHex: string): Promise<Uint8Array>;
}

export const AuthContext = createContext<AuthApi | null>(null);

export function useAuth(): AuthApi {
  const auth = useContext(AuthContext);
  if (!auth) throw new Error('useAuth needs an AuthProvider above it');
  return auth;
}
