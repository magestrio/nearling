import { useEffect, useRef, useState } from 'react';
import { petHeld } from '../../pet/PetFigure';
import { BOOT_MS } from '../../pet/proto/motion.js';

/** The boot of a pet that woke on this page: true for `BOOT_MS` after `asleep` turns false, on pause and under reduced motion too,
 *  as cuts: the log's three rows, then the next state (DS › Pet › Waking). A page opened asleep, or awake, boots nothing. The owner's
 *  page and a guest's use it alike: a friend's meal wakes the pet on a guest's screen too (`Feed by link flow` › «друг покормил»).
 *  `onWoke` runs at the moment of the wake, before the boot. */
export function useWaking(asleep: boolean, onWoke?: () => void): boolean {
  const [waking, setWaking] = useState(false);
  const was = useRef(asleep);
  const woke = useRef(onWoke);
  woke.current = onWoke;
  useEffect(() => {
    const before = was.current;
    was.current = asleep;
    if (asleep || !before) return undefined;
    woke.current?.();
    if (petHeld()) return undefined;
    setWaking(true);
    const timer = setTimeout(() => setWaking(false), BOOT_MS);
    return () => clearTimeout(timer);
  }, [asleep]);
  return waking;
}
