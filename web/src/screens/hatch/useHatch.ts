import { useCallback, useEffect, useRef, useState } from 'react';
import { cleanName } from '../../lib/nameClean';
import { dailyResetDelay } from '../../lib/dailyReset';
import { markNewborn } from '../../pet/newborn';
import { go, petPath, useLocation } from '../../route';
import { useAuth } from '../../seams/auth';
import { WorkerError, workerApi, type ClosedReason, type HatchStatus } from '../../seams/worker';
import { takeReturnText } from '../../signin/returnPlace';
import { fitName } from './name';
import { activeHatchPost, clearPendingName, keepPendingName, pendingName, trackHatchPost } from './pendingBirth';

// Current chain ownership decides eligibility. A historical birth is never a successful answer to a pending repeat.
export type HatchView =
  | { kind: 'checking' }
  | { kind: 'unreachable' }
  | { kind: 'closed'; reason: ClosedReason; until?: string }
  | { kind: 'already'; tokenId: string; name: string }
  | { kind: 'signed-out' }
  | { kind: 'form' };

type Check = { kind: 'checking' } | { kind: 'status'; data: HatchStatus } | { kind: 'failed' };
type Birth = 'idle' | 'hatching' | 'not_hatched';

/** How often a page closed by a pause looks again: as the Pet screen polls. */
const PAUSE_LOOK_MS = 5000;

export interface Friend {
  tokenId: string;
  name: string;
}

