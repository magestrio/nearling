import type { ActionMenuItem } from '../../ds/ActionMenu';
import type { HotbarItem } from '../../ds/Hotbar';

/** The visible Stage entries are derived from the current read, never kept after ownership changes. */
export function ownerStageActions({ tokenId, name, asleep, away, feedOpen, errandOpen, watch, watchOpen = false, giftOpen = false, onFeed, onErrand, onWatch, onGift }: {
  tokenId: string; name: string; asleep: boolean; away: boolean; feedOpen: boolean; errandOpen: boolean; watch: boolean;
  /** the Watch / Gift sheet opened from its menu item (a Gift sheet that opened by itself is not) */
  watchOpen?: boolean; giftOpen?: boolean;
  onFeed: () => void; onErrand: () => void; onWatch: () => void; onGift: () => void;
}): { items: HotbarItem[]; menu: ActionMenuItem[] } {
  const feed: HotbarItem = { icon: 'feed', label: `Feed ${name}`, primary: true, role: 'food', onClick: onFeed, haspopup: 'dialog', expanded: feedOpen };
  return {
    items: asleep ? [feed, { icon: 'more', label: 'More', more: true }] : [
      feed,
      { icon: 'today', label: 'Today', role: 'food', href: `/pet/${tokenId}/diary` },
      { icon: 'hanger', label: 'Wardrobe', href: `/pet/${tokenId}/wardrobe` },
      { icon: 'pack', label: `Send ${name} on an errand`, lines: [`Send ${name}`, 'on an errand'], role: 'mind', off: away, onClick: onErrand, haspopup: 'dialog', expanded: errandOpen },
      { icon: 'more', label: 'More', more: true },
    ],
    menu: [
      { icon: 'watch', label: watch ? 'Edit watch' : 'Watch something', onClick: onWatch, haspopup: 'dialog', expanded: watchOpen },
      { icon: 'share', label: `Share ${name}` },
      ...asleep ? [] : [{ icon: 'gift' as const, label: `Give ${name} away`, onClick: onGift, haspopup: 'dialog' as const, expanded: giftOpen }],
    ],
  };
}

export function guestStageActions(name: string, feedOpen: boolean, onFeed: () => void): HotbarItem[] {
  return [{ icon: 'feed', label: `Feed ${name}`, primary: true, role: 'food', haspopup: 'dialog', expanded: feedOpen, onClick: onFeed }];
}

export function ownerConversationDisabled(asleep: boolean, tired: boolean, paused: boolean, sessionLine: boolean): boolean {
  return asleep || tired || paused || sessionLine;
}

export function newestPetReply<T extends { who: string; question?: boolean }>(lines: T[]): T | undefined {
  return lines.filter((line) => line.who === 'pet' && !line.question).at(-1);
}

/** The Bubble's words (DS 0.48 frames, `pet.js` › `lastReply`): the pet's newest line of the turn the player last opened — after the
 *  player's last line, the pet's own words only, its question to a worker included, an errand's report and a worker's line not.
 *  A turn that has no such line (a worker's advice kept in the chat, a report) leaves the Bubble empty. */
export function visiblePetReply<T extends { who: string; report?: unknown }>(lines: T[], state: {
  busy: boolean; failed: boolean; asleep: boolean; away: boolean;
}): T | undefined {
  if (state.busy || state.failed || state.asleep || state.away) return undefined;
  const opened = lines.map((line) => line.who).lastIndexOf('player');
  return lines.slice(opened + 1).filter((line) => line.who === 'pet' && !line.report).at(-1);
}
