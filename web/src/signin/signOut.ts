// «Sign out» (`Sign-out flow` › «вышел», `Sign-out data`): the browser's session ends at Privy and at the server (ADR-022), the
// tab keeps nothing of the player, and the player is on Home with a line. The sign-out has no failure: whether either call
// gets an answer, the player sees «вышел» (`Sign-out data` › `server not reached`; Privy clears its tokens in the browser
// even when its own request fails).
import { clearNewborn } from '../pet/newborn';
import { navigate } from '../route';
import { takePendingAction } from '../screens/pet/parts';
import type { AuthApi } from '../seams/auth-context';
import { END_SESSION_TIMEOUT_MS, workerApi } from '../seams/worker';
import { clearOutcome } from './outcome';
import { clearReturnPlace } from './returnPlace';

/** The words of the Toast and of Home's Live after a sign-out. */
export const SIGNED_OUT_LINE = "You're signed out. See you soon!";

// The line waits for Home as a value of the tab's memory: a reload does not show it again (`Sign-out flow` › «вышел»).
let pending = false;

/** The line Home shows, left where it is: Home asks again on a second render. */
export function peekSignedOutLine(): boolean {
  return pending;
}

/** Home has shown it (or the player went on): it is not shown again. */
export function consumeSignedOutLine(): void {
  pending = false;
}

/** What outlives the screens that held it: the action tapped before a sign-in, the pet this tab hatched, the return record with
 *  any typed text in it, the last sign-in outcome. The token the app kept is forgotten by the provider's `logout`. */
function clearTab(): void {
  takePendingAction();
  clearNewborn();
  clearReturnPlace();
  clearOutcome();
}

/** The token, within the limit of the server call: the menu is closed by now, so a token that doesn't come would leave the
 *  player with nothing happening. No token in time, or none at all: there is nothing to tell the server, and the sign-out goes
 *  on in the browser. */
function tokenInTime(auth: Pick<AuthApi, 'getIdentityToken'>): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout>;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), END_SESSION_TIMEOUT_MS);
  });
  return Promise.race([auth.getIdentityToken(), late])
    .catch(() => null)
    .finally(() => clearTimeout(timer));
}

export async function signOut(auth: Pick<AuthApi, 'getIdentityToken' | 'logout'>): Promise<void> {
  const token = await tokenInTime(auth);
  const recorded = token === null ? Promise.resolve() : workerApi.endSession(token);
  // the synchronous part of `logout` signs the page out, so no screen flashes the player's pet as a visitor's
  const ended = auth.logout();
  clearTab();
  pending = true;
  navigate('/');
  await Promise.allSettled([recorded, ended]);
}
