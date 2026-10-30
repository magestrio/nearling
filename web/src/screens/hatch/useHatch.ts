import { useCallback, useEffect, useRef, useState } from 'react';
import { cleanName } from '../../lib/nameClean';
import { markNewborn } from '../../pet/newborn';
import { go, hatchPath, petPath } from '../../route';
import { useAuth } from '../../seams/auth';
import { WorkerError, workerApi, type ClosedReason, type HatchStatus } from '../../seams/worker';
import { rememberReturnPlace } from '../../signin/returnPlace';
import { fitName } from './name';

// The Hatch screen's state: what the page shows is chosen from the answer of `GET /api/hatch` in the order of
// design.md › «Closed hatching for everyone»: no connection → Connection rule; closed (any reason, any viewer) → its
// line and the way out; already hatched → «Go to {name}»; no session → «Sign in with Google to hatch your pet»;
// otherwise the form. Everything here is the tab's memory: the name, the birth in flight, the friend's name.
export type HatchView =
  | { kind: 'checking' }
  | { kind: 'unreachable'; busy: boolean }
  | { kind: 'closed'; reason: ClosedReason; until?: string }
  | { kind: 'already'; tokenId: string; name: string }
  | { kind: 'signed-out' }
  | { kind: 'form' };

type Check = { kind: 'checking' } | { kind: 'status'; data: HatchStatus } | { kind: 'failed'; busy: boolean };
type Birth = 'idle' | 'hatching' | 'not_hatched';

/** How often a page closed by a pause looks again: as the Pet screen polls. */
const PAUSE_LOOK_MS = 5000;

export interface Friend {
  tokenId: string;
  name: string;
}

export function useHatch(from: string | null) {
  const auth = useAuth();
  const [name, setNameRaw] = useState('');
  const [check, setCheck] = useState<Check>({ kind: 'checking' });
  const [attempt, setAttempt] = useState(0);
  const [birth, setBirth] = useState<Birth>('idle');
  const [nameRefused, setNameRefused] = useState(false);
  const [expired, setExpired] = useState(false);
  // 'loading' while the friend's pet is being read: the way out waits for its name
  const [friend, setFriend] = useState<Friend | null | 'loading'>(from ? 'loading' : null);
  const inFlight = useRef(false);

  // «Is hatching open, and did this player already hatch» — on load, when the sign-in changes, and on «Try again».
  useEffect(() => {
    if (!auth.ready) {
      setCheck({ kind: 'checking' });
      return undefined;
    }
    let live = true;
    setCheck({ kind: 'checking' });
    setExpired(false);
    void (async () => {
      try {
        const token = auth.authenticated ? await auth.getIdentityToken() : null;
        let data: HatchStatus;
        try {
          data = await workerApi.hatchStatus(token);
        } catch (e) {
          // an expired session: the page is the visitor's, «Sign in with Google…» at once
          if (e instanceof WorkerError && e.status === 401) {
            data = await workerApi.hatchStatus(null);
            if (live) setExpired(true);
          } else throw e;
        }
        if (live) setCheck({ kind: 'status', data });
      } catch (e) {
        if (live) setCheck({ kind: 'failed', busy: e instanceof WorkerError && e.status === 429 });
      }
    })();
    return () => {
      live = false;
    };
  }, [auth.ready, auth.authenticated, attempt]);

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

  // Closed for a reason with no hour on it: the pause can lift while the page stands (`Service pause data` ›
  // «пауза снялась»). A visible tab asks again; the name stays, and the form comes back by itself. A failed look changes
  // nothing: the page says what it knew.
  const closedFor = check.kind === 'status' && !check.data.open ? check.data.reason : undefined;
  useEffect(() => {
    if (closedFor === undefined || closedFor === 'daily') return undefined;
    let live = true;
    const look = async () => {
      if (document.hidden) return;
      try {
        const token = auth.authenticated && !expired ? await auth.getIdentityToken() : null;
        const data = await workerApi.hatchStatus(token, { look: true });
        if (live) setCheck({ kind: 'status', data });
      } catch {
        // the next look asks again
      }
    };
    const timer = setInterval(() => void look(), PAUSE_LOOK_MS);
    document.addEventListener('visibilitychange', look);
    return () => {
      live = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', look);
    };
  }, [closedFor, auth, expired]);

  const view: HatchView = (() => {
    if (check.kind === 'checking') return { kind: 'checking' };
    if (check.kind === 'failed') return { kind: 'unreachable', busy: check.busy };
    const { data } = check;
    if (!data.open) return { kind: 'closed', reason: data.reason ?? 'service', until: data.until };
    if (data.already) return { kind: 'already', tokenId: data.already.tokenId, name: data.already.name };
    if (!auth.authenticated || expired) return { kind: 'signed-out' };
    return { kind: 'form' };
  })();

  const setName = useCallback((next: string) => {
    setNameRaw((prev) => fitName(prev, next));
    setNameRefused(false);
  }, []);

  const submit = useCallback(async () => {
    // a second tap while a birth is under way makes no second request
    if (inFlight.current || name === '') return;
    inFlight.current = true;
    setBirth('hatching');
    setNameRefused(false);
    let navigated = false;
    try {
      const token = await auth.getIdentityToken();
      if (token === null) {
        setExpired(true);
        setBirth('idle');
        return;
      }
      const { tokenId } = await workerApi.hatch(token, name);
      // the tab stays «Hatching…» until the Pet screen takes over
      markNewborn(tokenId);
      go(petPath(tokenId, from));
      navigated = true;
    } catch (e) {
      const status = e instanceof WorkerError ? e.status : 0;
      const code = e instanceof WorkerError ? e.code : '';
      if (code === 'name_rejected') {
        setNameRefused(true);
        setBirth('idle');
      } else if (code === 'not_hatched') {
        setBirth('not_hatched');
      } else if (status === 401) {
        setExpired(true);
        setBirth('idle');
      } else if (code === 'closed' || code === 'already') {
        // closed between opening the screen and the tap, or hatched elsewhere meanwhile: the page asks again
        setBirth('idle');
        setAttempt((a) => a + 1);
      } else {
        setBirth('idle');
        setCheck({ kind: 'failed', busy: status === 429 });
      }
    } finally {
      if (!navigated) inFlight.current = false;
    }
  }, [auth, name, from]);

  const tryAgain = useCallback(() => setAttempt((a) => a + 1), []);

  /** The tap on «Sign in with Google to hatch your pet»: the place waits in the tab, Privy gets `/`. */
  const signIn = useCallback(() => {
    rememberReturnPlace({ path: hatchPath(from), action: 'signin' });
    window.history.replaceState(null, '', '/');
    auth.login();
  }, [auth, from]);

  const cleaned = cleanName(name);
  return { name, setName, cleaned, view, birth, nameRefused, friend, submit, tryAgain, signIn };
}
