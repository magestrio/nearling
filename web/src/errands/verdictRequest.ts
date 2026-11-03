import { useSyncExternalStore } from 'react';

// Verdict card is one surface over the owner's Pet screen (`Verdict card screen`): «Share card» under an «Is it true?» report asks
// for it, and the sheet that draws it reads the request. What is open is the tab's memory (browser storage: none): a reload
// closes it.
export interface VerdictRequest {
  /** the report's line: the card is of this report */
  lineId: string;
  claim: string;
  verdict: 'True' | 'False' | 'Unclear';
  /** how many sources the report cites: «{n} sources · {date}» */
  sources: number;
}

let current: VerdictRequest | null = null;
const watchers = new Set<() => void>();

function publish(next: VerdictRequest | null): void {
  current = next;
  for (const w of watchers) w();
}

export function openVerdict(request: VerdictRequest): void {
  publish(request);
}

export function closeVerdict(): void {
  if (current !== null) publish(null);
}

/** Whether the card is open right now. */
export function verdictOpenNow(): boolean {
  return current !== null;
}

/** The request the card is open for, or null. */
export function useVerdictRequest(): VerdictRequest | null {
  return useSyncExternalStore(
    (onChange) => {
      watchers.add(onChange);
      return () => watchers.delete(onChange);
    },
    () => current,
    () => null,
  );
}
