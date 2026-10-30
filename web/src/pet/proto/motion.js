// The pet's motion (P6): its timings, curves and springs. Plain math, no DOM
// and no React, so it also runs in Node (scripts/check-motion.mjs).
// The durations and easings are the design system's (design/ds/tokens.json):
// 120 / 200 / 320 ms, never over 600 ms for one transition; a moment that
// strings several together stays under 5 s, and every one of them stops on
// «Pause motion» (WCAG 2.2.2).
import { assemblePet } from './assemble.js';
import { STAGES } from './generator.js';

export const MS = { micro: 120, short: 200, medium: 320, long: 600, dots: 1200 };

// A CSS cubic-bezier(x1, y1, x2, y2) as a function of progress 0–1, solved
// for x by Newton steps (bisection where the slope is flat).
function cubicBezier(x1, y1, x2, y2) {
  const at = (a, b, t) => 3 * a * t * (1 - t) ** 2 + 3 * b * t * t * (1 - t) + t ** 3;
  const slope = (a, b, t) => 3 * a * (1 - t) ** 2 + 6 * (b - a) * t * (1 - t) + 3 * (1 - b) * t * t;
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i++) {
      const d = slope(x1, x2, t);
      if (Math.abs(d) < 1e-6) break;
      t -= (at(x1, x2, t) - x) / d;
    }
    if (t < 0 || t > 1 || Math.abs(at(x1, x2, t) - x) > 1e-5) {
      let [lo, hi] = [0, 1];
      for (let i = 0; i < 30; i++) {
        t = (lo + hi) / 2;
        if (at(x1, x2, t) < x) lo = t;
        else hi = t;
      }
    }
    return at(y1, y2, t);
  };
}

export const EASE = {
  standard: cubicBezier(0.2, 0, 0, 1), // --easing-standard
  enter: cubicBezier(0, 0, 0.2, 1), // --easing-enter
  press: cubicBezier(0.34, 1.56, 0.64, 1), // --easing-press: the vinyl bounce, overshoots
  fall: (t) => t * t, // gravity: a dropped thing speeds up
};

// Progress 0–1 of a span [start, start + dur] at time `t`, eased.
export function span(t, start, dur, ease = EASE.standard) {
  return ease(Math.min(1, Math.max(0, (t - start) / dur)));
}

// One damped spring, per axis: { x, v } toward `target`. f: its own
// frequency (Hz), zeta: its damping ratio (1 = no overshoot). Substeps keep it
// stable on a slow frame.
export function springStep(s, target, f, zeta, dt) {
  const k = (2 * Math.PI * f) ** 2;
  const c = 2 * zeta * Math.sqrt(k);
  const n = Math.max(1, Math.ceil(dt / (1 / 240)));
  const h = dt / n;
  for (let i = 0; i < n; i++) {
    s.v += (k * (target - s.x) - c * s.v) * h;
    s.x += s.v * h;
  }
}

// The idle loop per state: the breath's period (s) and depth (a share of the
// body's height; its width the inverse, so the volume holds), and the weight
// shift's tilt (rad), on a slower loop of its own. Hungry breathes slower and
// its top nods deeper on each breath out (nod, rad); asleep breathes slowest
// and deepest, its ember brightening with each breath in (ember, a share).
export const BREATH = {
  full: { period: 3.6, depth: 0.014, sway: 0.008 },
  thinking: { period: 3.0, depth: 0.01, sway: 0.004 },
  waking: { period: 3.6, depth: 0.012, sway: 0.006 },
  hungry: { period: 5.4, depth: 0.01, sway: 0.006, nod: 0.022 },
  asleep: { period: 6.4, depth: 0.016, sway: 0.003, ember: 0.12 },
};
export const SWAY_PERIOD = 1.7; // the weight shift's loop, in breaths
// The top, the ring, the tail and a worn item follow the breath this late
// (s), and ride the body's moves on springs of their own.
export const FOLLOW = 0.28;
export const SPRINGS = {
  top: { f: 3.2, zeta: 0.32 },
  ring: { f: 2.6, zeta: 0.28 },
  tail: { f: 2.8, zeta: 0.3 },
  item: { f: 3.0, zeta: 0.38 },
};

// The eyes after the pointer: up to this many pixel columns and rows on the
// screen's grid, the body turning up to `yaw` / `pitch` (rad) with them, on a
// critically damped spring (Hz; slower when drowsy). `reach`: how far off the
// face (a share of the canvas's height) the pointer takes the eyes all the way.
export const GAZE = { cols: 2, rows: 1, yaw: 0.07, pitch: 0.035, f: 3.2, fDrowsy: 1.4, reach: 0.55 };

// A blink: [lid, ms] steps (lid 1 half shut, 2 shut), then open; every
// 2.2–5.5 s, sometimes twice.
export const BLINK = {
  steps: [[1, 50], [2, 70], [1, 50]],
  drowsy: [[1, 90], [2, 220], [1, 110]],
  every: [2.2, 5.5],
  twice: 0.15,
};

// Talking: the eyes hop a pixel row up and back, a syllable at a time, with a
// short pause between words; as long as the reply takes to read aloud, a
// little: `perChar` ms a character, within [min, max].
export const TALK = { up: [90, 150], down: [70, 120], word: [3, 6], gap: [160, 240], perChar: 45, min: 600, max: 4000 };
export const talkMs = (chars) => Math.min(TALK.max, Math.max(TALK.min, chars * TALK.perChar));

// The thinking dots: the lit dot steps every third of the DS's 1.2 s loop.
export const DOT_STEP = MS.dots / 3;

// Waking: the boot log is typed a pixel at a time after a dark instant, and
// held a moment once typed; the game moves on to the next state after BOOT_MS.
export const BOOT = { dark: 120, perPixel: 30 };
export const BOOT_MS = 1200;

// A hop (the pet never walks): a crouch, a leap of `height` (a share of the
// pet's own height) in a parabola, a landing squash that springs back.
export const HOP = { crouch: 80, air: MS.medium, land: MS.short, height: 0.07, squash: 0.06, stretch: 0.04, landSquash: 0.07 };
export const HOP_MS = HOP.crouch + HOP.air + HOP.land;

// Height and squash (a share off the height; below 0 a stretch) of a hop at
// `t` ms into it, into `out`.
export function hopAt(t, height, out) {
  out.y = 0;
  out.squash = 0;
  if (t < 0 || t >= HOP_MS) return out;
  if (t < HOP.crouch) {
    out.squash = HOP.squash * Math.sin((Math.PI / 2) * (t / HOP.crouch));
    return out;
  }
  const u = (t - HOP.crouch) / HOP.air;
  if (u < 1) {
    out.y = 4 * height * u * (1 - u);
    out.squash = -HOP.stretch * (1 - u);
    return out;
  }
  out.squash = HOP.landSquash * (1 - EASE.press((t - HOP.crouch - HOP.air) / HOP.land));
  return out;
}

// One camera for a pet through its stages, with a party hat (the tallest
// item) and room above for a hop: on the live page it grows, hops and wears
// things without the camera moving.
export function liveFrame(seed) {
  const pets = [...STAGES.map((stage) => assemblePet(seed, 'full', stage)), assemblePet(seed, 'full', 'adult', 'party-hat')];
  const top = Math.max(...pets.map((a) => a.bounds.top)) * (1 + HOP.height);
  const halfWidth = Math.max(...pets.map((a) => a.bounds.cylRadius));
  return { centerY: top / 2, radius: Math.hypot(halfWidth, top / 2) };
}
