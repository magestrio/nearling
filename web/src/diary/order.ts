// What opens by itself on the Pet screen, and in which order (`Daily ritual flow` › «сначала действие»): Feed sheet first, then
// Gift sheet, then Diary screen; the Diary opens only when nothing is open, and the New outfit notice comes last, over whatever
// stands. Pure: `useSelfOpen` feeds it what the screen knows.

/** What waits to open. `diary` is `diaryUnread` of the pet, read when the way clears. */
export interface Due {
  feed: boolean;
  gift: boolean;
  diary: boolean;
  notice: boolean;
}

/** What is open now: the two sheets, any other sheet, dialog or menu (a hand-opened one, Clear memory dialog, the Account menu,
 *  My pets), and the Diary itself. */
export interface Open {
  feed: boolean;
  gift: boolean;
  other: boolean;
  diary: boolean;
}

export type Next = 'feed' | 'gift' | 'diary' | 'notice' | null;

export function nextOnOpen(due: Due, open: Open): Next {
  const standing = open.feed || open.gift || open.other || open.diary;
  const first = due.feed ? 'feed' : due.gift ? 'gift' : due.diary ? 'diary' : null;
  // a thing that is due opens when nothing stands; the ones behind it wait for it
  if (first !== null) return standing ? null : first;
  // the notice opens over what stands, but after everything that is due
  return due.notice ? 'notice' : null;
}
