// The pet's states (P3). Each one sets what the screen shows (face.js), how
// the body holds itself (assemble.js) and how bright the core light is, as a
// share of the full light (materials.js scales it per hue). The meaning is
// carried by the screen and the posture; the light only follows them.
//
// light: share of the full glow strength (the bloom follows it: a dim state
//   falls under the bloom threshold)
// pool:  share of the full ground pool
// glowRadius: share of the full glow radius. A smaller radius gives a smaller
//   spot, which needs a little more strength to show
// The asleep ember is a small spot, not the full glow turned down: about
// hungry's strength, drawn in to 0.6 of the radius. It peaks on the surface
// nearest the core, which is the belly just under it (0.29 to 0.39 away on
// seeds 9, 2, 0, 1, 5), not the front at CORE_DEPTH (assemble.js): 0.6 of the
// radius keeps 0.34 to 0.74 of the same strength's peak there, so 1.8 of
// strength peaked at 0.71 to 0.92 of full and over hungry on every hue. The
// ember's strength is the one number the ladder hangs on: read it off
// scripts/measure-light.mjs --states full,hungry,asleep (peak, spot L). What
// is left of the spread between pets follows the body, not the hue (seed 5, a
// half-dome in a ring, shows the least of its spot: aqua peaks 0.11 there,
// 0.21 on seed 0), so a table by hue would not even it out. The spill gives
// off about 0.03 of full's light (animator.js › lightOf).
// coreBelowFace: the spot's centre sits below the screen's rim (assemble.js).
//   A small spot needs it: on a half-dome the core is level with the rim's
//   lower edge, and the screen hid all of the ember but a fringe
// posture: null = upright as in P2; otherwise
//   squash   the body's height (its width grows to keep the volume)
//   pitch    the body leans forward, radians (the face tips down)
//   topPitch the top pieces nod further forward about the body's middle
//   topDrop  and sink this far into the body (body units)
export const STATES = {
  full: { face: 'happy', light: 1, pool: 1, glowRadius: 1, posture: null },
  hungry: {
    face: 'drowsy',
    light: 0.25,
    pool: 0.25,
    glowRadius: 1,
    posture: { squash: 0.93, pitch: 0.1, topPitch: 0.12, topDrop: 0.04 },
  },
  asleep: {
    face: 'asleep',
    light: 0.3,
    pool: 0.03,
    glowRadius: 0.6,
    coreBelowFace: true,
    posture: { squash: 0.96, pitch: 0, topPitch: 0, topDrop: 0.02 },
  },
  thinking: { face: 'thinking', light: 1, pool: 1, glowRadius: 1, posture: null },
  waking: { face: 'boot', light: 0.45, pool: 0.45, glowRadius: 1, posture: null },
};

export const STATE_NAMES = Object.keys(STATES);

export function stateOf(name) {
  const s = STATES[name];
  if (!s) throw new Error(`unknown state "${name}" (one of ${STATE_NAMES.join(', ')})`);
  return s;
}
