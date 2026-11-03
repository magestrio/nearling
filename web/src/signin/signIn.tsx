// One door to a sign-in. Every control that needs one — «Sign in», «Feed {name}», «Hatch my pet», «Played here before? Sign
// in» — calls `begin`. The order (design.md › Решения › One door to a sign-in): the gate is read at the tap; closed for all —
// the Sign-in closed sheet; closed for new and the player is not `returning` — the same; an in-app browser — Open in browser
// sheet; else the place waits in the tab, `sign_in_started`, and the provider starts Google. The sheets are drawn once, by
// `SignInLayer`, and hold the tapped action, so «Played here before? Sign in» carries `feed` on.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useIsDesktop } from '../ds/util';
import { useAuth } from '../seams/auth';
import { WorkerError } from '../seams/worker';
import { track } from '../track';
import { ClosedSheet } from './ClosedSheet';
import { gateBlocks, readGate } from './gate';
import { thisBrowser, type InApp } from './inApp';
import { OpenInBrowserSheet } from './OpenInBrowserSheet';
import { clearOutcome } from './outcome';
import { fromOf, markSignInUnderWay, peekReturnPlace, rememberReturnPlace, signInUnderWay } from './returnPlace';

export type SignInAction = 'signin' | 'feed' | 'skill' | 'errand' | 'adapter' | 'code';

/** Why the gate could not be read at the tap: `Connection rule` › «сервер недоступен», or «слишком много запросов». */
export type GateReadFailure = 'unreachable' | 'busy';

export interface BeginOptions {
  /** «Played here before? Sign in»: the player says they have signed in this month, and the closed-for-new gate lets them
   *  through; the server decides after Google. */
  returning?: boolean;
  /** the text in the field, from the line of an ended session: it waits in the tab, beside the place, for the sign-in */
  text?: string;
}

/** What `SignInLayer` shows over the page. */
export type SignInSheet =
  | { kind: 'closed_new' | 'closed_all'; until: string; action: SignInAction; text?: string }
  /** `inApp` is null for the phone's fallback after a sign-in that did not work: the browser was not recognised as in-app */
  | { kind: 'open_browser'; inApp: InApp | null; action: SignInAction; place: string };

export interface SignInApi {
  begin(action: SignInAction, options?: BeginOptions): void;
  /** the sheet the tap ended in, or null */
  sheet: SignInSheet | null;
  closeSheet(): void;
  /** the gate could not be read at the tap: no walk to Google; null when it could */
  readFailed: GateReadFailure | null;
  /** «Try again» of that line: the same tap once more */
  retry(): void;
  /** «Open in browser» of the phone's fallback line (`Sign-in flow` › «запасной путь на телефоне») */
  openInBrowser(action?: SignInAction): void;
}

const SignInContext = createContext<SignInApi | null>(null);

export function useSignIn(): SignInApi {
  const api = useContext(SignInContext);
  if (!api) throw new Error('useSignIn needs a SignInLayer above it');
  return api;
}

