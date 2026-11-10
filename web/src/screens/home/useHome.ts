import { useCallback, useEffect, useRef, useState } from 'react';
import { dailyResetDelay } from '../../lib/dailyReset';
import { navigate, petPath, useLocation } from '../../route';
import { useAuth } from '../../seams/auth';
import { WorkerError, workerApi, type Me, type SignInGate } from '../../seams/worker';
import { readGate } from '../../signin/gate';
import { track } from '../../track';
import { hasEvidenceIntent } from './evidenceIntent';

// A signed-in player with no current pet stays here. The Worker derives ownership, links and birth status from fresh reads.
export type HomeView =
  | { kind: 'loading' }
  | { kind: 'error'; busy: boolean }
  | { kind: 'petless-loading' }
  | { kind: 'petless-error' }
  | { kind: 'petless'; knownPets: NonNullable<Me['knownPets']>; birth: NonNullable<Me['birth']> }
  | { kind: 'signed-out' }
  | { kind: 'closed'; all: boolean; until: string }
  | { kind: 'evidence' }
  /** a signed-in player on the way to their pet: the page is not drawn */
  | { kind: 'leaving' };

type Read =
  | { as: 'visitor' | 'player'; kind: 'asking' }
  | { as: 'visitor' | 'player'; kind: 'failed'; busy: boolean }
  | { as: 'visitor'; kind: 'gate'; gate: SignInGate }
  | { as: 'player'; kind: 'petless'; data: Me }
  | { as: 'player'; kind: 'evidence' }
  | { as: 'player'; kind: 'leaving' };

export function useHome() {
  const location = useLocation();
  const evidenceIntent = hasEvidenceIntent(new URL(location, 'http://local').search);
  const auth = useAuth();
  const authRef = useRef(auth);
  authRef.current = auth;
  const [attempt, setAttempt] = useState(0);
  const who = auth.authenticated ? 'player' : 'visitor';
  const [read, setRead] = useState<Read>({ as: who, kind: 'asking' });
  const dailyBoundary = useRef<{ until: string | undefined; reached: boolean }>({ until: undefined, reached: false });

  // A gift can change ownership while the tab is away.
  useEffect(() => {
    if (!auth.authenticated) return undefined;
    const onVisible = () => { if (document.visibilityState === 'visible') setAttempt((a) => a + 1); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [auth.authenticated]);

  // The Worker's response time anchors the first daily-reset read; only a missed boundary is retried.
  useEffect(() => {
    if (!auth.authenticated) return undefined;
    if (read.kind === 'asking') return undefined;
    const birth = read.kind === 'petless' ? read.data.birth : undefined;
    const daily = !birth?.open && birth?.reason === 'daily';
    if (!daily && !dailyBoundary.current.reached) return undefined;
    const until = daily ? birth?.until : dailyBoundary.current.until;
    if (daily && dailyBoundary.current.until !== until) dailyBoundary.current = { until, reached: false };
    const delay = dailyBoundary.current.reached ? 5000 : dailyResetDelay(until, read.kind === 'petless' ? read.data.serverTime : undefined);
    const timer = window.setTimeout(() => {
      dailyBoundary.current.reached = true;
      if (document.visibilityState === 'visible') setAttempt((a) => a + 1);
    }, delay);
    return () => window.clearTimeout(timer);
  }, [auth.authenticated, read]);

  // A visitor reads admission; a player reads fresh ownership, known links and birth status.
  useEffect(() => {
    // the return from Google is led to its place by `ReturnToPlace`, which has had its turn: the address has moved on
    if (!auth.ready || auth.unreachable || window.location.pathname !== '/') return undefined;
    let live = true;
    if (who === 'visitor') dailyBoundary.current = { until: undefined, reached: false };
    setRead({ as: who, kind: 'asking' });
    void (async () => {
      try {
        if (who === 'player' && evidenceIntent) {
          if (live) setRead({ as: 'player', kind: 'evidence' });
          return;
        }
        if (who === 'player') {
          const token = await authRef.current.getIdentityToken();
          if (token === null) throw new WorkerError(401, 'signed_out');
          const me = await workerApi.me(token);
          if (!live) return;
          if (me.currentPet || me.birth?.open || me.birth?.reason !== 'daily') dailyBoundary.current = { until: undefined, reached: false };
          if (me.currentPet) {
            setRead({ as: 'player', kind: 'leaving' });
            navigate(petPath(me.currentPet.tokenId));
          } else {
            setRead({ as: 'player', kind: 'petless', data: me });
          }
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
  }, [auth.ready, auth.unreachable, who, attempt, evidenceIntent]);

  const view: HomeView = (() => {
    if (!auth.ready) return who === 'player' ? { kind: 'petless-loading' } : { kind: 'loading' };
    if (auth.unreachable) return who === 'player' ? { kind: 'petless-error' } : { kind: 'error', busy: false };
    if (read.as !== who) return who === 'player' ? { kind: 'petless-loading' } : { kind: 'loading' };
    if (read.kind === 'failed') return who === 'player' ? { kind: 'petless-error' } : { kind: 'error', busy: read.busy };
    if (read.kind === 'leaving') return { kind: 'leaving' };
    if (read.kind === 'evidence') return { kind: 'evidence' };
    if (read.kind === 'gate') {
      return read.gate.state === 'open' ? { kind: 'signed-out' } : { kind: 'closed', all: read.gate.state === 'closed_all', until: read.gate.until };
    }
    if (read.kind === 'petless') return read.data.birth
      ? { kind: 'petless', knownPets: read.data.knownPets ?? [], birth: read.data.birth }
      : { kind: 'petless-error' };
    return who === 'player' ? { kind: 'petless-loading' } : { kind: 'loading' };
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
