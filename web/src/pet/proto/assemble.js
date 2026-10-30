// Turns a pet's seeded data (generator.js) into geometry and placements:
// the body, the face fitted onto it, the ring cleared below the face, the top
// pieces seated on the body, the core light behind the belly, the feet raised
// to meet the underside, the worn item (outfits.js) fitted onto the crown,
// and the bounds used for framing. No DOM: it also runs
// in Node (scripts/stills.mjs, scripts/pick-seeds.mjs).
import * as THREE from 'three';
import { makePet } from './generator.js';
import { projectRim, projectScreen, rimFits, rimOutside } from './face.js';
import { OUTFITS } from './outfits.js';

export const FOOT = { radius: 0.17, tilt: 0.1 };
const VISIBLE_LEG = 0.29; // ground to the underside, at the feet
const FEET_GAP = 0.04; // a foot's edge stays at least this far from the body's middle line, across and front to back
export const CORE_DEPTH = 0.45; // the core sits this far behind the front surface
const EMBER_CLEARANCE = 0.1; // the ember's centre sits this far below the rim's lower edge (lower, a ringed half-dome's ring hides it)
const UP = new THREE.Vector3(0, 1, 0);

function lathe(points, segments) {
  // phiStart = PI puts the lathe seam at the back, away from the face.
  return new THREE.LatheGeometry(
    points.map(([r, y]) => new THREE.Vector2(r, y)),
    segments,
    Math.PI,
  );
}

// ---- body profiles: [r, y] from the bottom pole to the top pole, y rising

function sphereProfile({ rx, ry }, steps = 72) {
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * Math.PI;
    pts.push([rx * Math.sin(t), ry * (1 - Math.cos(t))]);
  }
  return pts;
}

function capsuleProfile(r, length, steps = 24) {
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * (Math.PI / 2);
    pts.push([r * Math.sin(t), r - r * Math.cos(t)]);
  }
  for (let i = 1; i <= 8; i++) pts.push([r, r + (length * i) / 8]);
  for (let i = 1; i <= steps; i++) {
    const t = Math.PI / 2 + (i / steps) * (Math.PI / 2);
    pts.push([r * Math.sin(t), r + length - r * Math.cos(t)]);
  }
  return pts;
}

// A cone with a rounded belly-bottom and a softened tip; `bottom` and `tip`
// are the shares of the height they round (a baby's cone rounds more).
function coneProfile({ r, height, bottom = 0.16, tip = 0.05 }, steps = 72) {
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const roundBottom = t < bottom ? Math.sqrt(1 - (1 - t / bottom) ** 2) : 1;
    const roundTip = t > 1 - tip ? Math.sqrt(Math.max(0, 1 - ((t - (1 - tip)) / tip) ** 2)) : 1;
    pts.push([r * (1 - t) * roundBottom * roundTip, height * t]);
  }
  return pts;
}

// A half-dome: flat underside, a rounded rim of radius `edge` (a baby's is
// rounder), an elliptic dome.
function halfDomeProfile({ r, height, edge = 0.24 }, steps = 48) {
  const e = edge;
  const pts = [
    [0, 0],
    [(r - e) * 0.5, 0],
  ];
  for (let i = 0; i <= 12; i++) {
    const a = -Math.PI / 2 + (i / 12) * (Math.PI / 2);
    pts.push([r - e + e * Math.cos(a), e + e * Math.sin(a)]);
  }
  for (let i = 1; i <= steps; i++) {
    const u = (i / steps) * (Math.PI / 2);
    pts.push([r * Math.cos(u), e + (height - e) * Math.sin(u)]);
  }
  return pts;
}

function radiusAtHeight(profile, y) {
  for (let i = 0; i < profile.length - 1; i++) {
    const [r0, y0] = profile[i];
    const [r1, y1] = profile[i + 1];
    if (y >= y0 && y <= y1) return y1 === y0 ? Math.max(r0, r1) : r0 + ((r1 - r0) * (y - y0)) / (y1 - y0);
  }
  return 0;
}