export function SignInLayer({ children }: { children?: ReactNode }) {
  const auth = useAuth();
  const desktop = useIsDesktop();
  const authRef = useRef(auth);
  authRef.current = auth;
  const [sheet, setSheet] = useState<SignInSheet | null>(null);
  const [readFailed, setReadFailed] = useState<GateReadFailure | null>(null);
  const reading = useRef(false);
  // what a sheet gives the focus back to: the control tapped, which the page going inert would otherwise lose
  const opener = useRef<HTMLElement | null>(null);
  const lastTap = useRef<{ action: SignInAction; options?: BeginOptions } | null>(null);
  const noteOpener = () => {
    opener.current = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
  };

  const begin = useCallback((action: SignInAction, options?: BeginOptions) => {
    // a second tap while the gate is being read, or while Google is starting, changes nothing: the address is `/` by then, the
    // page is still there, and the tap would read `/` for its place
    if (reading.current || signInUnderWay()) return;
    reading.current = true;
    lastTap.current = { action, ...(options ? { options } : {}) };
    noteOpener();
    setReadFailed(null);
    setSheet(null);
    clearOutcome();
    authRef.current.clearSignInError();
    const place = window.location.pathname + window.location.search;
    const home = window.location.pathname === '/';
    const from = fromOf(place);
    void (async () => {
      try {
        let gate;
        try {
          gate = await readGate();
        } catch (e) {
          setReadFailed(e instanceof WorkerError && e.status === 429 ? 'busy' : 'unreachable');
          return;
        }
        const closed = gateBlocks(gate, options?.returning === true);
        if (closed && gate.state !== 'open') {
          track('sign_in_blocked', { reason: closed === 'closed_all' ? 'ceiling' : 'mau', step: 'before_google', from });
          setSheet({ kind: closed, until: gate.until, action, ...(options?.text ? { text: options.text } : {}) });
          return;
        }
        const browser = thisBrowser();
        if (browser.inApp) {
          track('sign_in_started', { from, in_app: browser.inApp });
          setSheet({ kind: 'open_browser', inApp: browser.inApp, action, place });
          return;
        }
        if (home) {
          // a Home tap has no place to come back to: a record left by an earlier sign-in must not lead the tab there. Its own
          // record is what tells a Back from Google on Home from a plain load of `/`
          rememberReturnPlace({ path: '/', action: 'signin' });
        } else {
          // a sign-in cancelled and begun again at the same place keeps the tapped «Feed»
          const before = peekReturnPlace();
          const kept = action === 'signin' && before?.cancelled && before.path === place ? before.action : undefined;
          rememberReturnPlace({ path: place, action: kept ?? action, ...(options?.text ? { text: options.text } : {}) });
        }
        track('sign_in_started', { from, in_app: 'none' });
        markSignInUnderWay(true);
        authRef.current.login();
      } finally {
        reading.current = false;
      }
    })();
  }, []);

  const closeSheet = useCallback(() => setSheet(null), []);

  const retry = useCallback(() => {
    const tap = lastTap.current;
    if (tap) begin(tap.action, tap.options);
  }, [begin]);

  const openInBrowser = useCallback((action: SignInAction = 'signin') => {
    noteOpener();
    setSheet({ kind: 'open_browser', inApp: thisBrowser().inApp, action, place: window.location.pathname + window.location.search });
  }, []);

  // The answers a tap can get without the page leaving. A session that turned up instead ends it in `SessionProvider`, a page
  // that left and was restored in `ReturnToPlace`.
  useEffect(() => {
    if (auth.signInError || auth.walletFailed || auth.refusal || auth.unreachable) markSignInUnderWay(false);
  }, [auth.signInError, auth.walletFailed, auth.refusal, auth.unreachable]);

  // A refusal after Google at the ceiling: the sign-in closed for everyone while the player was at Google. The sheet opens on
  // the screen the tab is led back to; the action is not continued. «mau» has its line under the action instead.
  useEffect(() => {
    if (auth.refusal?.reason === 'ceiling') {
      opener.current = null;
      setSheet({ kind: 'closed_all', until: auth.refusal.until, action: 'signin' });
    }
  }, [auth.refusal]);

  const api = useMemo<SignInApi>(
    () => ({ begin, sheet, closeSheet, readFailed, retry, openInBrowser }),
    [begin, sheet, closeSheet, readFailed, retry, openInBrowser],
  );
  const back = () => opener.current;
  // modal: the centred closed sheet on both viewports, Open in browser on the phone only (a panel beside a live page on desktop)
  const covered = sheet !== null && (sheet.kind !== 'open_browser' || !desktop);
  return (
    <SignInContext.Provider value={api}>
      {/* the page under a sheet that is modal is out of reach (no box of its own); the element stays at one place, so the
          screen under it keeps its state when a sheet opens */}
      <div className="ds-only" inert={covered || undefined}>
        {children}
      </div>
      {/* The sheets stand beside the page, not inside its Shell, which is where the DS sets the text colour and the font: the
          tokens are given here, so the sheet reads the same as in the frames. */}
      <div className="ds-only" style={{ color: 'var(--color-text-primary)', fontFamily: 'var(--font-sans)' }}>
        {sheet && sheet.kind !== 'open_browser' ? (
          <ClosedSheet
            all={sheet.kind === 'closed_all'}
            until={sheet.until}
            onClose={closeSheet}
            onReturning={() => begin(sheet.action, { returning: true, ...(sheet.text ? { text: sheet.text } : {}) })}
            returnFocusTo={back}
          />
        ) : null}
        {sheet?.kind === 'open_browser' ? (
          <OpenInBrowserSheet inApp={sheet.inApp} place={sheet.place} onClose={closeSheet} returnFocusTo={back} />
        ) : null}
      </div>
    </SignInContext.Provider>
  );
}
