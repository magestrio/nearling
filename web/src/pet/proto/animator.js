// The pet in motion (P6): one Animator per shown pet turns what happens to it
// (a new state, stage or outfit in its assembly; a reply, a birth or a hop
// fired by the screen; the pointer) into one frame of numbers per step, which
// Pet.jsx writes onto its meshes, lights and screen. No DOM and no React; no
// allocation in step().
//
// Not moving (paused, reduced motion, a still) it holds the rest pose: the
// assembly's own numbers, copied exactly, so a paused pet is its still. A
// change while not moving is a cut to the new rest pose.
//
// The frame (`out`): the base pose — the assembly's transforms and light, or a
// tween between two of them — and what motion lays over it: the breath, the
// weight shift, the turn after the gaze, a hop, a growth or birth pop, the
// parts' lag on their springs, an item dropping on or coming off, the face.
import * as THREE from 'three';
import { CORE_DEPTH } from './assemble.js';
import { EYE_FACES } from './face.js';
import { STAGES } from './generator.js';
import { BLINK, BOOT, BREATH, DOT_STEP, EASE, FOLLOW, GAZE, HOP, HOP_MS, MS, SPRINGS, SWAY_PERIOD, TALK, hopAt, span, springStep } from './motion.js';

// ---- the rest pose: an assembly's numbers in one flat array

export const BODY = 0; // position 3, rotation 3 (order ZYX), scale 3
export const ITEM = 9; // position 3, rotation 3
export const LIGHT = 15; // glow strength, glow radius, spill, pool strength, pool radius x, y, pool x, z, core x, y, z
export const PARTS = 26; // per part: position 3, rotation 3; then per foot: its top's height
export const footAt = (a, i) => PARTS + 6 * a.parts.length + i;

// The core light's numbers, as the stills have always had them: its glow on
// the vinyl, its spill onto the feet and the ring (a point light), its pool.
// The spill follows the light the glow really gives off: its peak on the body
// (the core sits CORE_DEPTH behind the front, so a smaller spot peaks lower
// for the same strength) times the spot's area. Full: 0.7 of the strength.
export function lightOf(assembly, gains) {
  const { spec } = assembly;
  const glowStrength = spec.glow.strength * gains.glow;
  const peak = (radius) => Math.exp(-((CORE_DEPTH / radius) ** 2));
  const { radius, radiusShare } = spec.glow;
  const spill = 0.7 * (peak(radius) / peak(radius / radiusShare)) * radiusShare ** 2;
  return { glowStrength, glowRadius: assembly.glowRadius, spill: glowStrength * spill, poolStrength: spec.pool.strength * gains.pool };
}

function restPose(a, gains) {
  const out = new Float64Array(footAt(a, a.feet.length));
  const { body, outfit } = a;
  const l = lightOf(a, gains);
  out.set([...body.position, ...body.rotation.slice(0, 3), ...body.scale], BODY);
  out.set(outfit ? [...outfit.position, ...outfit.rotation] : [0, 0, 0, 0, 0, 0], ITEM);
  out.set([l.glowStrength, l.glowRadius, l.spill, l.poolStrength, ...a.pool.radius, a.pool.position[0], a.pool.position[2], ...a.coreLocal], LIGHT);
  a.parts.forEach((p, i) => out.set([...p.position, ...p.rotation], PARTS + 6 * i));
  a.feet.forEach((f, i) => (out[footAt(a, i)] = f.position[1]));
  return out;
}

// The glow's peak on the body at a radius: a light tween runs through it, so
// the glow brightens or dims evenly while its spot grows or shrinks.
const glowPeak = (radius, scale) => Math.exp(-(((CORE_DEPTH * scale) / radius) ** 2));

// ---- the face's way out of one look and into the next: [lid, level, ms]
// steps before the steady face takes over (lid 1 half shut, 2 shut)
const CLOSE = {
  happy: [[1, 1, 60], [2, 1, 80]],
  calm: [[1, 1, 60], [2, 1, 80]],
  drowsy: [[1, 1, 80], [2, 1, 120]],
  asleep: [[0, 0.5, 80]],
};
const OPEN = {
  happy: [[2, 1, 60], [1, 1, 60]],
  calm: [[1, 1, 80]],
  drowsy: [[2, 1, 100], [1, 1, 100]],
  asleep: [[0, 0.35, 100], [0, 0.7, 100]], // the «z z» come up in two dim steps
};
const DARK = 80; // the screen dark between the eyes and the «z z»
const EXPRESSIONS = ['happy', 'calm', 'drowsy', 'asleep', 'thinking', 'boot', 'off'];