// Height of the upper surface at radius r, walking down from the top pole.
function upperHeightAtRadius(profile, r) {
  for (let i = profile.length - 1; i > 0; i--) {
    const [r0, y0] = profile[i];
    const [r1, y1] = profile[i - 1];
    if (r >= r0 && r <= r1) return r1 === r0 ? y0 : y0 + ((y1 - y0) * (r - r0)) / (r1 - r0);
  }
  return profile[0][1];
}

const everyOther = (profile) => profile.filter((_, i) => i % 2 === 0 || i === profile.length - 1);

function revolution(profile, { face, ringY, spread, coreY = null }) {
  const height = profile[profile.length - 1][1];
  const maxR = Math.max(...profile.map((p) => p[0]));
  const s = (spread * maxR) / Math.SQRT2;
  return {
    geometry: lathe(profile, 128),
    proxy: lathe(everyOther(profile), 48), // coarse twin for raycasts
    height,
    halfX: maxR,
    halfZ: maxR,
    radiusAt: (y) => radiusAtHeight(profile, y),
    upperAt: (r) => upperHeightAtRadius(profile, r),
    topX: 0,
    face,
    ringY,
    coreY,
    feet: [
      [s, s],
      [s, -s],
      [-s, s],
      [-s, -s],
    ],
  };
}

function bodyShape(b) {
  if (b.kind === 'sphere') {
    const H = 2 * b.ry;
    return revolution(sphereProfile(b), { face: { x: 0, y: 0.63 * H, w: 1.22, h: 0.6 }, ringY: 0.41 * H, spread: 0.52 });
  }
  if (b.kind === 'capsule') {
    // Near a rounded square, at the middle of the front, with a wider rim (the
    // pet critic's M2, the user's «Экран-квадрат»): the wide screen high on the
    // capsule's straight front, over short black feet, read as a visor.
    return revolution(capsuleProfile(b.r, b.length), {
      face: { x: 0, y: b.r + 0.5 * b.length, w: 1.0, h: 0.78, keep: true, rows: 20, eyes: [0.33, 0.67], rim: 1.6 },
      ringY: b.r + 0.2 * b.length,
      spread: 0.55,
    });
  }
  if (b.kind === 'cone') {
    // The face sits above the rounded bottom so the belly below it faces forward.
    return revolution(coneProfile(b), { face: { x: 0, y: 0.4 * b.height, w: 1.15, h: 0.52 }, ringY: 0.12 * b.height, spread: 0.52 });
  }
  if (b.kind === 'half-dome') {
    const e = b.edge ?? 0.24;
    return revolution(halfDomeProfile(b), {
      face: { x: 0, y: e + 0.46 * (b.height - e), w: 1.22, h: 0.46 },
      ringY: 0.3,
      spread: 0.55,
      // Up on the dome's upright front, not on the rounded rim that faces down.
      coreY: Math.max(0.34, e + 0.1),
    });
  }
  // A capsule lying on its side, long axis along x.
  const { r, length } = b;
  const toLying = (g) => g.translate(0, -(r + length / 2), 0).rotateZ(Math.PI / 2).translate(0, r, 0);
  const profile = capsuleProfile(r, length);
  const fx = 0.42 * (length / 2 + r);
  const fz = 0.45 * r;
  return {
    geometry: toLying(lathe(profile, 128)),
    proxy: toLying(lathe(everyOther(profile), 48)),
    height: 2 * r,
    halfX: length / 2 + r,
    halfZ: r,
    radiusAt: null,
    upperAt: (rr) => r + Math.sqrt(Math.max(r * r - rr * rr, 0)),
    topX: -0.12 * length,
    face: { x: 0.18 * length, y: 1.18 * r, w: 1.12, h: 0.52 },
    ringY: null,
    coreY: null,
    feet: [
      [fx, fz],
      [fx, -fz],
      [-fx, fz],
      [-fx, -fz],
    ],
  };
}

// ---- part geometries (origin at the part's base unless noted)

// A cone with a softened tip; its base runs down into the body so the seam is
// a clean intersection.
function coneGeometry(radius, height) {
  const tipR = 0.035;
  const pts = [
    [0, -0.3],
    [radius * 1.05, -0.3],
    [radius, 0],
    [tipR * 1.6, height - tipR * 2.2],
  ];
  for (let i = 1; i <= 5; i++) {
    const a = (i / 5) * (Math.PI / 2);
    pts.push([tipR * 1.6 * Math.cos(a), height - tipR * 2.2 + tipR * 2.2 * Math.sin(a)]);
  }
  return lathe(pts, 96);
}

