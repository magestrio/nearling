import { useSyncExternalStore } from 'react';
import type { FeedSource, Fullness } from '../seams/worker-types';

// Feed sheet is one surface for the whole app (`Feed sheet screen`): «Feed {name}» on the Pet screen opens it, «Feed your {my_pet}»
// on a friend's page will (`add-pet-work`), and it opens by itself after the sign-in a tap on «Feed {name}» began. What is open
// is the tab's memory (browser storage: none): a reload closes it. The Pet screen reads the request to draw the sheet, to put the
// page under it out of reach and to show its opener as expanded, and listens to `onFed` for what the sheet learns.

export interface FeedRequest {
  /** the pet that is fed */
  tokenId: string;
  /** the pet's own name, for «Feed {name}» on the page it stands on */
  name: string;
  /** what the sheet calls the pet: «Pixel», or «your Pixel» on a friend's page (`Own pet feeding flow` › «открыл кормление») */
  label: string;
  /** the sheet's pet is not the page's: the own pet over a friend's page. Its fullness stands in the sheet's head on the desktop too */
  elsewhere: boolean;
}

/** What the sheet and the tab's flight tell the page. `fullness`: each answer of the open sheet, so the plate and the sheet's head
 *  show one fullness on a page that does not poll (a guest's). `fed`: a meal or snack was confirmed, whether the sheet is open or
 *  not (`Feeding transaction data` › «outcome with the sheet closed»): the page reads the pet once and shows the fullness or the
 *  wake, with no message. */
export type FedEvent = { kind: 'fullness'; tokenId: string; fullness: Fullness } | { kind: 'fed'; tokenId: string; source: FeedSource };

let current: FeedRequest | null = null;
const watchers = new Set<() => void>();
const listeners = new Set<(event: FedEvent) => void>();

function publish(next: FeedRequest | null): void {
  current = next;
  for (const w of watchers) w();
}

export function openFeed(request: FeedRequest): void {
  publish(request);
}

export function closeFeed(): void {
  if (current !== null) publish(null);
}

function useStore<T>(watch: Set<() => void>, read: () => T, server: T): T {
  return useSyncExternalStore(
    (onChange) => {
      watch.add(onChange);
      return () => watch.delete(onChange);
    },
    read,
    () => server,
  );
}

/** Whether the sheet is open right now, for an effect that decides in the same commit as the one that opened it. */
export function feedOpenNow(): boolean {
  return current !== null;
}

/** The request the sheet is open for, or null. */
export function useFeedRequest(): FeedRequest | null {
  return useStore(watchers, () => current, null);
}

export function announceFed(event: FedEvent): void {
  for (const listener of Array.from(listeners)) listener(event);
}

/** The Pet screen listens while it is open. Returns the way to stop. */
export function onFed(listener: (event: FedEvent) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Add NEAR sheet on its own: opened from another surface's «Add NEAR» (the Gift sheet, `add-gift`), which gets `onBack` when the
// player goes back. Feed sheet's own «Add NEAR» is a step inside Feed sheet and does not pass through here.
export interface AddNearRequest {
  from: 'feed' | 'gift';
  /** «Back» and the arrival of NEAR: the sheet it was opened from comes again */
  onBack: () => void;
}

let addNear: AddNearRequest | null = null;
const addNearWatchers = new Set<() => void>();

export function openAddNear(request: AddNearRequest): void {
  addNear = request;
  for (const w of addNearWatchers) w();
}

export function closeAddNear(): void {
  if (addNear === null) return;
  addNear = null;
  for (const w of addNearWatchers) w();
}

export function useAddNearRequest(): AddNearRequest | null {
  return useStore(addNearWatchers, () => addNear, null);
}

// The Toast of a copy («Link copied — send it to a friend.», «Address copied.»): it runs out on its own time, also after the
// sheet that made it was closed (`Feed link sharing flow`), so it is not the sheet's.
let toast: string | null = null;
const toastWatchers = new Set<() => void>();

export function showFeedToast(text: string | null): void {
  toast = text;
  for (const w of toastWatchers) w();
}

export function useFeedToast(): string | null {
  return useStore(toastWatchers, () => toast, null);
}
