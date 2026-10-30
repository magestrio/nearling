// The pet as data, derived from its token_id alone: the same id always gives
// the same pet. This file only draws the seeded choices; assemble.js turns
// them into geometry and places the face, feet, ring, tops and core light.
// Units: a medium sphere body is about 2 wide; y = 0 is the ground.
// The state (states.js) never touches the draws: one pet in every state.
// Nor does the stage (grow, below): one individual from baby to grown-up.
import { stateOf } from './states.js';

export const HUES = {
  mint: '#00EC97',
  aqua: '#17D9D4',
  lavender: '#9797FF',
  coral: '#FF7966',
  yellow: '#FFE02A',
};
const HUE_KEYS = Object.keys(HUES);

export const OFF_WHITE = '#F2F1E9';

// The body carries the face, the feet and the core light.
const BODY_KINDS = ['sphere', 'capsule', 'lying-capsule', 'cone', 'half-dome'];
const BODY_LABEL = {
  sphere: 'sphere',
  capsule: 'capsule',
  'lying-capsule': 'lying capsule',
  cone: 'cone',
  'half-dome': 'half-dome',
};

// What can sit on top of each body. A cone's tip only takes a sphere; a lying
// capsule's long round back takes no cap.
const TOPS_FOR = {
  sphere: ['cone', 'sphere', 'cap', 'cap+sphere', 'nub', 'none'],
  capsule: ['cone', 'sphere', 'cap', 'cap+sphere', 'nub', 'none'],
  'lying-capsule': ['cone', 'sphere', 'nub', 'none'],
  cone: ['sphere', 'none'],
  'half-dome': ['cone', 'sphere', 'cap', 'cap+sphere', 'nub', 'none'],
};
const TOP_PRIMITIVES = { cone: 1, sphere: 1, cap: 1, 'cap+sphere': 2, nub: 1, none: 0 };
const TOP_LABEL = {
  cone: 'cone top',
  sphere: 'sphere top',
  cap: 'half-dome cap',
  'cap+sphere': 'half-dome cap + sphere',
  nub: 'capsule nub',
};
const RING_ALLOWED = { sphere: true, capsule: true, 'lying-capsule': false, cone: true, 'half-dome': true };