// How long a change of state takes and how it eases: sinking into hunger or
// sleep is slow; waking stretches (the vinyl bounce overshoots upright).
function stateChange(from, to) {
  if (to === 'asleep' || to === 'hungry') return { dur: MS.long, ease: EASE.standard };
  if (from === 'asleep') return { dur: MS.medium, ease: EASE.press };
  return { dur: MS.medium, ease: EASE.standard };
}

// Birth, ms from its start: [start, duration] of each step.
const BIRTH = { pool: [0, MS.short], feet: [100, MS.short], body: [250, MS.medium], screen: 450, light: [450, MS.medium], parts: 700 };
const SNAP = { dur: MS.short, gap: MS.micro }; // a part snapping on, and the next one after it
const GROW = { crouch: MS.micro, pop: MS.medium, squash: 0.08 };
// An item dropping on: from `height` (a share of the pet's height) in a
// `fall`, then a `settle` (a share of the height) on its spring as it lands.
const DROP = { fall: 280, height: 0.45, settle: 0.012, impact: 0.04 };
const LEAVE = { dur: MS.short, lift: 0.12 };
// The most a part trails its place by, a share of the pet's height: parts
// stay on the body.
const LAG_LIMIT = 0.03;

const rand = ([lo, hi]) => lo + (hi - lo) * Math.random();
// A lag held within ±limit, softly.
const held = (d, limit) => limit * Math.tanh(d / limit);
const spring3 = () => ({ x: { x: 0, v: 0 }, y: { x: 0, v: 0 }, z: { x: 0, v: 0 } });
// The step of a sequence at time t, or null when it is over.
function stepOf(seq, t) {
  for (let i = 0; i < seq.length; i++) if (t < seq[i].end) return seq[i];
  return null;
}

export class Animator {
  constructor(gains) {
    this.gains = gains;
    this.a = null;
    this.moving = false;
    this.t = 0; // ms of motion so far
    this.dirty = true; // `out` changed since Pet.jsx last wrote it
    this.impact = null;
    this.out = {
      pose: null,
      breath: 1, // the body's height share (its width the inverse)
      pitch: 0,
      yaw: 0,
      sway: 0,
      pop: 1, // the body's own scale (birth)
      hopY: 0,
      squash: 0, // the whole pet's, a share off its height
      grow: 1, // the whole pet's scale (growth)
      feet: 1, // the feet's height share (birth)
      partOffset: null, // per part, in the body's frame
      partScale: null,
      itemOffset: new Float64Array(3),
      itemHidden: false,
      leaving: -1, // the old item's way off, 0–1; -1 none
      glow: 1,
      pool: 1,
      poolRadius: 1,
      face: { expression: 'happy', dx: 0, dy: 0, lid: 0, level: 1, step: null },
      faceKey: -1,
    };
    this.hopNow = { y: 0, squash: 0 };
    this.m = { body: new THREE.Matrix4(), hop: new THREE.Matrix4(), q: new THREE.Quaternion(), e: new THREE.Euler(), p: new THREE.Vector3(), s: new THREE.Vector3(), v: new THREE.Vector3() };
  }

  // ---- what happens to the pet

  setMoving(moving) {
    if (moving === this.moving) return;
    this.moving = moving;
    if (this.a) this.cut();
  }

