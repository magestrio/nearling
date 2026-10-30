// The screen's side of the pet's motion: the viewer's «Pause motion» choice
// and a handle that carries the pointer and the screen's events to the pet.
// (`add-pet` › Pet motion rule: the choice lives in the browser, not the
// account; with prefers-reduced-motion the pet stands still from the first
// show until the viewer taps «Play motion», and that tap is remembered.)
import { useCallback, useEffect, useMemo, useState } from 'react';

const KEY = 'pet-motion'; // 'paused' | 'playing'; none: the system decides
const REDUCED = '(prefers-reduced-motion: reduce)';

// { paused, toggle, reduced, saved, forget }. `simulateReduced` stands in for
// the system setting (the motion page's check of the reduced behaviour).
export function useMotionPaused(simulateReduced = false) {
  const [saved, setSaved] = useState(() => localStorage.getItem(KEY));
  const [systemReduced, setSystemReduced] = useState(() => matchMedia(REDUCED).matches);
  useEffect(() => {
    const query = matchMedia(REDUCED);
    const onChange = () => setSystemReduced(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  // Another tab's tap (a null key: another tab cleared the site's data).
  useEffect(() => {
    const onStorage = (e) => {
      if (e.key === null || e.key === KEY) setSaved(localStorage.getItem(KEY));
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);
  const reduced = simulateReduced || systemReduced;
  const paused = saved ? saved === 'paused' : reduced;
  const toggle = useCallback(() => {
    const next = paused ? 'playing' : 'paused';
    localStorage.setItem(KEY, next);
    setSaved(next);
  }, [paused]);
  const forget = useCallback(() => {
    localStorage.removeItem(KEY);
    setSaved(null);
  }, []);
  return { paused, toggle, reduced, saved, forget };
}

// The handle a screen gives its pet (PetCanvas `motion`): `fire('talk',
// { ms })` when a reply lands, `fire('birth')` on a newborn's first show,
// `fire('hop')`; and the pointer the eyes follow — the cursor anywhere in
// the window, or a finger while it is down — let go when the cursor leaves
// the window or the finger lifts.
export function usePetMotion() {
  const motion = useMemo(() => {
    const listeners = new Set();
    return {
      pointer: { x: 0, y: 0, active: false },
      fire: (name, opts) => listeners.forEach((listen) => listen(name, opts)),
      listen: (fn) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
    };
  }, []);
  useEffect(() => {
    const p = motion.pointer;
    const follow = (e) => {
      if (e.pointerType !== 'mouse' && !e.buttons && e.type !== 'pointerdown') return; // a finger only while it is down
      p.x = e.clientX;
      p.y = e.clientY;
      p.active = true;
    };
    const lift = (e) => {
      if (e.pointerType !== 'mouse') p.active = false;
    };
    const leave = (e) => {
      if (!e.relatedTarget) p.active = false; // out of the window
    };
    const away = () => (p.active = false);
    window.addEventListener('pointermove', follow, { passive: true });
    window.addEventListener('pointerdown', follow, { passive: true });
    window.addEventListener('pointerup', lift);
    window.addEventListener('pointercancel', lift);
    document.addEventListener('pointerout', leave);
    window.addEventListener('blur', away);
    return () => {
      window.removeEventListener('pointermove', follow);
      window.removeEventListener('pointerdown', follow);
      window.removeEventListener('pointerup', lift);
      window.removeEventListener('pointercancel', lift);
      document.removeEventListener('pointerout', leave);
      window.removeEventListener('blur', away);
    };
  }, [motion]);
  return motion;
}
