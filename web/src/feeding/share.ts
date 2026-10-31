import { track } from '../track';

// «Ask friends to feed {name}» (`Feed link sharing flow`, `Feed link share data`): the system share menu where the browser has one,
// else the link with its text on the clipboard, else the player copies it by hand. Only the link and the text leave the browser
// — no account of the sharer, no tab id, no mark of an in-app browser; the server hears of it as the event `feed_link_shared` alone.

/** The invitation's text: the pet's own name, never «your {my_pet}» — the friend who reads it is not its owner. */
export const inviteText = (name: string): string => `${name} could use a snack! Feed ${name} here:`;

/** `/pet/<token_id>?via=feed`: the token_id is public already. */
export const feedLink = (tokenId: string): string => new URL(`/pet/${tokenId}?via=feed`, window.location.origin).toString();

export type ShareOutcome =
  /** the system menu took it */
  | 'shared'
  /** the player closed the menu: nothing changes */
  | 'cancelled'
  /** no menu; the link with its text is on the clipboard: «Link copied — send it to a friend.» */
  | 'copied'
  /** no menu and the copy failed: «Copy this link and send it to a friend:» with the text and the link to select */
  | 'manual';

/** What the player sees and copies by hand: the text and the link in one line. */
export const whole = (tokenId: string, name: string): string => `${inviteText(name)} ${feedLink(tokenId)}`;

export async function shareFeedLink(tokenId: string, name: string): Promise<ShareOutcome> {
  track('feed_link_shared');
  if (typeof navigator.share === 'function') {
    try {
      await navigator.share({ text: inviteText(name), url: feedLink(tokenId) });
      return 'shared';
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return 'cancelled';
      // any other refusal falls to the copy
    }
  }
  try {
    await navigator.clipboard.writeText(whole(tokenId, name));
    return 'copied';
  } catch {
    return 'manual';
  }
}