export function useHatch(from: string | null) {
  const auth = useAuth();
  const authRef = useRef(auth);
  authRef.current = auth;
  const [name, setNameRaw] = useState(() => pendingName(auth.nearAccountId) ?? '');
  const [check, setCheck] = useState<Check>({ kind: 'checking' });
  const [attempt, setAttempt] = useState(0);
  const [birth, setBirth] = useState<Birth>(() => pendingName(auth.nearAccountId) === null ? 'idle' : 'hatching');
  const [nameRefused, setNameRefused] = useState(false);
  // 'loading' while the friend's pet is being read: the way out waits for its name
  const [friend, setFriend] = useState<Friend | null | 'loading'>(from ? 'loading' : null);
  const [known, setKnown] = useState<NonNullable<HatchStatus['knownPets']>>([]);
  const inFlightAccount = useRef<{ account: string | null } | null>(null);
  const birthGeneration = useRef(0);
  const accountRef = useRef(auth.nearAccountId);
  const isPosting = (account: string | null) => inFlightAccount.current !== null && inFlightAccount.current.account === account;

  useEffect(() => {
    if (accountRef.current === auth.nearAccountId) return;
    accountRef.current = auth.nearAccountId;
    birthGeneration.current += 1;
    setKnown([]);
    setNameRaw(pendingName(auth.nearAccountId) ?? '');
    setBirth(pendingName(auth.nearAccountId) === null ? 'idle' : 'hatching');
    setNameRefused(false);
  }, [auth.nearAccountId]);
  useEffect(() => {
    if (!auth.authenticated) setKnown([]);
  }, [auth.authenticated]);

  // A remount inherits the unresolved request, including the time spent obtaining its token.
  useEffect(() => {
    const post = activeHatchPost(auth.nearAccountId);
    if (post === null) return undefined;
    let live = true;
    setBirth('hatching');
    void post.then(() => { if (live) setAttempt((a) => a + 1); });
    return () => { live = false; };
  }, [auth.nearAccountId]);

  // Check current ownership and the original mint attempt on load, session change and «Try again».
  useEffect(() => {
    if (!auth.ready) {
      setCheck({ kind: 'checking' });
      return undefined;
    }
    let live = true;
    setCheck({ kind: 'checking' });
    void (async () => {
      try {
        const requestGeneration = birthGeneration.current;
        const startedWhilePosting = activeHatchPost(auth.nearAccountId) !== null;
        const token = auth.authenticated ? await auth.getIdentityToken() : null;
        // a signed-in page whose token is gone: the session ended before anything was shown
        if (auth.authenticated && token === null) throw new WorkerError(401, 'signed_out');
        const data = await workerApi.hatchStatus(token);
        if (live) {
          setCheck({ kind: 'status', data });
          setKnown(data.knownPets ?? []);
          if (startedWhilePosting || activeHatchPost(auth.nearAccountId) !== null) {
            setBirth('hatching');
          } else if (data.pending) {
            const saved = pendingName(auth.nearAccountId);
            if (saved !== null) setNameRaw(saved);
            setBirth('hatching');
          } else if (data.tokenId) {
            clearPendingName(auth.nearAccountId);
            markNewborn(data.tokenId);
            go(petPath(data.tokenId, from));
          } else if (data.currentPet || data.already) {
            // A gift may have arrived during a pending mint. It is owned, but is not a newborn.
            clearPendingName(auth.nearAccountId);
            setBirth('idle');
          } else if (data.failed) {
            const saved = pendingName(auth.nearAccountId);
            if (saved !== null) setNameRaw(saved);
            clearPendingName(auth.nearAccountId);
            setBirth('not_hatched');
          } else {
            // A look begun before the POST, or answered while it is still running, cannot say whether that POST
            // will create a signed birth flight. Only a later look may release the saved name.
            if (!isPosting(auth.nearAccountId) && requestGeneration === birthGeneration.current) {
              const saved = pendingName(auth.nearAccountId);
              if (saved !== null) {
                setNameRaw(saved);
                clearPendingName(auth.nearAccountId);
              }
              setBirth('idle');
            }
          }
        }
      } catch (e) {
        if (!live) return;
        // a `401` on the first load: nothing to hold, the page is the visitor's at once — `authenticated` turns false and
        // this effect asks again as a visitor
        if (e instanceof WorkerError && e.status === 401) authRef.current.endSession(false);
        else setCheck({ kind: 'failed' });
      }
    })();
    return () => {
      live = false;
    };
  }, [auth.ready, auth.authenticated, auth.nearAccountId, attempt, from]);

  // A signed birth continues to be checked after the POST returns, after a reload, and when the tab returns.
  useEffect(() => {
    if (birth !== 'hatching' || !auth.ready || !auth.authenticated || auth.nearAccountId === null) return undefined;
    let live = true;
    const look = async () => {
      if (document.hidden || !live) return;
      const requestGeneration = birthGeneration.current;
      const startedWhilePosting = isPosting(auth.nearAccountId) || activeHatchPost(auth.nearAccountId) !== null;
      try {
        const token = await auth.getIdentityToken();
        if (token === null) return;
        const data = await workerApi.hatchStatus(token, { look: true });
        if (!live) return;
        setCheck({ kind: 'status', data });
        setKnown(data.knownPets ?? []);
        if (startedWhilePosting || activeHatchPost(auth.nearAccountId) !== null) {
          setBirth('hatching');
        } else if (data.tokenId) {
          clearPendingName(auth.nearAccountId);
          markNewborn(data.tokenId);
          go(petPath(data.tokenId, from));
        } else if (data.currentPet || data.already) {
          clearPendingName(auth.nearAccountId);
          setBirth('idle');
        } else if (data.failed) {
          const saved = pendingName(auth.nearAccountId);
          if (saved !== null) setNameRaw(saved);
          clearPendingName(auth.nearAccountId);
          setBirth('not_hatched');
        } else if (!data.pending && !startedWhilePosting && !isPosting(auth.nearAccountId) && requestGeneration === birthGeneration.current) {
          const saved = pendingName(auth.nearAccountId);
          if (saved !== null) setNameRaw(saved);
          clearPendingName(auth.nearAccountId);
          setBirth('idle');
        }
      } catch { /* the original hash remains under watch on the next look */ }
    };
    const timer = setInterval(() => void look(), PAUSE_LOOK_MS);
    document.addEventListener('visibilitychange', look);
    return () => {
      live = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', look);
    };
  }, [birth, auth.ready, auth.authenticated, auth.nearAccountId, auth.getIdentityToken, from]);

  // The friend's pet from `?from=`: only its name is needed, for «Back to {friend_pet}».
  useEffect(() => {
    if (!from) {
      setFriend(null);
      return undefined;
    }
    let live = true;
    setFriend('loading');
    workerApi.pet(null, from).then(
      (pet) => live && setFriend({ tokenId: from, name: pet.name }),
      () => live && setFriend(null),
    );
    return () => {
      live = false;
    };
  }, [from]);

  // Pauses are checked every five seconds. A daily closure waits for the Worker's stated reset, then retries if it
  // still reports closed. A failed look keeps the last known state.
  // A session that ended stops the looks of the page it holds: no new data loads, the page stands as it is (`Session expiry
  // flow`). A visitor's page, past that hold, looks as any visitor's does.
  const held = auth.sessionEnded && auth.authenticated;
  const closedFor = check.kind === 'status' && !check.data.open && !held ? check.data.reason : undefined;
  const closedUntil = check.kind === 'status' ? check.data.until : undefined;
  const closedServerTime = check.kind === 'status' ? check.data.serverTime : undefined;
  const dailyBoundary = useRef<{ until: string | undefined; reached: boolean }>({ until: undefined, reached: false });
  // A player may receive a gift in another tab while the open form stands. Re-read on return.
  useEffect(() => {
    if (held || birth === 'hatching' || check.kind !== 'status' || !check.data.open) return undefined;
    const onVisible = () => { if (!document.hidden) setAttempt((a) => a + 1); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [held, birth, check]);
  useEffect(() => {
    if (closedFor === undefined) {
      dailyBoundary.current = { until: undefined, reached: false };
      return undefined;
    }
    if (closedFor !== 'daily') dailyBoundary.current = { until: undefined, reached: false };
    let live = true;
    const look = async () => {
      if (document.hidden) return;
      try {
        const token = auth.authenticated ? await auth.getIdentityToken() : null;
        if (auth.authenticated && token === null) throw new WorkerError(401, 'signed_out');
        const data = await workerApi.hatchStatus(token, { look: true });
        if (live) {
          setCheck({ kind: 'status', data });
          setKnown(data.knownPets ?? []);
        }
      } catch (e) {
        // a `401` ends the session; any other failure: the next look asks again
        if (live && e instanceof WorkerError && e.status === 401) authRef.current.endSession();
      }
    };
    let timer: number | undefined;
    let retry: number | undefined;
    if (closedFor === 'daily') {
      if (dailyBoundary.current.until !== closedUntil) dailyBoundary.current = { until: closedUntil, reached: false };
      const delay = dailyBoundary.current.reached ? PAUSE_LOOK_MS : dailyResetDelay(closedUntil, closedServerTime);
      timer = window.setTimeout(() => {
        dailyBoundary.current.reached = true;
        void look();
        retry = window.setInterval(() => void look(), PAUSE_LOOK_MS);
      }, delay);
    } else {
      retry = window.setInterval(() => void look(), PAUSE_LOOK_MS);
    }
    document.addEventListener('visibilitychange', look);
    return () => {
      live = false;
      if (timer !== undefined) clearTimeout(timer);
      if (retry !== undefined) clearInterval(retry);
      document.removeEventListener('visibilitychange', look);
    };
  }, [closedFor, closedUntil, closedServerTime, auth]);

  const view: HatchView = (() => {
    if (birth === 'hatching' && auth.authenticated) return { kind: 'form' };
    if (check.kind === 'checking') return { kind: 'checking' };
    if (check.kind === 'failed') return { kind: 'unreachable' };
    const { data } = check;
    if (!auth.authenticated && data.open) return { kind: 'signed-out' };
    const owned = data.currentPet ?? data.already;
    if (owned) return { kind: 'already', tokenId: owned.tokenId, name: owned.name };
    if (!data.open) return { kind: 'closed', reason: data.reason ?? 'service', until: data.until };
    if (!auth.authenticated) return { kind: 'signed-out' };
    return { kind: 'form' };
  })();

  // The text of a sign-in from the ended-session line comes back to this address once the view is decided: the name field
  // takes it, unsent; a view with no such field takes it and drops it unseen (`Session expiry flow` › `typed text after
  // sign-in`). A screen that could not reach the game is not decided: «Try again» asks again.
  const here = useLocation();
  const kind = view.kind;
  useEffect(() => {
    if (kind === 'checking' || kind === 'unreachable') return;
    const text = takeReturnText(here);
    if (text !== null && kind !== 'already') setNameRaw(fitName('', text));
  }, [kind, here]);

  const setName = useCallback((next: string) => {
    setNameRaw((prev) => fitName(prev, next));
    setNameRefused(false);
  }, []);

  const submit = useCallback(async () => {
    // a second tap while a birth is under way makes no second request
    if (isPosting(auth.nearAccountId) || activeHatchPost(auth.nearAccountId) !== null || birth === 'hatching' || name === '' || view.kind !== 'form') return;
    // a session that ended: the line, nothing sent, the name stays
    if (!auth.needSession()) return;
    const account = auth.nearAccountId;
    inFlightAccount.current = { account };
    let settlePost!: () => void;
    trackHatchPost(auth.nearAccountId, new Promise<void>((resolve) => { settlePost = resolve; }));
    birthGeneration.current += 1;
    keepPendingName(auth.nearAccountId, name);
    setBirth('hatching');
    setNameRefused(false);
    try {
      const token = await auth.getIdentityToken();
      if (authRef.current.nearAccountId !== account || !authRef.current.authenticated) return;
      if (token === null) {
        clearPendingName(auth.nearAccountId);
        auth.endSession(true, true);
        setBirth('idle');
        return;
      }
      const result = await workerApi.hatch(token, name);
      if (authRef.current.nearAccountId !== account || !authRef.current.authenticated) return;
      if ('pending' in result) return;
      const { tokenId } = result;
      clearPendingName(auth.nearAccountId);
      // the tab stays «Hatching…» until the Pet screen takes over
      markNewborn(tokenId);
      go(petPath(tokenId, from));
    } catch (e) {
      if (authRef.current.nearAccountId !== account || !authRef.current.authenticated) return;
      const status = e instanceof WorkerError ? e.status : 0;
      const code = e instanceof WorkerError ? e.code : '';
      if (code === 'name_rejected') {
        clearPendingName(auth.nearAccountId);
        setNameRefused(true);
        setBirth('idle');
      } else if (code === 'not_hatched') {
        clearPendingName(auth.nearAccountId);
        setBirth('not_hatched');
      } else if (status === 401) {
        // the session ended under this tap: the same line as when it had ended before
        auth.endSession(true, true);
        clearPendingName(auth.nearAccountId);
        setBirth('idle');
      } else if (code === 'closed' || code === 'already') {
        // closed between opening the screen and the tap, or hatched elsewhere meanwhile: the page asks again
        clearPendingName(auth.nearAccountId);
        setBirth('idle');
        setAttempt((a) => a + 1);
      } else {
        // A missing POST answer may have followed a signed transaction: keep its name and wait for GET to settle it.
        if (status !== 0 && code !== 'chain_unreachable') {
          clearPendingName(auth.nearAccountId);
          setBirth('idle');
          setCheck({ kind: 'failed' });
        }
      }
    } finally {
      if (inFlightAccount.current?.account === account) inFlightAccount.current = null;
      settlePost();
    }
  }, [auth, name, from, birth, view.kind]);

  const tryAgain = useCallback(() => {
    // a session that ended: the line, nothing asked, the view stands
    if (held) auth.needSession();
    else setAttempt((a) => a + 1);
  }, [held, auth]);

  const cleaned = cleanName(name);
  return { name, setName, cleaned, view, birth, nameRefused, friend, known, submit, tryAgain };
}