function capGeometry(radius, height) {
  const pts = [[0, 0]];
  for (let i = 0; i <= 24; i++) {
    const a = (i / 24) * (Math.PI / 2);
    pts.push([radius * Math.cos(a), height * Math.sin(a)]);
  }
  return lathe(pts, 96);
}

// A short cylinder with a rounded bottom edge; its top (y = 0) sits inside the body.
function footGeometry(radius, height) {
  const e = 0.035;
  const pts = [[0, -height]];
  for (let i = 0; i <= 6; i++) {
    const a = (i / 6) * (Math.PI / 2);
    pts.push([radius - e + e * Math.sin(a), -height + e - e * Math.cos(a)]);
  }
  pts.push([radius, 0]);
  pts.push([0, 0]);
  return lathe(pts, 48);
}

// ---- placement helpers

function cast(geometry, origin, dir) {
  const ray = new THREE.Raycaster(origin, dir);
  return ray.intersectObject(new THREE.Mesh(geometry, new THREE.MeshBasicMaterial()))[0] ?? null;
}

// keepAspect: shrink the width and height together (a younger stage keeps the
// grown-up's screen shape, a near-square screen keeps its own); otherwise
// the height follows the width down.
function fitFace(proxy, preferred, keepAspect = false) {
  keepAspect ||= Boolean(preferred.keep);
  let face = { ...preferred };
  for (let i = 0; i < 40 && !rimFits(proxy, face); i++) {
    const w = face.w * 0.95;
    face = { ...face, w, h: keepAspect ? face.h * 0.95 : Math.min(face.h, w * 0.55) };
  }
  if (!rimFits(proxy, face)) throw new Error('no face size fits this body');
  return face;
}

function placeRing(shape, ring, face) {
  const band = (y) => Math.max(...[-1, -0.5, 0, 0.5, 1].map((k) => shape.radiusAt(y + k * ring.tube)));
  const faceBottom = face.y - face.h / 2;
  const guess = band(shape.ringY) * ring.gap + 0.03;
  // The ring's front must pass below the face, never across it.
  const highest = faceBottom + guess * Math.sin(ring.tilt[0]) - 0.6 * Math.abs(Math.sin(ring.tilt[2])) - ring.tube + 0.02;
  const y = Math.min(shape.ringY, highest);
  const radius = band(y) * ring.gap + 0.03;
  return { geometry: new THREE.TorusGeometry(radius, ring.tube, 48, 160).rotateX(Math.PI / 2), position: [0, y, 0], rotation: ring.tilt };
}

function placeTop(shape, top, bodyHeight) {
  const x = shape.topX;
  const parts = [];
  const sphereOn = (baseY) => {
    const r = top.sphere.radius;
    parts.push({ geometry: new THREE.SphereGeometry(r, 64, 48), position: [x, baseY + r * 0.45, 0], rotation: [0, 0, 0] });
  };
  if (top.kind === 'cone') {
    const { radius, height, tilt } = top.cone;
    parts.push({ geometry: coneGeometry(radius, height), position: [x, shape.upperAt(radius * 1.05) - 0.03, 0], rotation: [0, 0, tilt] });
  } else if (top.kind === 'sphere') {
    sphereOn(shape.upperAt(top.sphere.radius * 0.7));
  } else if (top.kind === 'cap' || top.kind === 'cap+sphere') {
    const radius = top.cap.frac * shape.radiusAt(0.8 * bodyHeight);
    const baseY = shape.upperAt(radius) - 0.02;
    // wide: a worn item sits on it (headOf)
    parts.push({ geometry: capGeometry(radius, top.cap.height), position: [x, baseY, 0], rotation: [0, 0, top.cap.tilt], wide: true });
    if (top.kind === 'cap+sphere') sphereOn(baseY + top.cap.height - top.sphere.radius * 0.25);
  } else if (top.kind === 'nub') {
    const { radius, length, tilt } = top.nub;
    const centerY = shape.upperAt(radius) + length / 2 + radius * 0.5;
    parts.push({ geometry: new THREE.CapsuleGeometry(radius, length, 12, 48), position: [x, centerY, 0], rotation: [0, 0, tilt] });
  }
  return parts;
}

