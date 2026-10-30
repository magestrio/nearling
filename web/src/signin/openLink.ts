// The link from Open in browser sheet to the same place in a real browser (`Sign-in data` › «ссылка в настоящий браузер»).
// It carries the place, the mark of the in-app browser (`ib=`, read by `add-analytics` for `from_in_app`) and the invitation's
// label (`c=`) — nothing else. No tapped action, no account, no session, no tab id, and no text a player typed: `linkFor` has
// no parameter that could carry it.
import type { InApp } from './inApp';

/** `place` is the path with its query (`/pet/2`, `/hatch?from=2`); `inApp` the in-app browser the player is in, if any;
 *  `invite` the label of the invitation link the tab came by. */
export function linkFor(place: string, inApp: InApp | null, invite: string | null): string {
  const url = new URL(place, window.location.origin);
  // the marks are this function's to set, whatever the place's own query says
  url.searchParams.delete('ib');
  url.searchParams.delete('c');
  if (inApp) url.searchParams.set('ib', inApp);
  if (invite) url.searchParams.set('c', invite);
  return url.toString();
}

/** Android: an `intent://` link asks the system to open the address in the default browser. */
export function androidIntentFor(link: string): string {
  const url = new URL(link);
  return `intent://${url.host}${url.pathname}${url.search}#Intent;scheme=${url.protocol.replace(':', '')};end`;
}

/** iPhone: the link goes to the clipboard, and the player pastes it into Safari. Resolves false when the copy failed (the
 *  sheet then shows the link in a read-only field). */
export async function copyLink(link: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(link);
    return true;
  } catch {
    return false;
  }
}

/** Hands an address to the system (Android's `intent://`). A page that stays on screen after it is how the sheet learns the
 *  external browser did not open. In the e2e mode the call is only recorded: a test can't follow an `intent://` link. */
export const openExternally: (url: string) => void =
  import.meta.env.VITE_FAKES === 'true'
    ? (await import('./openLink.fake')).fakeOpenExternally
    : (url) => {
        window.location.assign(url);
      };
