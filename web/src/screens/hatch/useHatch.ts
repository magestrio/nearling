import { useCallback, useEffect, useRef, useState } from 'react';
import { cleanName } from '../../lib/nameClean';
import { markNewborn } from '../../pet/newborn';
import { go, petPath, useLocation } from '../../route';
import { useAuth } from '../../seams/auth';
import { WorkerError, workerApi, type ClosedReason, type HatchStatus } from '../../seams/worker';
import { takeReturnText } from '../../signin/returnPlace';
import { fitName } from './name';

// The Hatch screen's state: what the page shows is chosen from the answer of `GET /api/hatch` in the order of
// design.md › «Closed hatching for everyone»: no connection → Connection rule; closed (any reason, any viewer) → its
// line and the way out; already hatched → «Go to {name}»; no session → «Sign in with Google to hatch your pet»;
// otherwise the form. Everything here is the tab's memory: the name, the birth in flight, the friend's name.
export type HatchView =
  | { kind: 'checking' }
  | { kind: 'unreachable'; busy: boolean }
  /** `noPets`: a signed-in player with no pet of their own — the screen has no way out for them (`add-pet` › `no exit`) */
  | { kind: 'closed'; reason: ClosedReason; until?: string; noPets: boolean }
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
  const authRef = useRef(auth);
  authRef.current = auth;
  const [name, setNameRaw] = useState('');
  const [check, setCheck] = useState<Check>({ kind: 'checking' });
  const [attempt, setAttempt] = useState(0);
  const [birth, setBirth] = useState<Birth>('idle');
  const [nameRefused, setNameRefused] = useState(false);
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
    void (async () => {
      try {
        const token = auth.authenticated ? await auth.getIdentityToken() : null;
        // a signed-in page whose token is gone: the session ended before anything was shown
        if (auth.authenticated && token === null) throw new WorkerError(401, 'signed_out');
        const data = await workerApi.hatchStatus(token);
        if (live) setCheck({ kind: 'status', data });
      } catch (e) {
        if (!live) return;
        // a `401` on the first load: nothing to hold, the page is the visitor's at once — `authenticated` turns false and
        // this effect asks again as a visitor
        if (e instanceof WorkerError && e.status === 401) authRef.current.endSession(false);
        else setCheck({ kind: 'failed', busy: e instanceof WorkerError && e.status === 429 });
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
  // A session that ended stops the looks of the page it holds: no new data loads, the page stands as it is (`Session expiry
  // flow`). A visitor's page, past that hold, looks as any visitor's does.
  const held = auth.sessionEnded && auth.authenticated;
  const closedFor = check.kind === 'status' && !check.data.open && !held ? check.data.reason : undefined;
  useEffect(() => {
    if (closedFor === undefined || closedFor === 'daily') return undefined;
    let live = true;
    const look = async () => {
      if (document.hidden) return;
      try {
        const token = auth.authenticated ? await auth.getIdentityToken() : null;
        if (auth.authenticated && token === null) throw new WorkerError(401, 'signed_out');
        const data = await workerApi.hatchStatus(token, { look: true });
        if (live) setCheck({ kind: 'status', data });
      } catch (e) {
        // a `401` ends the session; any other failure: the next look asks again
        if (live && e instanceof WorkerError && e.status === 401) authRef.current.endSession();
      }
    };
    const timer = setInterval(() => void look(), PAUSE_LOOK_MS);
    document.addEventListener('visibilitychange', look);
    return () => {
      live = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', look);
    };
  }, [closedFor, auth]);

  const view: HatchView = (() => {
    if (check.kind === 'checking') return { kind: 'checking' };
    if (check.kind === 'failed') return { kind: 'unreachable', busy: check.busy };
    const { data } = check;
    if (!data.open) return { kind: 'closed', reason: data.reason ?? 'service', until: data.until, noPets: data.noPets === true };
    if (data.already) return { kind: 'already', tokenId: data.already.tokenId, name: data.already.name };
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
    if (inFlight.current || name === '') return;
    // a session that ended: the line, nothing sent, the name stays
    if (!auth.needSession()) return;
    inFlight.current = true;
    setBirth('hatching');
    setNameRefused(false);
    let navigated = false;
    try {
      const token = await auth.getIdentityToken();
      if (token === null) {
        auth.endSession(true, true);
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
        // the session ended under this tap: the same line as when it had ended before
        auth.endSession(true, true);
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

  const tryAgain = useCallback(() => {
    // a session that ended: the line, nothing asked, the view stands
    if (held) auth.needSession();
    else setAttempt((a) => a + 1);
  }, [held, auth]);

  const cleaned = cleanName(name);
  return { name, setName, cleaned, view, birth, nameRefused, friend, submit, tryAgain };
}
