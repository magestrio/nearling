import { useCallback, useEffect, useReducer, useRef } from 'react';
import { useAuth } from '../seams/auth';
import { WorkerError, workerApi } from '../seams/worker';
import { currentFlight, hostOf, onFlight, startMeal, startSnack, type FlightEvent } from './feedFlight';
import { announceFed, type FeedRequest } from './feedRequest';
import { opening, reduce, type Phase, type Standing, type Tapped } from './feedMachine';

// Feed sheet's requests and its poll (`Feed sheet screen`, design.md › «The poll»). The sheet opens at once and fills when
// `GET …/feed` answers; while it is open and idle it reads again every `POLL_FEED_MS`, not in a hidden tab, not once the session
// ended, and at once when the tab comes back. A new answer redraws the sheet. The phases are `feedMachine.ts`'s; the meal on its
// way is the tab's (`feedFlight.ts`): this hook only listens to it while the sheet is open, so a sheet that was closed on the way
// hears nothing and a sheet opened on it starts with «Still checking…».
export const POLL_FEED_MS = 5000;

/** A meal or snack of this tab is on its way, whichever pet it is for. */
function standingNow(): Standing | null {
  const flight = currentFlight();
  return flight === null ? null : { source: flight.source, wasAsleep: flight.wasAsleep };
}

