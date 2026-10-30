// The state of the sign-in, read before Google (`Sign-in data` › «вход закрыт», «потолок»): the browser never spends a place
// at Privy on a sign-in the server will refuse. It is read at the tap, and at load on Home only (design.md › Решения).
import { workerApi, type SignInGate } from '../seams/worker';

export type { SignInGate };

/** The gate as the server says it now. Rejects when it can't be read: a tap then shows `Connection rule` and never walks to
 *  Google on an unknown state. Sent with no token: a stale one would answer `401`. */
export function readGate(): Promise<SignInGate> {
  return workerApi.signInState();
}

/** What a tap does about the gate. `closed_new` lets a returning player through («Played here before? Sign in»): the server
 *  decides after Google (`Sign-in flow` › «вернувшийся входит»). `closed_all` lets nobody through. */
export function gateBlocks(gate: SignInGate, returning: boolean): 'closed_new' | 'closed_all' | null {
  if (gate.state === 'closed_all') return 'closed_all';
  if (gate.state === 'closed_new' && !returning) return 'closed_new';
  return null;
}

const MONTH = new Intl.DateTimeFormat('en', { month: 'long', timeZone: 'UTC' });

/** `{month}` of «…until {month} 1»: the month of `until`, which is 00:00 UTC of the 1st — «December». */
export function monthOf(until: string): string {
  return MONTH.format(new Date(until));
}
