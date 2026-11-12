// The session layer: stands over the provider of sign-in (Privy, or a fake) and makes `authenticated` mean what the server
// says. Once per page load with a provider session and a NEAR wallet it asks `POST /api/session`; `authenticated` is true
// only after the `200`, and `ready` is false while the exchange runs, so no screen flashes signed-out. It also owns the
// end of a session while a page is open (`Session expiry flow`): the page stands as it is until a tap needs the session
// or the address changes.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocation } from '../route';
import { AuthContext, useProvider, type AuthApi } from '../seams/auth-context';
import { isTransientAuthError } from '../seams/token';
import { workerApi, WorkerError, type SignInRefusal } from '../seams/worker';
import { clearJudgeCode, readJudgeCode } from './judgeCode';
import { fromOf, markSignInUnderWay, peekReturnPlace } from './returnPlace';

/** `Session expiry flow` › «сессия кончилась при открытом экране»: what a tap that needs the session says. */
export const SESSION_LINE = "You've been signed out. Sign in to pick up where you left off.";

type Outcome = 'ok' | 'refused' | 'unauthorized' | 'unreachable';

export function SessionProvider({ children }: { children: ReactNode }) {
  const provider = useProvider();
  const location = useLocation();
  const [outcome, setOutcome] = useState<{ key: string; result: Outcome } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [signedIn, setSignedIn] = useState(false);
  const [refusal, setRefusal] = useState<SignInRefusal | null>(null);
  const [failed, setFailed] = useState(false);
  const [ended, setEnded] = useState<{ at: string; held: boolean } | null>(null);
  const [line, setLine] = useState(false);

  // The newest of what the callbacks below read: they stay the same functions, so a screen's effect that has them in its
  // dependencies does not run again for a render of this provider.
  const endedRef = useRef(ended);
  endedRef.current = ended;
  const providerRef = useRef(provider);
  providerRef.current = provider;
  const signedInRef = useRef(signedIn);
  signedInRef.current = signedIn;
  const loggingOut = useRef(false);

  const key = `${provider.nearAccountId}|${provider.freshSignIn}|${attempt}`;
  const current = provider.authenticated && outcome?.key === key ? outcome : null;
  const pending = provider.authenticated && current === null;

  // The exchange. `running` keeps a render of this provider from asking twice for the same key.
  const running = useRef<string | null>(null);
  useEffect(() => {
    if (!provider.ready || !provider.authenticated || outcome?.key === key || running.current === key) return;
    running.current = key;
    // a session stands, so no Google is coming: a tap that found Privy already holding one has its answer here
    markSignInUnderWay(false);
    const fresh = provider.freshSignIn;
    void (async () => {
      let result: Outcome = 'unreachable';
      let refused: SignInRefusal | null = null;
      try {
        const token = await providerRef.current.getIdentityToken();
        if (token === null) {
          result = 'unauthorized';
        } else {
          // where the sign-in began: on a pet's or a gift's address (its place waits in the tab), or anywhere else
          const place = fresh ? peekReturnPlace() : null;
          const from = fresh ? (place ? fromOf(place.path) : 'home') : undefined;
          const judgeCode = fresh && place?.judge ? readJudgeCode() : null;
          const input = { fresh, ...(from ? { from } : {}), ...(judgeCode ? { judgeCode } : {}) };
          let answer;
          try { answer = await workerApi.session(token, input); }
          catch (error) {
            if (!isTransientAuthError(error)) throw error;
            await new Promise<void>((resolve) => setTimeout(resolve, 600));
            if (running.current !== key || !providerRef.current.authenticated) return;
            answer = await workerApi.session(token, input);
          }
          if (fresh) clearJudgeCode();
          if ('refused' in answer) {
            result = 'refused';
            refused = answer.refused;
          } else {
            result = 'ok';
          }
        }
      } catch (e) {
        result = e instanceof WorkerError && e.status === 401 ? 'unauthorized' : 'unreachable';
      }
      if (running.current !== key) return;
      running.current = null;
      setOutcome({ key, result });
      if (result === 'ok') {
        setSignedIn(true);
        setEnded(null);
        setLine(false);
        setFailed(false);
      } else {
        setSignedIn(false);
        // A `401` after Google is a sign-in that did not work; one on a page load is a visitor (nothing to show).
        if (result === 'unauthorized' && fresh) setFailed(true);
        if (result === 'refused') {
          setRefusal(refused);
          // the server did not open a session: the browser ends Privy's
          loggingOut.current = true;
          void providerRef.current.logout().finally(() => {
            loggingOut.current = false;
          });
        }
      }
    })();
  }, [provider.ready, provider.authenticated, provider.freshSignIn, key, outcome?.key]);

  // No provider session, no exchange: a sign-in that follows asks again, and one still on its way is dropped.
  useEffect(() => {
    if (provider.authenticated) return;
    running.current = null;
    setOutcome((o) => (o === null ? o : null));
  }, [provider.authenticated]);

  const endSession = useCallback((held = true, line = false) => {
    // the request of a tap that met the `401` asks for the line at once, as a tap that finds the session ended does
    if (line && held) setLine(true);
    if (endedRef.current) return;
    clearJudgeCode();
    setEnded({ at: window.location.pathname + window.location.search, held });
  }, []);

  // The provider's own session went from under an open page (Privy ended it in another tab): the same as a `401`.
  useEffect(() => {
    if (!provider.authenticated && signedIn && !loggingOut.current) endSession();
  }, [provider.authenticated, signedIn, endSession]);

  // An ended session holds the page until the first change of address; the new screen is a visitor's.
  useEffect(() => {
    if (ended?.held && location !== ended.at) {
      setEnded({ ...ended, held: false });
      setLine(false);
    }
  }, [ended, location]);

  const needSession = useCallback(() => {
    if (!endedRef.current) return true;
    setLine(true);
    return false;
  }, []);

  const login = useCallback(() => {
    setRefusal(null);
    setFailed(false);
    providerRef.current.login();
  }, []);

  const clearSignInError = useCallback(() => {
    setFailed(false);
    providerRef.current.clearSignInError();
  }, []);

  const logout = useCallback(async () => {
    clearJudgeCode();
    loggingOut.current = true;
    setEnded(null);
    setLine(false);
    setSignedIn(false);
    setRefusal(null);
    setFailed(false);
    try {
      await providerRef.current.logout();
    } finally {
      loggingOut.current = false;
    }
  }, []);

  const getIdentityToken = useCallback(async () => {
    const token = await providerRef.current.getIdentityToken();
    // a token keeper that answers `null` for a signed-in page: the session ended
    if (token === null && signedInRef.current) endSession();
    return token;
  }, [endSession]);

  const retrySession = useCallback(() => setAttempt((a) => a + 1), []);

  const holding = ended === null || ended.held;
  const api = useMemo<AuthApi>(
    () => ({
      ...provider,
      ready: provider.ready && !pending,
      authenticated: signedIn && holding,
      signInError: failed ? 'failed' : provider.signInError,
      refusal,
      unreachable: current?.result === 'unreachable',
      retrySession,
      sessionEnded: ended !== null,
      // past the held page there is a visitor's, with no line to show: a late tap or a late `401` adds none
      sessionLine: line && holding,
      endSession,
      needSession,
      login,
      clearSignInError,
      logout,
      getIdentityToken,
    }),
    [provider, pending, signedIn, holding, failed, refusal, current?.result, retrySession, ended, line, endSession, needSession, login, clearSignInError, logout, getIdentityToken],
  );

  return <AuthContext.Provider value={api}>{children}</AuthContext.Provider>;
}