const UPRIGHT = { squash: 1, pitch: 0, topPitch: 0, topDrop: 0 };

// A top piece nods with the posture (states.js): it turns forward about the
// body's middle, so it slides over the curved top rather than lifting off it,
// and sinks a little into the body.
function nod(part, shape, { topPitch, topDrop }) {
  if (!topPitch && !topDrop) return part;
  const pivot = new THREE.Vector3(shape.topX, 0.5 * shape.height, 0);
  const p = new THREE.Vector3(...part.position).sub(pivot).applyAxisAngle(new THREE.Vector3(1, 0, 0), topPitch).add(pivot);
  const [, , tilt] = part.rotation;
  return { ...part, position: [p.x, p.y - topDrop, p.z], rotation: [topPitch, 0, tilt] };
}

// Where a worn item sits (outfits.js), measured on the upright body before
// its scale, lean and posture. The head's surface is the body plus a wide top
// part (a half-dome cap, or a ball as wide as the head on a cone's tip): an
// item sits on that. A narrow top part (a cone, a small sphere, a nub) is the
// pet's own crest: an item lets it through or walks round it, and topAt /
// topPeak say where it is.
//   crown       the head surface's highest point on the top's axis
//   surfaceAt   the head surface's height at (x, z), seen from above (null off it)
//   normalAt    its normal there
//   cast        the first hit of a ray on the body or a wide top: { point, normal }
//   halfWidth   the head's half-width: the body at 70% of its height (across
//               the lying capsule)
//   face        the screen, with the rim's outer top and bottom edges
//   ring        the ring's centre circle at an azimuth (0 the front, -PI/2 the
//               pet's left) and its tube, or null
//   down        straight down in world space, in the item's frame, for a part
//               that hangs
//   aboveGround a point of the item's frame: its height above the ground in
//               world units, for a part that hangs below the body
function headOf(shape, face, tops, ringPart, down, aboveGround) {
  const x0 = shape.topX;
  const material = new THREE.MeshBasicMaterial();
  const meshOf = (geometry, position = [0, 0, 0], rotation = [0, 0, 0]) => {
    const m = new THREE.Mesh(geometry, material);
    m.position.set(...position);
    m.rotation.set(...rotation);
    m.updateMatrixWorld();
    return m;
  };
  // A sphere at least 3/4 as wide as the head (a cone's ball top) is the head.
  const halfWidth = shape.radiusAt ? shape.radiusAt(0.7 * shape.height) : shape.height / 2;
  const onHead = (p) => p.wide || (p.geometry.type === 'SphereGeometry' && p.geometry.parameters.radius >= 0.75 * halfWidth);
  const caps = tops.filter(onHead).map((p) => meshOf(p.geometry, p.position, p.rotation));
  const narrow = tops.filter((p) => !onHead(p)).map((p) => meshOf(p.geometry, p.position, p.rotation));
  const surfaceMeshes = [meshOf(shape.proxy), ...caps];
  const ray = new THREE.Raycaster();
  const hitOf = (objects, origin, dir) => {
    ray.set(origin, dir.clone().normalize());
    const h = ray.intersectObjects(objects)[0];
    return h ? { point: h.point.clone(), normal: h.face.normal.clone().transformDirection(h.object.matrixWorld) } : null;
  };

  // The body's upper surface, exact (the proxy is coarse). Off the axis by a
  // hair: the profiles' top pole sits at r = sin(PI) ≈ 1e-16, and upperAt(0)
  // walks past it to the bottom pole.
  const r = shape.height / 2;
  const halfLen = shape.halfX - r;
  const bodyTop = shape.radiusAt
    ? (px, pz) => {
        const q = Math.hypot(px, pz);
        return q <= shape.halfX ? shape.upperAt(Math.max(q, 1e-9)) : null;
      }
    : (px, pz) => {
        const dx = Math.max(0, Math.abs(px) - halfLen);
        const q = r * r - dx * dx - pz * pz;
        return q > 0 ? r + Math.sqrt(q) : null;
      };
  const DOWN = new THREE.Vector3(0, -1, 0);
  const surfaceAt = (px, pz) => {
    const b = bodyTop(px, pz);
    const c = caps.length ? (hitOf(caps, new THREE.Vector3(px, 20, pz), DOWN)?.point.y ?? null) : null;
    return b === null ? c : c === null ? b : Math.max(b, c);
  };
  const normalAt = (px, pz, e = 0.01) => {
    const h0 = surfaceAt(px, pz);
    const h = (a, b) => surfaceAt(a, b) ?? h0;
    return new THREE.Vector3(h(px - e, pz) - h(px + e, pz), 2 * e, h(px, pz - e) - h(px, pz + e)).normalize();
  };

  const topAt = (y) => {
    if (!narrow.length) return null;
    const reach = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dz]) => {
      const hit = hitOf(narrow, new THREE.Vector3(x0 + 10 * dx, y, 10 * dz), new THREE.Vector3(-dx, 0, -dz));
      return hit ? Math.hypot(hit.point.x - x0, hit.point.z) : null;
    });
    return reach.includes(null) ? null : Math.max(...reach);
  };
  const topPeak = narrow.length ? Math.max(...narrow.map((m) => new THREE.Box3().setFromObject(m, true).max.y)) : null;

  const ring = ringPart && {
    tube: ringPart.geometry.parameters.tube,
    radius: ringPart.geometry.parameters.radius,
    at: (psi) => {
      const R = ringPart.geometry.parameters.radius;
      return new THREE.Vector3(R * Math.sin(psi), 0, R * Math.cos(psi))
        .applyEuler(new THREE.Euler(...ringPart.rotation))
        .add(new THREE.Vector3(...ringPart.position));
    },
  };

  return {
    crown: [x0, surfaceAt(x0, 0)],
    surfaceAt,
    normalAt,
    cast: (origin, dir) => hitOf(surfaceMeshes, origin, dir),
    halfWidth,
    lying: !shape.radiusAt,
    girth: shape.radiusAt,
    face: { ...face, top: face.y + face.h / 2 + rimOutside(face), bottom: face.y - face.h / 2 - rimOutside(face) },
    faceTop: face.y + face.h / 2 + rimOutside(face),
    topAt,
    topPeak,
    ring,
    down,
    aboveGround,
  };
}

