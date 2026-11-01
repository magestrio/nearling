import { useEffect, useRef, useState } from 'react';
import { useClearRequest } from '../account/clearMemory';
import { feedOpenNow, useFeedRequest } from '../feeding/feedRequest';
import { diaryPath, go } from '../route';
import type { OutfitSlug } from '../seams/worker-types';
import { useSignIn } from '../signin/signIn';
import { nextOnOpen } from './order';
import { utcDayNow } from './useDiary';

// What opens by itself on the Pet screen of an awake owner's pet.
// The Diary (`Daily ritual flow` › «встречает дневником», «сначала действие»): with today's entry unread it goes to the Diary when nothing
// else is open, once for a UTC day in this tab. It waits for an empty field too, so it never takes the focus from a player who is typing
// (a11y.md › 2.4.3). The wait rests on `diaryUnread`, which the poll keeps current: an entry erased behind a dialog, or read in another tab,
// turns it false and nothing opens. The hook lives under the Pet screen's `key={tokenId}`, so leaving for another pet ends the wait.
// The New outfit notice (`New outfit notice screen`): it opens over whatever stands — Feed sheet, Gift sheet, a menu, the Diary — after
// everything that is due, on the Pet and Diary screens and not on the Wardrobe, awake or asleep. It waits for an empty field (the Pet
// screen's, and the Diary's riddle and answer fields), for Clear memory dialog and for a sign-in sheet to close.
const SURFACE = '[role="dialog"], [role="alertdialog"], [role="menu"]';

/** A dialog, a sheet or a menu is on the page: the Account menu, My pets, a sheet opened by hand. */
function useSurfaceOpen(): boolean {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const look = () => setOpen(document.querySelector(SURFACE) !== null);
    look();
    const watch = new MutationObserver(look);
    watch.observe(document.body, { childList: true, subtree: true });
    return () => watch.disconnect();
  }, []);
  return open;
}

/** A field of the page holds a line, focused or not: the Pet screen's input, the Diary's riddle and answer fields. A dialog's own
 *  fields (Feed sheet's read-only link) are not the page's. */
export function fieldBusy(): boolean {
  return Array.from(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('textarea, input:not([type]), input[type="text"]')).some(
    (field) => field.value !== '' && field.closest('[role="dialog"], [role="alertdialog"]') === null,
  );
}

export function useSelfOpen({
  tokenId,
  diaryUnread,
  diary,
  wardrobe,
  asleep,
  typing,
  notice,
  onNotice,
}: {
  tokenId: string;
  diaryUnread: boolean;
  /** the Diary stands */
  diary: boolean;
  /** the Wardrobe stands: it opens neither the Diary nor the notice */
  wardrobe: boolean;
  /** the owner's pet is seen asleep: its entry turns unread at the wake, and the Diary does not open on waking (PRODUCT.md › User
   *  Decisions, 2026-10-28): after a meal it opens by «Today» or at the next opening of the Pet screen */
  asleep: boolean;
  /** the Pet screen's field holds a line */
  typing: boolean;
  /** the earned item whose notice is due, or null: none, or one stands, or the page is not the owner's */
  notice: OutfitSlug | null;
  /** the notice opens */
  onNotice: (slug: OutfitSlug) => void;
}): void {
  // the UTC day that opens no Diary by itself in this tab: one was opened (by itself, «Today» or the address), and back from it does
  // not open it again; or the pet was seen asleep that day
  const latch = useRef<number | null>(null);
  const feed = useFeedRequest();
  const clear = useClearRequest();
  const { sheet: signIn } = useSignIn();
  const surface = useSurfaceOpen();
  // Runs after every render, the polls' included: a new UTC day with the entry still unread opens it again, with nothing else
  // changed (`Daily ritual flow` › «встречает дневником»).
  useEffect(() => {
    const day = utcDayNow();
    if (diary || asleep) latch.current = day;
    const next = nextOnOpen(
      {
        feed: false,
        gift: false,
        diary: !diary && !wardrobe && !asleep && diaryUnread && latch.current !== day,
        notice: notice !== null && !wardrobe && clear === null && signIn === null && !fieldBusy(),
      },
      // the Feed sheet that a tap of the same open began is open by now: its store, not this render, says so
      { feed: feedOpenNow() || feed !== null, gift: false, other: surface || clear !== null || typing, diary },
    );
    if (next === 'diary') {
      latch.current = day;
      go(diaryPath(tokenId));
    } else if (next === 'notice' && notice !== null) onNotice(notice);
  });
}