// FNV-1a: token ids are strings on NEAR, so hash the string form.
function hashString(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function makePet(tokenId, { stage = 'adult', state = 'full' } = {}) {
  if (!STAGES.includes(stage)) throw new Error(`unknown stage "${stage}" (one of ${STAGES.join(', ')})`);
  const rand = mulberry32(hashString(String(tokenId)));
  const range = (a, b) => a + (b - a) * rand();
  const pick = (list) => list[Math.floor(rand() * list.length)];

  // Every draw happens in a fixed order, used or not, so one choice never
  // shifts the others.
  const hue = pick(HUE_KEYS);
  const kind = pick(BODY_KINDS);
  const allDims = {
    sphere: { rx: 1, ry: range(0.86, 1.0) },
    capsule: { r: range(0.78, 0.9), length: range(0.5, 0.95) },
    'lying-capsule': { r: range(0.68, 0.8), length: range(0.8, 1.25) },
    cone: { r: range(1.0, 1.12), height: range(2.0, 2.35) },
    'half-dome': { r: range(1.15, 1.3), height: range(1.05, 1.2) },
  };

  const sizeRoll = rand();
  const scale = sizeRoll < 0.25 ? range(0.72, 0.8) : sizeRoll < 0.75 ? range(0.9, 1.0) : range(1.05, 1.12);
  const leans = rand() < 0.25;
  const lean = (rand() < 0.5 ? -1 : 1) * range(0.12, 0.2);
  const ringRoll = rand();
  let top = pick(TOPS_FOR[kind]);
  const tailRoll = rand();

  const ringDims = {
    tube: range(0.12, 0.16),
    gap: range(1.18, 1.26),
    tilt: [range(0.03, 0.09), 0, range(-0.14, 0.14)],
  };
  const topDims = {
    cone: { radius: range(0.24, 0.34), height: range(0.45, 0.7), tilt: range(-0.12, 0.12) },
    sphere: { radius: range(0.2, 0.32) },
    cap: { frac: range(0.75, 0.95), height: range(0.32, 0.46), tilt: range(-0.08, 0.08) },
    nub: { radius: range(0.13, 0.18), length: range(0.1, 0.25), tilt: range(-0.15, 0.15) },
  };
  const tailDims = { radius: range(0.28, 0.38) };

  let ring = RING_ALLOWED[kind] && ringRoll < 0.45;
  let tail = kind === 'lying-capsule' && tailRoll < 0.6;

  // 2 to 4 primitives in all, the body included.
  const count = () => 1 + (ring ? 1 : 0) + TOP_PRIMITIVES[top] + (tail ? 1 : 0);
  if (count() < 2) {
    if (kind === 'lying-capsule') tail = true;
    else top = 'sphere';
  }
  if (count() > 4) ring = false;

  const tilt = leans && kind !== 'lying-capsule' ? lean : 0;

  const adult = {
    tokenId: String(tokenId),
    stage: 'adult',
    state,
    hue,
    accent: HUES[hue],
    body: { kind, ...allDims[kind] },
    scale,
    tilt,
    ring: ring ? ringDims : null,
    top: top === 'none' ? null : { kind: top, ...topDims },
    tail: tail ? tailDims : null,
    face: { expression: stateOf(state).face },
    glow: {
      strength: 4 * stateOf(state).light,
      radius: 0.52 * stateOf(state).glowRadius,
      radiusShare: stateOf(state).glowRadius,
      belowFace: stateOf(state).coreBelowFace ?? false,
    },
    pool: { strength: 0.45 * stateOf(state).pool },
    posture: stateOf(state).posture,
    ...describe(kind, ring, top, tail, tilt),
  };
  return stage === 'adult' ? adult : grow(adult, stage);
}

// The primitive set and how it stacks, without proportions or hue: two pets
// with the same signature are the same build. `top` is a TOPS_FOR kind or 'none'.
function describe(kind, ring, top, tail, tilt) {
  const primitives = [
    BODY_LABEL[kind],
    ...(ring ? ['torus ring'] : []),
    ...(top !== 'none' ? [TOP_LABEL[top]] : []),
    ...(tail ? ['sphere tail'] : []),
  ];
  return {
    signature: [kind, ring ? 'ring' : '', top, tail ? 'tail' : ''].join('|'),
    label: primitives.join(' + ') + (tilt ? ' (leaning)' : ''),
  };
}

// ---- stages (P4): one individual grows up
// A baby and a teen are made from the grown-up's own draws, so they are this
// pet: its hue, its lean, its size factor, its body kind and proportions and
// the shape of its screen (assemble.js › assemblePet) carry through every
// stage; only the parts, the rounding and the amount of vinyl change.
// GROWTH: a stage's linear size against the grown-up. A baby holds 0.6³ ≈ 22%
// of the grown-up body's volume and a teen 0.8³ ≈ 51%, whatever their shape,
// so a pet grows by the same amount whichever body it grows into. The feet
// grow by it too (assemble.js), so they keep the grown-up's proportion.
export const STAGES = ['baby', 'teen', 'adult'];
const GROWTH = { baby: 0.6, teen: 0.8 };
// The teen's part is a bud: this share of its grown-up size (the pet critic's
// M3, the user's «Бутон меньше»: at 0.8 a two-part teen was its grown-up
// shrunk, the same parts at the same proportions).
const BUD = 0.5;

// Close enough for sizing: the profiles' rounded edges are left out (a baby's
// rounder cone and half-dome hold a little less than this says).
function bodyVolume(b) {
  if (b.kind === 'sphere') return (4 / 3) * Math.PI * b.rx * b.rx * b.ry;
  if (b.kind === 'capsule' || b.kind === 'lying-capsule') return Math.PI * b.r * b.r * ((4 / 3) * b.r + b.length);
  if (b.kind === 'cone') return (Math.PI / 3) * b.r * b.r * b.height;
  return ((2 * Math.PI) / 3) * b.r * b.r * b.height; // half-dome
}

// The baby's body (P4 r2, the user's «малыш по типу тела»): one primitive,
// the grown-up's body kind rounded toward a ball, rounder than the teen's: a
// small, soft version of the body it grows into, so a row reads as one
// individual by its silhouette, not only by hue and size. A capsule shorter
// than the teen's reads as a plain ball (worst at the three-quarter view, for
// the lying one), so both capsules keep the teen's proportion; the baby is
// told from the teen by its size, its missing part and its shorter feet.
const BABY_BODY = {
  sphere: (b) => b,
  capsule: (b) => ({ ...b, length: 0.5 * b.length }),
  'lying-capsule': (b) => ({ ...b, length: 0.5 * b.length }),
  cone: (b) => ({ ...b, height: 0.85 * b.height, bottom: 0.3, tip: 0.4 }),
  'half-dome': (b) => ({ ...b, height: 1.3 * b.height, edge: 0.45 }),
};

// The teen's body: the grown-up's kind, rounder, nearer the baby's ball,
// far enough from the grown-up's proportions to tell them apart at the same
// height (a still is fitted by height). A capsule is already at the baby's
// proportion, the roundest a capsule takes (see BABY_BODY).
const TEEN_BODY = {
  sphere: (b) => ({ ...b, ry: (b.ry + b.rx) / 2 }),
  capsule: (b) => ({ ...b, length: 0.5 * b.length }),
  'lying-capsule': (b) => ({ ...b, length: 0.5 * b.length }),
  cone: (b) => ({ ...b, height: 0.72 * b.height, bottom: 0.24, tip: 0.2 }),
  'half-dome': (b) => ({ ...b, height: 1.25 * b.height, edge: 0.36 }),
};

const bud = (dims, keys) => ({ ...dims, ...Object.fromEntries(keys.map((k) => [k, BUD * dims[k]])) });

// The teen's one part: the top if there is one (the crest, the highest point
// of the silhouette, as in the moodboard's stages), else the tail, else the
// ring; the grown-up adds the rest. A cap + sphere top grows from the bottom:
// the teen has the cap.
function teenParts({ top, tail, ring }) {
  if (top) {
    return {
      top: {
        ...top,
        kind: top.kind === 'cap+sphere' ? 'cap' : top.kind,
        cone: bud(top.cone, ['radius', 'height']),
        sphere: bud(top.sphere, ['radius']),
        cap: bud(top.cap, ['height']),
        nub: bud(top.nub, ['radius', 'length']),
      },
      tail: null,
      ring: null,
    };
  }
  if (tail) return { top: null, tail: bud(tail, ['radius']), ring: null };
  return { top: null, tail: null, ring: bud(ring, ['tube']) };
}

function grow(adult, stage) {
  const young = (stage === 'baby' ? BABY_BODY : TEEN_BODY)[adult.body.kind](adult.body);
  const parts = stage === 'baby' ? { top: null, tail: null, ring: null } : teenParts(adult);
  const size = GROWTH[stage] * Math.cbrt(bodyVolume(adult.body) / bodyVolume(young));
  return {
    ...adult,
    stage,
    growth: GROWTH[stage],
    body: young,
    scale: adult.scale * size,
    ...parts,
    ...describe(young.kind, parts.ring, parts.top?.kind ?? 'none', parts.tail, adult.tilt),
  };
}
