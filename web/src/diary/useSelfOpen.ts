import { useEffect, useRef, useState } from 'react';
import { useClearRequest } from '../account/clearMemory';
import { feedOpenNow, useFeedRequest } from '../feeding/feedRequest';
import { diaryPath, go } from '../route';
import { nextOnOpen } from './order';
import { utcDayNow } from './useDiary';

// The Diary opens by itself (`Daily ritual flow` › «встречает дневником», «сначала действие»): the Pet screen of an awake owner's
// pet with today's entry unread goes to the Diary when nothing else is open, once for a UTC day in this tab. It waits for an empty
// field too, so it never takes the focus from a player who is typing (a11y.md › 2.4.3). The wait rests on `diaryUnread`, which the
// poll keeps current: an entry erased behind a dialog, or read in another tab, turns it false and nothing opens. The hook lives
// under the Pet screen's `key={tokenId}`, so leaving for another pet ends the wait.
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

export function useSelfOpen({
  tokenId,
  diaryUnread,
  standing,
  asleep,
  typing,
}: {
  tokenId: string;
  diaryUnread: boolean;
  standing: boolean;
  /** the owner's pet is seen asleep: its entry turns unread at the wake, and the Diary does not open on waking (PRODUCT.md › User
   *  Decisions, 2026-10-28): after a meal it opens by «Today» or at the next opening of the Pet screen */
  asleep: boolean;
  /** the Pet screen's field holds a line */
  typing: boolean;
}): void {
  // the UTC day that opens no Diary by itself in this tab: one was opened (by itself, «Today» or the address), and back from it does
  // not open it again; or the pet was seen asleep that day
  const latch = useRef<number | null>(null);
  const feed = useFeedRequest();
  const clear = useClearRequest();
  const surface = useSurfaceOpen();
  // Runs after every render, the polls' included: a new UTC day with the entry still unread opens it again, with nothing else
  // changed (`Daily ritual flow` › «встречает дневником»).
  useEffect(() => {
    if (standing || asleep) {
      latch.current = utcDayNow();
      return;
    }
    const day = utcDayNow();
    const next = nextOnOpen(
      { feed: false, gift: false, diary: diaryUnread && latch.current !== day, notice: false },
      // the Feed sheet that a tap of the same open began is open by now: its store, not this render, says so
      { feed: feedOpenNow() || feed !== null, gift: false, other: surface || clear !== null || typing, diary: false },
    );
    if (next !== 'diary') return;
    latch.current = day;
    go(diaryPath(tokenId));
  });
}