  // A new assembly: the same pet in a new state (a tween), a stage up (a
  // pop), in another outfit (a drop), or another pet (a cut). expression: the
  // face to show (the state's, or full's other mood).
  setAssembly(a, expression) {
    const prev = this.a;
    const shown = this.out.face.expression;
    const from = this.out.pose;
    this.a = a;
    this.expression = expression;
    this.rest = restPose(a, this.gains);
    this.anchors = a.parts.map((p) => new THREE.Vector3(...p.position));
    // The item rides near the crown.
    this.itemAnchor = new THREE.Vector3(0, (0.85 * (a.bounds.top - a.body.position[1])) / a.body.scale[1], 0);
    const grew = prev && STAGES.indexOf(a.spec.stage) > STAGES.indexOf(prev.spec.stage);
    if (!this.moving || !prev || prev.spec.tokenId !== a.spec.tokenId || (prev.spec.stage !== a.spec.stage && !grew)) return this.cut();

    const sameLayout = from.length === this.rest.length && prev.parts.length === a.parts.length;
    this.resize();
    if (grew) {
      this.growth = this.growthOf(prev, a);
      this.tween = { from: lightFrom(from, this.rest), start: this.t + GROW.crouch, dur: GROW.pop, ease: EASE.press };
      this.out.grow = this.growth.scaleFrom;
      this.resetSprings();
    } else if (prev.spec.state !== a.spec.state || prev.wearing !== a.wearing || !sameLayout) {
      const { dur, ease } = stateChange(prev.spec.state, a.spec.state);
      this.tween = { from: sameLayout ? from.slice() : lightFrom(from, this.rest), start: this.t, dur, ease };
      if (prev.spec.state === 'hungry' && a.spec.state === 'full') this.hop(this.t + dur); // fed: it perks up, then hops
    }
    if (prev.wearing !== a.wearing) {
      this.leaving = prev.outfit ? { start: this.t } : null;
      this.drop = a.outfit ? { start: this.t + (prev.outfit ? MS.micro : 0), landed: false } : null;
      this.placeSpring(this.itemSpring, this.itemAnchor);
    }
    if (shown !== expression) this.faceTo(shown, expression);
    this.dirty = true;
  }

  // From the screen: 'talk' ({ ms }: a reply landed), 'birth' (the first
  // show of a newborn), 'hop'. Not moving, nothing happens: the still stays.
  fire(name, opts = {}) {
    if (!this.moving || !this.a) return;
    if (name === 'talk') {
      this.talk = { end: this.t + (opts.ms ?? TALK.min), up: false, next: this.t, left: Math.round(rand(TALK.word)) };
    } else if (name === 'hop') {
      this.hop(this.t, opts.height);
    } else if (name === 'birth') {
      this.cut();
      const partsEnd = BIRTH.parts + this.a.parts.length * SNAP.gap + SNAP.dur;
      const dropAt = this.a.outfit ? partsEnd : null;
      this.birth = { start: this.t, dropAt };
      this.faceSeq = this.sequence([['off', 0, 1, BIRTH.screen], ...frames(this.expression, OPEN)]);
      this.hop(this.t + (dropAt === null ? partsEnd + 100 : dropAt + DROP.fall + MS.short));
      this.stepBirth(this.t);
    }
    this.dirty = true;
  }

  // Everything to the rest pose of the current assembly.
  cut() {
    this.resize();
    const o = this.out;
    o.pose.set(this.rest);
    this.tween = this.growth = this.birth = this.drop = this.leaving = this.talk = this.hopping = this.impact = null;
    this.faceSeq = this.blink = null;
    this.bootStart = this.t;
    this.nextBlink = this.t + 1000 * rand(BLINK.every);
    this.phase = this.swayPhase = 0;
    this.breathNow = null;
    this.nod = this.followX = this.followY = this.dropY = 0;
    this.gaze = { x: { x: 0, v: 0 }, y: { x: 0, v: 0 }, dx: 0, dy: 0 };
    o.breath = o.pop = o.grow = o.feet = o.glow = o.pool = o.poolRadius = 1;
    o.pitch = o.yaw = o.sway = o.hopY = o.squash = 0;
    o.partScale.fill(1);
    o.itemHidden = false;
    o.leaving = -1;
    this.resetSprings();
    this.setFace(this.expression, 0, 1, null);
    this.dirty = true;
  }

  // ---- one step: dt in ms; pull: the pointer's pull on the eyes, { x, y }
  // in -1–1 (y up), or null with no pointer

  step(dt, pull) {
    if (!this.moving || !this.a) return;
    dt = Math.min(dt, 50); // after a stall, carry on rather than jump
    this.t += dt;
    const t = this.t;
    this.stepTween(t);
    this.stepBreath(dt);
    this.stepGaze(dt, pull);
    this.stepHop(t);
    this.stepGrowth(t);
    this.stepBirth(t);
    this.stepItem(t);
    this.stepSprings(dt);
    this.stepFace(t);
    this.dirty = true;
  }