export function useFeedSheet(request: FeedRequest, close: () => void) {
  const auth = useAuth();
  const authRef = useRef(auth);
  authRef.current = auth;
  const closeRef = useRef(close);
  closeRef.current = close;
  // a sheet opened on a meal of this tab that is on its way says «Still checking…» before the first read answers
  const [phase, dispatch] = useReducer(reduce, undefined, () => opening(standingNow()));
  const phaseRef = useRef<Phase>(phase);
  phaseRef.current = phase;
  const unread = useRef(phase.kind === 'sending');
  const reading = useRef(false);
  const alive = useRef(true);
  const { tokenId } = request;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  /** One read. `byTap`: the player's own action asked for it (opening, «Try again»): a session that ended under it closes the
   *  sheet and the line stands (`Session expiry flow` › «сессия кончилась при открытом экране»); a poll that meets a `401` ends the
   *  session and the sheet stands as it is («session ended, no tap yet»). */
  const read = useCallback(
    async (byTap: boolean) => {
      if (reading.current) return;
      reading.current = true;
      try {
        const a = authRef.current;
        const token = a.authenticated ? await a.getIdentityToken() : null;
        // a token keeper with no token for a signed-in sheet: the session ended, as a `401` says it
        if (token === null) throw new WorkerError(401, 'signed_out');
        const sheet = await workerApi.feedSheet(token, tokenId);
        if (!alive.current) return;
        dispatch({ type: 'answer', sheet, standing: standingNow() });
        // the page's plate and the sheet's head show one fullness, also on a page that does not poll
        if (sheet.chain) announceFed({ kind: 'fullness', tokenId, fullness: sheet.fullness });
      } catch (e) {
        if (!alive.current) return;
        if (e instanceof WorkerError && e.status === 401) {
          authRef.current.endSession(true, byTap);
          if (byTap) closeRef.current();
          return;
        }
        dispatch({ type: 'readFailed' });
      } finally {
        reading.current = false;
      }
    },
    [tokenId],
  );

  // The first read, and the read after «Try again» of a failed one.
  useEffect(() => {
    if (phase.kind === 'reading' && !phase.failed) void read(true);
  }, [phase, read]);
  // a sheet seeded with a flight has no `reading` phase to start it
  useEffect(() => {
    if (!unread.current) return;
    unread.current = false;
    void read(true);
  }, [read]);

  // The poll: while the sheet has nothing of this tab on its way, and not once the session ended. A meal of another tab, or of
  // another pet, is watched the same way: the row going away is how the sheet learns it ended.
  const idle = phase.kind === 'open' || phase.kind === 'failed' || (phase.kind === 'sending' && phase.what === null);
  const ended = auth.sessionEnded;
  useEffect(() => {
    if (!idle || ended) return undefined;
    const timer = setInterval(() => {
      if (!document.hidden) void read(false);
    }, POLL_FEED_MS);
    const onVisible = () => {
      if (!document.hidden) void read(false);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [idle, ended, read]);

  /** The pet after a confirmed meal, read once more so the thanks and «Yum!» show it as it is. Best effort: the page reads it too. */
  const refresh = useCallback(async () => {
    try {
      const a = authRef.current;
      const token = a.authenticated ? await a.getIdentityToken() : null;
      if (token === null) return;
      const sheet = await workerApi.feedSheet(token, tokenId);
      if (!alive.current || !sheet.chain) return;
      dispatch({ type: 'fullness', fullness: sheet.fullness });
      announceFed({ kind: 'fullness', tokenId, fullness: sheet.fullness });
    } catch {
      // the head keeps what it showed
    }
  }, [tokenId]);

  // The flight of this tab, while the sheet is open: «Still checking…» at 10 s, and the outcome. A sheet closed on the way is not
  // listening: no message follows (`Feeding outcome rule` › «closed on its way»).
  useEffect(
    () =>
      onFlight((event: FlightEvent) => {
        if (event.kind === 'checking') {
          dispatch({ type: 'checking' });
          return;
        }
        const { flight, end } = event;
        if (end.status === 'session') {
          closeRef.current();
          return;
        }
        if (end.status === 'funding_closed') {
          closeRef.current();
          return;
        }
        // another pet's flight: its sheet only redraws
        if (flight.tokenId !== tokenId || end.status === 'reread') {
          dispatch({ type: 'reread' });
          return;
        }
        if (end.status === 'redraw') {
          dispatch({ type: 'redraw', sheet: end.sheet });
          if (end.sheet.chain) announceFed({ kind: 'fullness', tokenId, fullness: end.sheet.fullness });
          return;
        }
        // a sheet that has no answer yet draws the outcome from the next one: asked for now, not at the next poll
        const blind = phaseRef.current.kind === 'sending' && phaseRef.current.sheet === null;
        if (end.status === 'failed') {
          dispatch({ type: 'outcome', status: 'failed' });
          if (blind) void read(false);
          return;
        }
        dispatch({ type: 'outcome', status: 'ok', ...(end.friend !== undefined ? { friend: end.friend } : {}), hatched: end.hatched });
        if (blind) void read(false);
        else void refresh();
      }),
    [tokenId, refresh, read],
  );

  // The owner's snack, and a meal that woke the pet, close the sheet by itself (`Owner snack flow` › «даёт перекус»).
  useEffect(() => {
    if (phase.kind === 'done') closeRef.current();
  }, [phase.kind]);

  /** A tap on a portion or the snack: the session first (an ended one closes the sheet and the line stands), then the flight. */
  const start = useCallback(
    (what: Tapped, wasAsleep: boolean) => {
      if (!authRef.current.needSession()) {
        closeRef.current();
        return;
      }
      const host = hostOf(authRef.current);
      const started =
        what.kind === 'portion' ? startMeal(host, { tokenId, portion: what.portion, wasAsleep, sharedCode: request.sharedCode }) : startSnack(host, { tokenId, wasAsleep, sharedCode: request.sharedCode });
      if (started) dispatch({ type: 'tap', what });
    },
    [tokenId, request.sharedCode],
  );

  const tap = useCallback(
    (what: Tapped) => {
      const p = phaseRef.current;
      if (p.kind !== 'open' && p.kind !== 'failed') return;
      if (!p.sheet.chain) return;
      start(what, p.sheet.fullness.state === 'asleep');
    },
    [start],
  );

  /** «Try again» of a meal that did not go through: the same portion or snack from the start, a new build and a new signature.
   *  Of a read that failed, or of a failure that is another flight's: the sheet is read again. */
  const tryAgain = useCallback(() => {
    if (!authRef.current.needSession()) {
      closeRef.current();
      return;
    }
    const p = phaseRef.current;
    if (p.kind === 'failed' && p.what !== null) {
      start(p.what, p.sheet.fullness.state === 'asleep');
      return;
    }
    dispatch({ type: 'retry' });
  }, [start]);

  /** «Add NEAR» is a step inside the sheet; the session first. */
  const addNear = useCallback(() => {
    if (!authRef.current.needSession()) {
      closeRef.current();
      return;
    }
    dispatch({ type: 'addNear' });
  }, []);

  /** Back from the step: with the sheet read again when NEAR arrived, so the new amount is in it. */
  const back = useCallback(async (arrived: boolean) => {
    if (!arrived) {
      dispatch({ type: 'back' });
      return;
    }
    try {
      const a = authRef.current;
      const token = a.authenticated ? await a.getIdentityToken() : null;
      const sheet = token === null ? null : await workerApi.feedSheet(token, tokenId);
      if (!alive.current) return;
      if (sheet?.chain) {
        dispatch({ type: 'back', sheet });
        announceFed({ kind: 'fullness', tokenId, fullness: sheet.fullness });
        return;
      }
    } catch {
      // the sheet it came from, as it was: the poll reads the new amount
    }
    if (alive.current) dispatch({ type: 'back' });
  }, [tokenId]);

  const done = useCallback(() => dispatch({ type: 'done' }), []);

  return { phase, tap, tryAgain, addNear, back, done };
}
