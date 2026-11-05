// How the last sign-in ended, for the line under the action that started it (design.md › Решения › Place and outcome lines):
// `failed` — Google or the provider returned an error, `cancelled` — the player closed Google's window or came back by Back,
// `mau` — the server refused a new player after Google. It is a value of the tab's memory, tied to the place the tab was led
// back to, so it shows on that screen only; a new tap on a sign-in clears it.
import { useSyncExternalStore } from 'react';
import { useLocation } from '../route';

export type OutcomeKind = 'failed' | 'cancelled' | 'mau' | 'judge_failed' | 'judge_full';

export interface Outcome {
  kind: OutcomeKind;
  /** the place the tab was led back to: path with query */
  place: string;
  /** `mau` only: 00:00 UTC of the 1st, ISO, for `{month}` */
  until?: string;
}

let current: Outcome | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function setOutcome(outcome: Outcome): void {
  current = outcome;
  emit();
}

export function clearOutcome(): void {
  if (current === null) return;
  current = null;
  emit();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

/** The outcome that belongs to the screen the tab is on now, or null. */
export function useOutcome(): Outcome | null {
  const here = useLocation();
  const outcome = useSyncExternalStore(subscribe, () => current);
  return outcome && outcome.place === here ? outcome : null;
}