  stepTween(t) {
    const tw = this.tween;
    if (!tw) return;
    const pose = this.out.pose;
    const to = this.rest;
    const k = span(t, tw.start, tw.dur, tw.ease);
    const kl = span(t, tw.start, tw.dur, EASE.standard); // the light never overshoots
    for (let i = 0; i < to.length; i++) pose[i] = tw.from[i] + (to[i] - tw.from[i]) * (i >= LIGHT && i < PARTS ? kl : k);
    const s = this.a.spec.scale;
    const p0 = tw.from[LIGHT] * glowPeak(tw.from[LIGHT + 1], s);
    const p1 = to[LIGHT] * glowPeak(to[LIGHT + 1], s);
    pose[LIGHT] = (p0 + (p1 - p0) * kl) / glowPeak(pose[LIGHT + 1], s);
    if (t >= tw.start + tw.dur) {
      pose.set(to);
      this.tween = null;
    }
  }

  stepBreath(dt) {
    const o = this.out;
    const want = BREATH[this.a.spec.state];
    // The depths ease toward a new state's, so a change of breath never jumps.
    const b = (this.breathNow ??= { depth: want.depth, sway: want.sway, nod: want.nod ?? 0, ember: want.ember ?? 0 });
    const k = Math.min(1, dt / 400);
    b.depth += (want.depth - b.depth) * k;
    b.sway += (want.sway - b.sway) * k;
    b.nod += ((want.nod ?? 0) - b.nod) * k;
    b.ember += ((want.ember ?? 0) - b.ember) * k;
    this.phase += (2 * Math.PI * dt) / (1000 * want.period);
    this.swayPhase += (2 * Math.PI * dt) / (1000 * want.period * SWAY_PERIOD);
    const breath = Math.sin(this.phase);
    const sway = Math.sin(this.swayPhase);
    o.breath = 1 + b.depth * breath;
    o.sway = b.sway * sway;
    this.nod = b.nod * 0.5 * (1 - breath); // deepest at the end of a breath out
    o.glow = 1 + b.ember * breath;
    // Where a part would be if it rode the breath FOLLOW s late, per unit of
    // its height: the difference is its lag (stepSprings).
    const late = (2 * Math.PI * FOLLOW) / want.period;
    this.followY = b.depth * (Math.sin(this.phase - late) - breath);
    this.followX = -b.sway * (Math.sin(this.swayPhase - late / SWAY_PERIOD) - sway);
  }

  stepGaze(dt, pull) {
    const g = this.gaze;
    const looking = pull && EYE_FACES.has(this.expression) && !this.faceSeq;
    const f = this.a.spec.state === 'hungry' ? GAZE.fDrowsy : GAZE.f;
    springStep(g.x, looking ? pull.x : 0, f, 1, dt / 1000);
    springStep(g.y, looking ? pull.y : 0, f, 1, dt / 1000);
    // Whole pixels, with a little hysteresis so the eyes never flicker
    // between two columns.
    const wantX = g.x.x * GAZE.cols;
    const wantY = -g.y.x * GAZE.rows;
    if (Math.abs(wantX - g.dx) > 0.75) g.dx = Math.max(-GAZE.cols, Math.min(GAZE.cols, Math.round(wantX)));
    if (Math.abs(wantY - g.dy) > 0.75) g.dy = Math.max(-GAZE.rows, Math.min(GAZE.rows, Math.round(wantY)));
    this.out.yaw = g.x.x * GAZE.yaw;
    this.out.pitch = -g.y.x * GAZE.pitch + this.nod;
  }

  hop(start, height = HOP.height) {
    this.hopping = { start, height: height * this.a.bounds.top };
  }

  stepHop(t) {
    const o = this.out;
    const h = this.hopping;
    o.hopY = o.squash = 0;
    o.pool = o.poolRadius = 1;
    if (!h) return;
    const { y, squash } = hopAt(t - h.start, h.height, this.hopNow);
    o.hopY = y;
    o.squash = squash;
    // The pool stays on the ground, fainter and smaller under a pet in the air.
    o.pool = 1 - (0.35 * y) / h.height;
    o.poolRadius = 1 - (0.1 * y) / h.height;
    if (t - h.start >= HOP_MS) this.hopping = null;
  }

