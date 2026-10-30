import { createContext, useContext } from 'react';
import type { SignInRefusal } from './worker-types';

/** How a sign-in that did not end in a session ended: the player closed Google's window (`cancelled`), or the provider or
 *  Google returned an error, or Privy never came (`failed`). */
export type SignInError = 'cancelled' | 'failed';

/** What the provider of sign-in (Privy, or a fake in tests) knows. Nothing in the app reads this directly: `SessionProvider`
 *  (signin/session.tsx) stands over it, asks the server for the session, and publishes `AuthApi`. */
export interface ProviderApi {
  ready: boolean;
  /** Signed in with Google and the NEAR wallet is there. Not yet the game's session: the server has the last word. */
  authenticated: boolean;
  /** The 64-hex implicit account of the player's embedded NEAR wallet; null until the wallet exists. */
  nearAccountId: string | null;
  /** Signed in with Google, and making the NEAR wallet failed. `authenticated` stays false; the next `login()` tries the
   *  wallet again. */
  walletFailed: boolean;
  /** The Google account's email, for the Account menu only: never sent, never stored. */
  email: string | null;
  /** This page load came back from Google (`privy_oauth_code` was in the address when the page started — Privy strips it
   *  later). The server applies a closed sign-in to a fresh sign-in only. */
  freshSignIn: boolean;
  /** The last sign-in ended without a session: `cancelled` or `failed`; null until one does. A new `login()` clears it. */
  signInError: SignInError | null;
  /** Google sign-in. Call it straight from the tap's handler: iOS Safari blocks anything later. */
  login(): void;
  /** The tap that begins a sign-in forgets the last error before it reads the gate. Privy can refuse in the same tick as
   *  `login()` (some in-app browsers, before any request): an old error cleared only there would come back as the same value
   *  in one render, and nothing would react to it. */
  clearSignInError(): void;
  logout(): Promise<void>;
  /** Creates the embedded NEAR wallet and returns its account id. */
  createNearWallet(): Promise<string>;
  /** Privy's identity token for the Worker (`privy-id-token`); never logged, never stored. */
  getIdentityToken(): Promise<string | null>;
  /** Signs a 32-byte hash (hex, no 0x) with the embedded wallet; returns the 64-byte ed25519 signature. */
  signNearHash(hashHex: string): Promise<Uint8Array>;
}

/** What the client knows about the player's session. `authenticated` is true only after the server answered the exchange
 *  with `200`, and `ready` is false while it runs, so no screen flashes signed-out. */
export interface AuthApi extends ProviderApi {
  /** The server refused to open a session after Google (`Sign-in data` › «отказ после Google»); the browser's Privy session
   *  is already ended. Cleared by the next `login()`. */
  refusal: SignInRefusal | null;
  /** The exchange got no answer (`Connection rule` › «сервер недоступен»): `retrySession()` asks again. */
  unreachable: boolean;
  retrySession(): void;
  /** The session ended while a page is open (`Session expiry flow`): the page stands as it is until a tap needs the session
   *  or the address changes. Polls stop; the screen does not change. */
  sessionEnded: boolean;
  /** The line «You've been signed out…» has been asked for by a tap that needed the session. */
  sessionLine: boolean;
  /** Any request that met `401`, or a token keeper that answered `null`, calls this. `held: false` — nothing was shown yet
   *  (a `401` on a page's first load), so the page opens as the visitor's at once. `line: true` — the request was the player's
   *  own tap: the line «You've been signed out…» is asked for too. */
  endSession(held?: boolean, line?: boolean): void;
  /** Every control that needs a session asks first: with an ended one it sets `sessionLine` and returns false, and the
   *  action is not sent. */
  needSession(): boolean;
}

/** What the provider publishes, under `SessionProvider`. */
export const ProviderContext = createContext<ProviderApi | null>(null);

/** What `SessionProvider` publishes, to the whole app. */
export const AuthContext = createContext<AuthApi | null>(null);

export function useProvider(): ProviderApi {
  const provider = useContext(ProviderContext);
  if (!provider) throw new Error('useProvider needs a provider of sign-in above it');
  return provider;
}

export function useAuth(): AuthApi {
  const auth = useContext(AuthContext);
  if (!auth) throw new Error('useAuth needs an AuthProvider above it');
  return auth;
}
