import { useSyncExternalStore } from 'react';

// The Clear memory dialog is one surface for the whole app (`Clear memory dialog screen`): Account menu's «Clear {name}'s
// memory» opens it, and so does `add-gift`'s Gift sheet. It stands outside the page it covers, so a page that changes under
// it (the pet was given away meanwhile) does not take it along; the page learns the outcome by `onClearOutcome`.

export interface ClearRequest {
  tokenId: string;
  name: string;
  /** where the focus goes when the dialog closes without a clear: «Account», or the Gift sheet's «Clear memory» */
  returnFocusTo?: () => HTMLElement | null;
  /** called once memory is cleared, for a dialog opened from the Gift sheet (it returns there); with none, the owner's input
   *  takes the focus */
  onDone?: () => void;
  /** A shared link with reserved food needs the owner's signed close approval before erasure. */
  unsettledSharedJob?: boolean;
}

/** What the dialog learned from the server, for the Pet screen of that pet. */
export interface ClearOutcome {
  tokenId: string;
  /** `cleared`: «стёр»; `not_owner`: «уже не владелец» */
  result: 'cleared' | 'cleared_retry' | 'not_owner';
}

let current: ClearRequest | null = null;
const watchers = new Set<() => void>();
const outcomeListeners = new Set<(o: ClearOutcome) => void>();

function publish(next: ClearRequest | null): void {
  current = next;
  for (const w of watchers) w();
}

export function openClearMemory(request: ClearRequest): void {
  publish(request);
}

export function closeClearMemory(): void {
  publish(null);
}

/** The request the dialog is open for, or null. */
export function useClearRequest(): ClearRequest | null {
  return useSyncExternalStore(
    (onChange) => {
      watchers.add(onChange);
      return () => watchers.delete(onChange);
    },
    () => current,
    () => null,
  );
}

export function announceClear(outcome: ClearOutcome): void {
  for (const listener of Array.from(outcomeListeners)) listener(outcome);
}

/** The Pet screen listens while it is open. Returns the way to stop. */
export function onClearOutcome(listener: (o: ClearOutcome) => void): () => void {
  outcomeListeners.add(listener);
  return () => outcomeListeners.delete(listener);
}
