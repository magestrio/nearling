import { useEffect } from 'react';
import { navigate, replaceLocation } from '../route';
import { queueAction } from '../screens/pet/parts';
import { useAuth } from '../seams/auth';
import { setOutcome } from './outcome';
import {
  clearReturnPlace,
  eraseLeftBehind,
  holdReturnSkill,
  holdReturnText,
  markSignInUnderWay,
  peekReturnPlace,
  rememberReturnPlace,
  signInUnderWay,
  takeReturnPlace,
  type ReturnPlace,
} from './returnPlace';

/** A sign-in begun on Home leaves `{ path: '/' }`: it tells a Back from Google from a plain load of `/`, and is no place to lead
 *  the tab to. Nor is a cancel's record: `begin` writes a new one for a sign-in, so a session that finds it was opened elsewhere. */
const placeOf = (record: ReturnPlace | null): ReturnPlace | null => (record && record.path !== '/' && !record.cancelled ? record : null);

/** A sign-in that came back with no session: the place and the action stay, the text goes. */
function rewriteCancelled(place: ReturnPlace): void {
  rememberReturnPlace({ path: place.path, ...(place.action ? { action: place.action } : {}), cancelled: true });
}

/** Back from Google the tab is at `/` — the one address Privy gets — and the place it began at waits in the tab. This leads
 *  the tab back to it, in every build:
 *  - a sign-in that is whole: the place, the tapped «Feed» to run there, and the typed text of an ended session, held for the
 *    screen to take (`takeReturnText`);
 *  - a sign-in whose wallet failed: the place too, `/` has no screen of its own, and the place's «Sign in with Google…» is the
 *    tap that tries the wallet again. Nothing the player tapped is run for them then;
 *  - a refusal after Google, or a sign-in that did not work: the place with no action run;
 *  - a cancel — a closed window, a `signInError`, or the Back button from Google, which brings no callback at all (`/` with a
 *    place in the tab, no session and no `privy_oauth_code`): the place, the record rewritten `cancelled` without the text and
 *    with the action kept. A page restored from the back-forward cache has its old state in memory, so it is loaded afresh.
 *  A sign-in begun on Home has no place: its outcome stands on Home, Back from Google included. A sign-in that failed before the
 *  page left is at its place already: its line stands there, with no move. While a tap's sign-in is under way, `/` is no Back
 *  from Google, and a `cancelled` record at `/` never is: `begin` writes none, so Home stays.
 *  A record that a sign-in left behind (the player typed another address at Google) is erased at the next start elsewhere. */
export function ReturnToPlace() {
  const auth = useAuth();

  useEffect(() => {
    const here = window.location.pathname + window.location.search;
    if (window.location.pathname === '/') return;
    // a cancel's record for this very address: the tab was led back here by a full load (Back from Google), and the phone's
    // fallback line has to be there
    if (peekReturnPlace()?.cancelled && peekReturnPlace()?.path === here) setOutcome({ kind: 'cancelled', place: here });
    eraseLeftBehind(here);
  }, []);

  useEffect(() => {
    const onShow = (e: PageTransitionEvent) => {
      if (!e.persisted) return;
      // the page had left, so whatever a tap started is over
      markSignInUnderWay(false);
      const record = peekReturnPlace();
      if (!record) return;
      if (record.cancelled) {
        if (window.location.pathname === '/') clearReturnPlace();
        return;
      }
      const place = placeOf(record);
      if (!place) {
        clearReturnPlace();
        setOutcome({ kind: 'cancelled', place: '/' });
        return;
      }
      rewriteCancelled(place);
      replaceLocation(place.path);
    };
    window.addEventListener('pageshow', onShow);
    return () => window.removeEventListener('pageshow', onShow);
  }, []);

  useEffect(() => {
    if (!auth.ready) return;
    const here = window.location.pathname + window.location.search;
    if (window.location.pathname !== '/') {
      if (!auth.signInError) return;
      const record = peekReturnPlace();
      if (record) rewriteCancelled(record);
      setOutcome({ kind: auth.signInError, place: here });
      return;
    }
    // where an outcome on Home stands: Home's own address may carry a mark (`?ib=x`); a return's code is about to go from it
    const home = auth.freshSignIn ? '/' : here;
    if (auth.authenticated || auth.walletFailed) {
      const place = placeOf(takeReturnPlace());
      if (!place) return;
      if (auth.authenticated) {
        // «Feed {name}» tapped before the sign-in: the pet's screen runs it once it is back
        queueAction(place.action === 'feed' || place.action === 'skill' ? place.action : undefined);
        if (place.text) (place.action === 'skill' ? holdReturnSkill : holdReturnText)(place.path, place.text);
      }
      navigate(place.path);
    } else if (auth.refusal) {
      const place = placeOf(takeReturnPlace());
      // the closed sheet of a refusal at the ceiling is drawn by `SignInLayer`; «mau» has its line under the action
      if (auth.refusal.reason === 'mau') setOutcome({ kind: 'mau', place: place?.path ?? home, until: auth.refusal.until });
      if (place) navigate(place.path);
    } else if (auth.signInError || (!auth.freshSignIn && !auth.unreachable && !signInUnderWay())) {
      const record = peekReturnPlace();
      const kind = auth.signInError === 'failed' ? 'failed' : 'cancelled';
      if (record?.cancelled) {
        clearReturnPlace();
        return;
      }
      const place = placeOf(record);
      if (!place) {
        // a sign-in begun on Home has no place: its outcome stands on Home
        if (record) clearReturnPlace();
        if (record || auth.signInError) setOutcome({ kind, place: home });
        return;
      }
      rewriteCancelled(place);
      setOutcome({ kind, place: place.path });
      navigate(place.path);
    }
  }, [auth.ready, auth.authenticated, auth.walletFailed, auth.refusal, auth.signInError, auth.freshSignIn, auth.unreachable]);
  return null;
}