  // A stage up: the new body shown at the old one's size, a crouch, then it
  // pops to its own; the part it had grows into its grown-up part, and each
  // new part snaps on from nothing.
  growthOf(prev, a) {
    const scaleFrom = prev.bounds.top / a.bounds.top;
    const rankOf = (parts, i) => parts.slice(0, i).filter((p) => p.role === parts[i].role).length;
    const radius = (g) => (g.boundingSphere ?? (g.computeBoundingSphere(), g.boundingSphere)).radius;
    let fresh = 0;
    const parts = a.parts.map((p, i) => {
      const j = prev.parts.findIndex((q, k) => q.role === p.role && rankOf(prev.parts, k) === rankOf(a.parts, i));
      if (j < 0) return { from: 1e-4, start: GROW.crouch + 0.75 * GROW.pop + SNAP.gap * fresh++, dur: SNAP.dur };
      const from = (radius(prev.parts[j].geometry) * prev.spec.scale) / (radius(p.geometry) * a.spec.scale * scaleFrom);
      return { from, start: GROW.crouch, dur: GROW.pop };
    });
    return { start: this.t, scaleFrom, parts };
  }

  stepGrowth(t) {
    const g = this.growth;
    if (!g) return;
    const o = this.out;
    const u = t - g.start;
    o.grow = g.scaleFrom + (1 - g.scaleFrom) * span(u, GROW.crouch, GROW.pop, EASE.press);
    o.squash += u < GROW.crouch ? GROW.squash * Math.sin((Math.PI / 2) * (u / GROW.crouch)) : GROW.squash * (1 - span(u, GROW.crouch, MS.short));
    let done = u >= GROW.crouch + GROW.pop;
    for (let i = 0; i < g.parts.length; i++) {
      const p = g.parts[i];
      o.partScale[i] = Math.max(1e-4, p.from + (1 - p.from) * span(u, p.start, p.dur, EASE.press));
      done &&= u >= p.start + p.dur;
    }
    if (done) {
      o.grow = 1;
      o.partScale.fill(1);
      this.growth = null;
    }
  }

  // Birth: the pool's light, the feet out of the ground, the body popping up
  // onto them, the screen coming on, the core light, the parts one by one,
  // then a worn item dropping on; a hop to end it (fire).
  stepBirth(t) {
    const b = this.birth;
    if (!b) return;
    const o = this.out;
    const u = t - b.start;
    o.pool *= span(u, BIRTH.pool[0], BIRTH.pool[1], EASE.enter);
    o.feet = Math.max(1e-4, span(u, BIRTH.feet[0], BIRTH.feet[1], EASE.press));
    o.pop = Math.max(1e-4, span(u, BIRTH.body[0], BIRTH.body[1], EASE.press));
    o.glow *= span(u, BIRTH.light[0], BIRTH.light[1]);
    let done = u >= BIRTH.light[0] + BIRTH.light[1];
    for (let i = 0; i < o.partScale.length; i++) {
      const start = BIRTH.parts + i * SNAP.gap;
      o.partScale[i] = Math.max(1e-4, span(u, start, SNAP.dur, EASE.press));
      done &&= u >= start + SNAP.dur;
    }
    o.itemHidden = b.dropAt !== null && u < b.dropAt;
    if (b.dropAt !== null && u >= b.dropAt && !b.dropped) {
      b.dropped = true;
      this.drop = { start: t, landed: false };
      this.placeSpring(this.itemSpring, this.itemAnchor);
    }
    if (done && !o.itemHidden) {
      o.feet = o.pop = 1;
      o.partScale.fill(1);
      this.birth = null;
    }
  }

  // An item dropping on (a fall, then a settle on its spring as it lands, the
  // pet squashing a little under it) and the old one coming off (lifted and
  // shrunk to nothing; Pet.jsx draws it).
  stepItem(t) {
    const o = this.out;
    const d = this.drop;
    this.dropY = 0;
    if (d) {
      const u = (t - d.start) / DROP.fall;
      const height = DROP.height * this.a.bounds.top;
      if (u < 1) this.dropY = height * (1 - Math.max(0, u) ** 2);
      else if (!d.landed) {
        d.landed = true;
        this.itemSpring.y.v -= DROP.settle * this.a.bounds.top * 2 * Math.PI * SPRINGS.item.f;
        this.impact = t;
      } else this.drop = null;
    }
    if (this.impact !== null) {
      o.squash += DROP.impact * (1 - span(t - this.impact, 0, MS.short, EASE.press));
      if (t - this.impact >= MS.short) this.impact = null;
    }
    const l = this.leaving;
    o.leaving = l ? Math.min(1, (t - l.start) / LEAVE.dur) : -1;
    if (l && o.leaving >= 1) {
      this.leaving = null;
      o.leaving = -1;
    }
  }