// faceAspect: the screen's width to height to keep (a baby or a teen keeps
// the grown-up's, see assemblePet); without it the body's own screen fits.
// outfit: an OUTFITS slug (outfits.js) or 'none'.
// tile: the item alone, for its wardrobe tile: in its tile pose where it has
// one (outfits.js › OUTFITS[slug].tile); worn, it is fitted as ever.
export function assemble(spec, { faceAspect, outfit = 'none', tile = false } = {}) {
  const shape = bodyShape(spec.body);
  const s = spec.scale;
  const face = faceAspect
    ? fitFace(shape.proxy, { ...shape.face, h: shape.face.w / faceAspect }, true)
    : fitFace(shape.proxy, shape.face);

  const posture = spec.posture ?? UPRIGHT;
  const parts = [];
  const ringPart = spec.ring ? placeRing(shape, spec.ring, face) : null;
  // role: what the part is to the pet in motion (animator.js): a stage's
  // part grows into the next stage's part of the same role and place.
  if (ringPart) parts.push({ ...ringPart, role: 'ring' });
  const tops = spec.top ? placeTop(shape, spec.top, shape.height) : [];
  parts.push(...tops.map((p) => ({ ...nod(p, shape, posture), role: 'top' })));
  if (spec.tail) {
    const { r, length } = spec.body;
    const rt = spec.tail.radius;
    parts.push({ geometry: new THREE.SphereGeometry(rt, 64, 48), position: [-(length / 2 + r) - rt * 0.25, r * 1.02, 0], rotation: [0, 0, 0], role: 'tail' });
  }

  // The core: low behind the belly, under the face, so its light shows
  // between the face and the feet on every body.
  // A small spot (the asleep ember, states.js) sits below the rim as well: on
  // a half-dome the core is level with the rim's lower edge, and the screen
  // would hide all of the spot but its fringe.
  const lowCore = shape.coreY ?? 0.8 * (face.y - face.h / 2 - 0.1);
  const coreY = spec.glow.belowFace ? Math.min(lowCore, face.y - face.h / 2 - rimOutside(face) - EMBER_CLEARANCE) : lowCore;
  const front = cast(shape.proxy, new THREE.Vector3(face.x, coreY, 10), new THREE.Vector3(0, 0, -1));
  const coreLocal = [face.x, coreY, Math.max(0.1, front.point.z - CORE_DEPTH)];

  // Lean, posture and size, then stand the body on its feet. The squash keeps
  // the volume: the body widens as it sinks.
  const spread = s / Math.sqrt(posture.squash);
  const bodyScale = [spread, s * posture.squash, spread];
  const lean = new THREE.Matrix4()
    .makeRotationZ(spec.tilt)
    .multiply(new THREE.Matrix4().makeRotationX(posture.pitch))
    .multiply(new THREE.Matrix4().makeScale(...bodyScale));
  const leaned = shape.proxy.clone().applyMatrix4(lean);
  const underside = (x, z) => cast(leaned, new THREE.Vector3(x, -10, z), UP)?.point.y ?? null;
  // The feet are the same size on every pet of a stage, whatever its own size,
  // and grow with the stage (generator.js › grow): under a baby the grown-up's
  // feet were stilts. Under a small body they move apart to keep a gap.
  const growth = spec.growth ?? 1;
  const footRadius = FOOT.radius * growth;
  const apart = (v) => Math.sign(v) * Math.max(Math.abs(v), footRadius + FEET_GAP);
  const centres = shape.feet.map(([x, z]) => [apart(x * s), apart(z * s)]);
  const lowest = Math.min(...centres.map(([x, z]) => underside(x, z)));
  const bodyY = VISIBLE_LEG * growth - lowest;

  // The item is fitted to the upright pet, then nods with the top pieces as
  // one rigid group (its geometry is in the body's frame, its origin the
  // body's). A hanging part hangs plumb: world down, carried back through the
  // lean, the posture, the squash and the nod into the item's frame.
  let item = null;
  if (outfit !== 'none') {
    const toWorld = lean.clone().multiply(new THREE.Matrix4().makeRotationX(posture.topPitch));
    const down = new THREE.Vector3(0, -1, 0).transformDirection(toWorld.invert());
    const placed = nod({ position: [0, 0, 0], rotation: [0, 0, 0] }, shape, posture);
    const itemToWorld = new THREE.Matrix4()
      .makeTranslation(0, bodyY, 0)
      .multiply(lean)
      .multiply(new THREE.Matrix4().compose(new THREE.Vector3(...placed.position), new THREE.Quaternion().setFromEuler(new THREE.Euler(...placed.rotation)), new THREE.Vector3(1, 1, 1)));
    const aboveGround = (p) => p.clone().applyMatrix4(itemToWorld).y;
    const fit = (tile && OUTFITS[outfit].tile) || OUTFITS[outfit].build;
    const meshes = fit(headOf(shape, face, tops, ringPart, down, aboveGround));
    item = nod({ meshes, position: [0, 0, 0], rotation: [0, 0, 0] }, shape, posture);
  }
  const feet = centres.map(([x, z]) => {
    // The foot's top must stay inside the body all round its edge.
    const rim = footRadius + 0.03;
    const samples = [[x, z], ...Array.from({ length: 8 }, (_, k) => [x + rim * Math.cos((k * Math.PI) / 4), z + rim * Math.sin((k * Math.PI) / 4)])];
    const top = bodyY + Math.max(...samples.map(([sx, sz]) => underside(sx, sz) ?? underside(x, z))) + 0.03;
    return { position: [x, top, z], angle: Math.atan2(x, z), geometry: footGeometry(footRadius, top) };
  });

  const bodyMatrix = new THREE.Matrix4().makeTranslation(0, bodyY, 0).multiply(lean);
  const core = new THREE.Vector3(...coreLocal).applyMatrix4(bodyMatrix);

  // Bounds in pet space, for framing and for the silhouette checks.
  const points = [];
  const collect = (geometry, matrix) => {
    const pos = geometry.attributes.position;
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) points.push(v.fromBufferAttribute(pos, i).applyMatrix4(matrix).clone());
  };
  collect(shape.proxy, bodyMatrix);
  for (const p of parts) {
    const m = new THREE.Matrix4().compose(new THREE.Vector3(...p.position), new THREE.Quaternion().setFromEuler(new THREE.Euler(...p.rotation)), new THREE.Vector3(1, 1, 1));
    collect(p.geometry, bodyMatrix.clone().multiply(m));
  }
  let itemFrame = null;
  if (item) {
    const m = new THREE.Matrix4().compose(new THREE.Vector3(...item.position), new THREE.Quaternion().setFromEuler(new THREE.Euler(...item.rotation)), new THREE.Vector3(1, 1, 1));
    const from = points.length;
    for (const { geometry } of item.meshes) collect(geometry, bodyMatrix.clone().multiply(m));
    // The item alone (a wardrobe tile): its middle, which PetCanvas moves onto
    // the turntable's axis, and a camera on it.
    const box = new THREE.Box3().setFromPoints(points.slice(from));
    const mid = box.getCenter(new THREE.Vector3());
    itemFrame = { centerY: mid.y, radius: box.getSize(new THREE.Vector3()).length() / 2, center: [mid.x, mid.y, mid.z] };
  }
  for (const f of feet) {
    for (const [dx, dz] of [[footRadius, 0], [-footRadius, 0], [0, footRadius], [0, -footRadius]]) {
      points.push(new THREE.Vector3(f.position[0] + dx, 0, f.position[2] + dz));
    }
  }
  const top = Math.max(...points.map((p) => p.y));
  const cylRadius = Math.max(...points.map((p) => Math.hypot(p.x, p.z)));
  const c = Math.cos(Math.PI / 4);
  const xs = points.map((p) => p.x * c + p.z * c);
  const width34 = Math.max(...xs) - Math.min(...xs);

  return {
    spec,
    face,
    // Euler order ZYX: the forward pitch first, then the sideways lean (as `lean`).
    body: { geometry: shape.geometry, position: [0, bodyY, 0], rotation: [posture.pitch, 0, spec.tilt, 'ZYX'], scale: bodyScale },
    screen: projectScreen(shape.proxy, face),
    rim: projectRim(shape.proxy, face),
    parts,
    outfit: item,
    wearing: outfit,
    itemFrame,
    coreLocal,
    glowRadius: spec.glow.radius * s,
    feet,
    pool: {
      geometry: new THREE.PlaneGeometry(6, 6),
      position: [core.x, 0.002, core.z],
      radius: [0.8 * s * shape.halfX, 0.6 * s * shape.halfZ],
    },
    bounds: { top, cylRadius, width34 },
  };
}

