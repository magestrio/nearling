import { useSyncExternalStore } from 'react';

// add-pet › Pet motion rule: the viewer's «Pause motion» / «Play motion» choice is the browser's, not the account's.
// localStorage['nearling.motion'] is 'paused' | 'playing'; with no record the system's prefers-reduced-motion decides
// (stands with 'reduce'); site data erased → no record → moves again. Another tab's change arrives as the `storage`
// event, a change in this tab through `subscribe`. Every storage access is guarded: a browser that blocks it still
// toggles for the life of the tab.
export const MOTION_KEY = 'nearling.motion';
export type MotionChoice = 'paused' | 'playing';

let memory: MotionChoice | null = null;
const listeners = new Set<() => void>();

function readStored(): MotionChoice | null {
  try {
    const v = localStorage.getItem(MOTION_KEY);
    return v === 'paused' || v === 'playing' ? v : null;
  } catch {
    return memory;
  }
}

function systemReduced(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** True when the pet stands: the viewer's record, else the system's request for less motion. */
export function isMotionPaused(): boolean {
  const stored = readStored();
  return stored ? stored === 'paused' : systemReduced();
}

/** The viewer's tap: remember it for this browser and tell the tabs and screens. */
export function setMotionPaused(paused: boolean): void {
  const choice: MotionChoice = paused ? 'paused' : 'playing';
  memory = choice;
  try {
    localStorage.setItem(MOTION_KEY, choice);
  } catch {
    // storage blocked: the choice lives in this tab only
  }
  listeners.forEach((l) => l());
}

export function subscribeMotion(onChange: () => void): () => void {
  listeners.add(onChange);
  const onStorage = (e: StorageEvent) => {
    // a null key is `localStorage.clear()` from another tab
    if (e.key === null || e.key === MOTION_KEY) onChange();
  };
  window.addEventListener('storage', onStorage);
  const query = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  query?.addEventListener('change', onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener('storage', onStorage);
    query?.removeEventListener('change', onChange);
  };
}

/** Whether the pet stands, on every screen with a 3D pet; re-renders when the choice or the system's request changes. */
export function useMotionPaused(): [paused: boolean, toggle: () => void] {
  const paused = useSyncExternalStore(subscribeMotion, isMotionPaused, () => false);
  return [paused, () => setMotionPaused(!paused)];
}

/** Test seam: forget the tab's in-memory choice (a new page load). */
export function resetMotionMemory(): void {
  memory = null;
}