  // The parts and the item on springs: each follows where the body carries
  // its anchor; how far it trails is its offset, in the body's frame.
  stepSprings(dt) {
    const o = this.out;
    const { body, v } = this.m;
    const s = this.bodyMatrix();
    const parts = this.a.parts;
    for (let i = 0; i < parts.length; i++) this.ride(this.springs[i], this.anchors[i], SPRINGS[parts[i].role], o.partOffset, 3 * i, dt, body, v, s);
    if (this.a.outfit) {
      this.ride(this.itemSpring, this.itemAnchor, SPRINGS.item, o.itemOffset, 0, dt, body, v, s);
      o.itemOffset[1] += this.dropY / (s.y * o.grow);
    }
  }

  ride(spring, anchor, tune, offset, at, dt, body, v, s) {
    const o = this.out;
    v.copy(anchor).applyMatrix4(body);
    springStep(spring.x, v.x, tune.f, tune.zeta, dt / 1000);
    springStep(spring.y, v.y, tune.f, tune.zeta, dt / 1000);
    springStep(spring.z, v.z, tune.f, tune.zeta, dt / 1000);
    // Back into the body's frame (its rotation is small enough to leave
    // out), held on the body, plus the breath's follow-through.
    const limit = LAG_LIMIT * this.a.bounds.top;
    offset[at] = held(spring.x.x - v.x, limit) / (s.x * o.grow) + anchor.y * this.followX;
    offset[at + 1] = held(spring.y.x - v.y, limit) / (s.y * o.grow) + anchor.y * this.followY;
    offset[at + 2] = held(spring.z.x - v.z, limit) / (s.z * o.grow);
  }

  // The body's matrix in pet space now (into this.m.body): the hop and the
  // growth about the ground, then the body's own transform with the breath,
  // the sway and the gaze. Returns the body's own scale.
  bodyMatrix() {
    const { body, hop, q, e, p, s } = this.m;
    const o = this.out;
    const pose = o.pose;
    const across = 1 / Math.sqrt(1 - o.squash);
    hop.compose(p.set(0, o.hopY, 0), q.identity(), s.set(o.grow * across, o.grow * (1 - o.squash), o.grow * across));
    const breathAcross = 1 / Math.sqrt(o.breath);
    e.set(pose[BODY + 3] + o.pitch, pose[BODY + 4] + o.yaw, pose[BODY + 5] + o.sway, 'ZYX');
    s.set(pose[BODY + 6] * breathAcross * o.pop, pose[BODY + 7] * o.breath * o.pop, pose[BODY + 8] * breathAcross * o.pop);
    body.compose(p.set(pose[BODY], pose[BODY + 1], pose[BODY + 2]), q.setFromEuler(e), s).premultiply(hop);
    return s;
  }

  resize() {
    const n = this.a.parts.length;
    const o = this.out;
    if (!o.pose || o.pose.length !== this.rest.length) o.pose = this.rest.slice();
    if (!o.partScale || o.partScale.length !== n) {
      o.partOffset = new Float64Array(3 * n);
      o.partScale = new Float64Array(n).fill(1);
    }
  }

  resetSprings() {
    this.springs = this.a.parts.map(spring3);
    this.itemSpring = spring3();
    this.a.parts.forEach((_, i) => this.placeSpring(this.springs[i], this.anchors[i]));
    this.placeSpring(this.itemSpring, this.itemAnchor);
    this.out.partOffset.fill(0);
    this.out.itemOffset.fill(0);
  }

  // A spring at rest where the body has its anchor now.
  placeSpring(spring, anchor) {
    this.bodyMatrix();
    const v = this.m.v.copy(anchor).applyMatrix4(this.m.body);
    spring.x.x = v.x;
    spring.y.x = v.y;
    spring.z.x = v.z;
    spring.x.v = spring.y.v = spring.z.v = 0;
  }

