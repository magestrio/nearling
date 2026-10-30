import { useCallback, useEffect, useRef, useState } from 'react';
import { hatchPath, navigate, petPath } from '../../route';
import { useAuth } from '../../seams/auth';
import { WorkerError, workerApi, type SignInGate } from '../../seams/worker';
import { readGate } from '../../signin/gate';
import { track } from '../../track';

// The Home screen's state (add-account › Home screen): a visitor sees what the game is and how to enter it — or, while sign-in
// is closed, the closed view with the server's word on it; a signed-in player is led to their pet at once and never sees the
// page (`Sign-in flow` › «вошёл с главной»). A load that gets no answer is `Connection rule` › «сервер недоступен».
export type HomeView =
  | { kind: 'loading' }
  | { kind: 'error'; busy: boolean }
  | { kind: 'signed-out' }
  | { kind: 'closed'; all: boolean; until: string }
  /** a signed-in player on the way to their pet: the page is not drawn */
  | { kind: 'leaving' };

type Read =
  | { as: 'visitor' | 'player'; kind: 'asking' }
  | { as: 'visitor' | 'player'; kind: 'failed'; busy: boolean }
  | { as: 'visitor'; kind: 'gate'; gate: SignInGate }
  | { as: 'player'; kind: 'leaving' };

export function useHome() {
  const auth = useAuth();
  const authRef = useRef(auth);
  authRef.current = auth;
  const [attempt, setAttempt] = useState(0);
  const who = auth.authenticated ? 'player' : 'visitor';
  const [read, setRead] = useState<Read>({ as: who, kind: 'asking' });

  // What the tap on the screen is for: a visitor reads the state of the sign-in, a player reads who their current pet is.
  useEffect(() => {
    // the return from Google is led to its place by `ReturnToPlace`, which has had its turn: the address has moved on
    if (!auth.ready || auth.unreachable || window.location.pathname !== '/') return undefined;
    let live = true;
    setRead({ as: who, kind: 'asking' });
    void (async () => {
      try {
        if (who === 'player') {
          const token = await authRef.current.getIdentityToken();
          if (token === null) throw new WorkerError(401, 'signed_out');
          const me = await workerApi.me(token);
          if (!live) return;
          setRead({ as: 'player', kind: 'leaving' });
          // «Several pets rule» (`add-gift`) rebuilds `currentPet`; with none, the Hatch screen
          navigate(me.currentPet ? petPath(me.currentPet.tokenId) : hatchPath());
        } else {
          const gate = await readGate();
          if (live) setRead({ as: 'visitor', kind: 'gate', gate });
        }
      } catch (e) {
        if (!live) return;
        const status = e instanceof WorkerError ? e.status : 0;
        // a session that ended before anything was shown: nothing to hold, the page is the visitor's
        if (status === 401 && who === 'player') authRef.current.endSession(false);
        else setRead({ as: who, kind: 'failed', busy: status === 429 });
      }
    })();
    return () => {
      live = false;
    };
  }, [auth.ready, auth.unreachable, who, attempt]);

  const view: HomeView = (() => {
    if (!auth.ready) return { kind: 'loading' };
    if (auth.unreachable) return { kind: 'error', busy: false };
    if (read.as !== who) return { kind: 'loading' };
    if (read.kind === 'failed') return { kind: 'error', busy: read.busy };
    if (read.kind === 'leaving') return { kind: 'leaving' };
    if (read.kind === 'gate') {
      return read.gate.state === 'open' ? { kind: 'signed-out' } : { kind: 'closed', all: read.gate.state === 'closed_all', until: read.gate.until };
    }
    return { kind: 'loading' };
  })();

  // `sign_in_blocked` once per load of the closed view, with the reason of the answer
  const blocked = useRef(false);
  const closed = view.kind === 'closed' ? view : null;
  useEffect(() => {
    if (!closed || blocked.current) return;
    blocked.current = true;
    track('sign_in_blocked', { reason: closed.all ? 'ceiling' : 'mau', step: 'before_google', from: 'home' });
  }, [closed]);

  /** «Try again» of the connection line: the exchange or the read of the sign-in, by which one failed */
  const tryAgain = useCallback(() => {
    if (authRef.current.unreachable) authRef.current.retrySession();
    else setAttempt((a) => a + 1);
  }, []);

  return { view, tryAgain };
}