const cache = new Map();
export function assemblePet(seed, state = 'full', stage = 'adult', outfit = 'none', tile = false) {
  const key = `${seed}|${state}|${stage}|${outfit}|${tile}`;
  if (!cache.has(key)) {
    // A baby and a teen keep the grown-up's screen shape: the same face, with
    // its eyes the same number of pixels apart, at every stage.
    const grown = stage === 'adult' ? null : assemblePet(seed, state).face;
    cache.set(key, assemble(makePet(String(seed), { state, stage }), { faceAspect: grown && grown.w / grown.h, outfit, tile }));
  }
  return cache.get(key);
}

// One camera for a set of pets: they all stand on the same ground at the same
// scale, so their size differences read.
export function frameFor(assemblies) {
  const top = Math.max(...assemblies.map((a) => a.bounds.top));
  const halfWidth = Math.max(...assemblies.map((a) => a.bounds.cylRadius));
  return { centerY: top / 2, radius: Math.hypot(halfWidth, top / 2) };
}

// Silhouette classes the P2 set must cover, read at the three-quarter view.
export function silhouette(a) {
  const { top, width34 } = a.bounds;
  return {
    tall: top / width34 >= 1.25,
    wide: width34 / top >= 1.4,
    small: a.spec.scale <= 0.8,
    lyingOrTilted: a.spec.body.kind === 'lying-capsule' || a.spec.tilt !== 0,
  };
}