  // ---- the screen

  // From the face shown now to the new one: the old one shuts, the screen
  // goes dark around the «z z», the new one opens. A boot types itself once
  // the old face is out.
  faceTo(from, to) {
    const dark = from === 'asleep' || to === 'asleep' ? [['off', 0, 1, DARK]] : [];
    this.faceSeq = this.sequence([...frames(from, CLOSE), ...dark, ...frames(to, OPEN)]);
    this.bootStart = this.faceSeq ? this.faceSeq[this.faceSeq.length - 1].end : this.t;
  }

  sequence(steps) {
    if (!steps.length) return null;
    let at = this.t;
    return steps.map(([expression, lid, level, ms]) => ({ expression, lid, level, end: (at += ms) }));
  }

  stepFace(t) {
    if (this.faceSeq) {
      const now = stepOf(this.faceSeq, t);
      if (now) return this.setFace(now.expression, now.lid, now.level, null);
      this.faceSeq = null;
    }
    const expression = this.expression;
    if (expression === 'thinking') return this.setFace(expression, 0, 1, Math.floor(t / DOT_STEP) % 3);
    if (expression === 'boot') {
      const typed = Math.floor((t - this.bootStart - BOOT.dark) / BOOT.perPixel);
      if (typed < 0) return this.setFace('off', 0, 1, null);
      return this.setFace(expression, 0, 1, typed + 1 >= this.bootPixels() ? null : typed + 1);
    }
    if (!EYE_FACES.has(expression)) return this.setFace(expression, 0, 1, null);

    // Eyes: a blink now and then, the gaze, the talk's syllables.
    if (!this.blink && t >= this.nextBlink) {
      const steps = expression === 'drowsy' ? BLINK.drowsy : BLINK.steps;
      const blink = Math.random() < BLINK.twice ? [...steps, [0, 90], ...steps] : steps;
      this.blink = this.sequence(blink.map(([lid, ms]) => [expression, lid, 1, ms]));
    }
    let lid = 0;
    if (this.blink) {
      const now = stepOf(this.blink, t);
      if (now) lid = now.lid;
      else {
        this.blink = null;
        this.nextBlink = t + 1000 * rand(BLINK.every);
      }
    }
    let talkDy = 0;
    const talk = this.talk;
    if (talk && t >= talk.end) this.talk = null;
    else if (talk) {
      if (t >= talk.next) {
        talk.up = !talk.up;
        if (!talk.up && --talk.left <= 0) {
          talk.left = Math.round(rand(TALK.word));
          talk.next = t + rand(TALK.gap); // between words
        } else talk.next = t + rand(talk.up ? TALK.up : TALK.down);
      }
      talkDy = talk.up ? -1 : 0;
    }
    this.setFace(expression, lid, 1, null, this.gaze.dx, this.gaze.dy + talkDy);
  }

  // The boot log's lit pixels on this pet's screen (face.js › boot).
  bootPixels() {
    const { w, h, rows = 12 } = this.a.face;
    const cols = Math.round((rows * w) / h);
    const width = cols - 2 * Math.round(0.17 * cols);
    return Math.round(0.65 * width) + Math.round(0.4 * width) + Math.round(0.5 * width);
  }

  setFace(expression, lid, level, step, dx = 0, dy = 0) {
    const f = this.out.face;
    f.expression = expression;
    f.lid = lid;
    f.level = level;
    f.step = step;
    f.dx = dx;
    f.dy = dy;
    const id = EXPRESSIONS.indexOf(expression);
    this.out.faceKey = id + 8 * (lid + 3 * (dx + 4 + 9 * (dy + 4 + 9 * (Math.round(level * 100) + 101 * (step === null ? 0 : step + 1)))));
  }
}

// A face's way in or out, as sequence steps.
function frames(expression, table) {
  return (table[expression] ?? []).map(([lid, level, ms]) => [expression, lid, level, ms]);
}

// A tween's start for a pose of a new layout (a new stage): the transforms
// already where the new pose has them, the light where it was.
function lightFrom(from, rest) {
  const out = rest.slice();
  for (let i = LIGHT; i < PARTS; i++) out[i] = from[i];
  return out;
}
