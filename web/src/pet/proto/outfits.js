// The outfit items (add-wardrobe › Outfit catalogue rule): one is worn at a
// time, or none. An item is a small group of simple primitives in black and
// off-white vinyl (materials.js › makeItemVinyl), with a palette hue only as
// a small accent the thing itself has (the daisy's yellow heart). It is
// fitted to the pet wearing it from the pet's own geometry (assemble.js ›
// headOf), so one item fits every body, top and stage: it sits on the head's
// surface (the body, or a wide half-dome cap on it), lets a narrow top part
// through or walks round it, never covers the screen or its rim, never
// crosses the ring's line below the face and never reaches the ground pool.
// A hanging part hangs plumb in world space (head.down).
// Coordinates: the body's own frame, before its scale, lean and posture
// (assemble.js), so the item grows, leans, squashes and nods with the pet.
// Sizes are shares of the head's half-width W (head.halfWidth) or of the
// screen's width, with a floor in body units where a small head (a cone's
// tip) would make an item too small to read.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export const OUTFITS = {
  'daisy-crown': { name: 'Daisy crown', build: daisyCrown },
  'cozy-scarf': { name: 'Cozy scarf', build: cozyScarf, tile: cozyScarfTile },
  'thinking-cap': { name: 'Thinking cap', build: thinkingCap },
  'smart-glasses': { name: 'Smart glasses', build: smartGlasses },
  'bow-tie': { name: 'Bow tie', build: bowTie, tile: bowTieTile },
  headphones: { name: 'Headphones', build: headphones },
  'party-hat': { name: 'Party hat', build: partyHat },
};
export const OUTFIT_NAMES = ['none', ...Object.keys(OUTFITS)];
export const outfitName = (slug) => (slug === 'none' ? 'no outfit' : OUTFITS[slug].name);

const UP = new THREE.Vector3(0, 1, 0);
const v3 = (x, y, z) => new THREE.Vector3(x, y, z);

const lathe = (points, segments = 96) =>
  new THREE.LatheGeometry(
    points.map(([r, y]) => new THREE.Vector2(r, y)),
    segments,
    Math.PI,
  );

// The item's meshes merged per tone (fewer draw calls). A hanging part (`hang`:
// the point it hangs from, in the item's frame) splits its tone into runs, each
// a mesh of its own, so the pet in motion can hold it plumb (Pet.jsx). The runs
// keep the order the meshes were built in: same-tone seams are depth ties, and
// a tail drawn at another time than when merged changes the stills.
function byTone(meshes) {
  const tones = new Map(); // tone → its runs, { hang, list }
  for (const { geometry, tone, hang = null } of meshes) {
    const g = geometry.index ? geometry.toNonIndexed() : geometry;
    for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
    if (!tones.has(tone)) tones.set(tone, []);
    const runs = tones.get(tone);
    if (runs.at(-1)?.hang === hang) runs.at(-1).list.push(g);
    else runs.push({ hang, list: [g] });
  }
  return [...tones].flatMap(([tone, runs]) => runs.map(({ hang, list }) => ({ tone, geometry: mergeGeometries(list), ...(hang ? { hang } : null) })));
}

// A frame on a surface: z along the normal, x level (across), y up the surface.
function frameAt(point, normal) {
  const z = normal.clone().normalize();
  const x = new THREE.Vector3().crossVectors(UP, z);
  if (x.lengthSq() < 1e-6) x.set(1, 0, 0);
  x.normalize();
  const y = new THREE.Vector3().crossVectors(z, x);
  return new THREE.Matrix4().makeBasis(x, y, z).setPosition(point);
}

// Turns a geometry built along -y so that -y points along `dir`.
const hangAlong = (g, dir) => g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(v3(0, -1, 0), dir.clone().normalize()));

// A capsule of radius r from a to b.
function rod(a, b, r) {
  const d = new THREE.Vector3().subVectors(b, a);
  const g = new THREE.CapsuleGeometry(r, Math.max(1e-3, d.length()), 6, 20);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(UP, d.clone().normalize()));
  const mid = a.clone().add(b).multiplyScalar(0.5);
  return g.translate(mid.x, mid.y, mid.z);
}

// A tube of radius r through the points, with round ends unless closed.
function tube(points, r, tone, closed = false) {
  const curve = new THREE.CatmullRomCurve3(points, closed, 'centripetal');
  const out = [{ geometry: new THREE.TubeGeometry(curve, Math.max(24, points.length * 3), r, 14, closed), tone }];
  if (!closed) {
    for (const p of [points[0], points[points.length - 1]]) out.push({ geometry: new THREE.SphereGeometry(r, 14, 10).translate(p.x, p.y, p.z), tone });
  }
  return out;
}

// ---- Thinking cap: a mortarboard (P5 r1, accepted). A skullcap draped over
// the head's surface, a flat square board on it, and an off-white tassel on a
// cord from the board's middle, hanging off one corner. The flat board is the
// opposite of a nightcap's long soft cone, and the tassel is a straight cord
// with a flat-ended fringe, never a ball.
const CAP = {
  band: 0.76, // the skullcap's lower edge, this far out from the crown's axis
  shell: 0.07, // the skullcap's thickness over the head
  lip: 0.09, // its lower edge rounds over this width
  faceClear: 0.14, // and stays at least this far above the screen's rim
  board: 0.84, // half the board's side
  boardMin: 0.58, // body units: a cone's tip still gets a board that reads
  thick: 0.11,
  thickMin: 0.075,
  sink: 0.07, // the board sits this far down into the skullcap's dome
  show: 0.16, // a narrow top part shows at least this much above the board
  tilt: 0.13, // the board cants down to the pet's left (-x), radians
  button: 0.12, // the button's radius, when no top part comes through the board
  collar: 0.05, // the tube of the collar round a top part that comes through
  cord: 0.034,
  corner: [-1, -1], // the tassel's corner: the pet's back left, the outermost at three-quarter
  hang: 0.26, // the cord's drop from the corner to the tassel
  tassel: { top: 0.05, bottom: 0.095, length: 0.32 },
};

// A shell draped over the head's surface round the crown, out to `band` from
// the axis (nearer where the face's rim comes within `clear` below it), the
// thickness `shell` easing in over `lip` at the edge, which tucks into the
// body. A height field seen from above, so it fits a dome, a cap on a dome
// and a lying capsule's ridge alike.
function drape(head, band, shell, lip, clear, rings = 18, segs = 72) {
  const [cx] = head.crown;
  const limit = head.faceTop + clear;
  const edge = [];
  for (let j = 0; j < segs; j++) {
    const phi = (2 * Math.PI * j) / segs;
    const hAt = (q) => head.surfaceAt(cx + q * Math.cos(phi), q * Math.sin(phi)) ?? -1;
    let q = band;
    while (q > 0.3 * band && hAt(q) < limit) q *= 0.97;
    edge.push(q);
  }
  const pos = [];
  const vert = (px, pz, t) => {
    const y = head.surfaceAt(px, pz);
    const n = head.normalAt(px, pz);
    pos.push(px + n.x * t, y + n.y * t, pz + n.z * t);
  };
  vert(cx, 0, shell);
  for (let i = 1; i <= rings + 1; i++) {
    for (let j = 0; j < segs; j++) {
      const phi = (2 * Math.PI * j) / segs;
      const e = edge[j];
      const skirt = i === rings + 1; // tucked under the surface, so the edge meets the body
      const q = skirt ? 0.97 * e : (e * i) / rings;
      const into = (q - (e - lip)) / lip;
      const t = skirt ? -0.03 : into > 0 ? shell * Math.sqrt(Math.max(0, 1 - into * into)) : shell;
      vert(cx + q * Math.cos(phi), q * Math.sin(phi), t);
    }
  }
  const index = [];
  for (let j = 0; j < segs; j++) index.push(0, 1 + ((j + 1) % segs), 1 + j);
  for (let i = 1; i <= rings; i++) {
    for (let j = 0; j < segs; j++) {
      const a = 1 + (i - 1) * segs + j;
      const b = 1 + (i - 1) * segs + ((j + 1) % segs);
      index.push(a, b, b + segs, a, b + segs, a + segs);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(index);
  g.computeVertexNormals();
  if (g.attributes.normal.getY(0) < 0) {
    for (let i = 0; i < index.length; i += 3) [index[i + 1], index[i + 2]] = [index[i + 2], index[i + 1]];
    g.setIndex(index);
    g.computeVertexNormals();
  }
  return g;
}

// A tassel: a short band where the cord is tied, then a fringe that widens a
// little to a flat, rounded-off end. Its top at y = 0, hanging along -y.
function tasselGeometry({ top, bottom, length }) {
  const e = 0.35 * bottom;
  const pts = [[0, -length]];
  for (let i = 0; i <= 6; i++) {
    const a = (i / 6) * (Math.PI / 2);
    pts.push([bottom - e + e * Math.sin(a), -length + e - e * Math.cos(a)]);
  }
  pts.push([top, -0.28 * length], [top * 1.3, -0.24 * length], [top * 1.3, -0.1 * length], [top, -0.06 * length], [top * 0.6, 0], [0, 0]);
  return lathe(pts, 48);
}

function thinkingCap(head) {
  const W = head.halfWidth;
  const k = (v) => v * W;
  const [cx, crownY] = head.crown;
  const shell = k(CAP.shell);
  const skullcap = drape(head, k(CAP.band), shell, k(CAP.lip), k(CAP.faceClear));

  // The board, in its own frame (y = 0 its middle), then canted and placed.
  const B = Math.max(k(CAP.board), CAP.boardMin);
  const T = Math.max(k(CAP.thick), CAP.thickMin);
  const round = 0.5 * T; // a full roundover: the edges catch the studio light
  // A short top part (a teen's bud) keeps `show` above the board: the board
  // sinks into the skullcap's dome for it, as far as the dome stays under it.
  let sink = k(CAP.sink);
  if (head.topPeak !== null) {
    const short = k(CAP.show) - (head.topPeak - (crownY + shell - sink + T));
    if (short > 0) sink = Math.min(sink + short, T - 0.01);
  }
  const boardY = crownY + shell - sink + T / 2;
  const place = new THREE.Matrix4().makeTranslation(cx, boardY, 0).multiply(new THREE.Matrix4().makeRotationZ(CAP.tilt));
  const board = new RoundedBoxGeometry(2 * B, T, 2 * B, 6, round).applyMatrix4(place);

  // The button the cord starts from: a collar round the pet's top part where
  // it comes up through the board (the top is the pet's own and stays in
  // sight), else a flat button in the board's middle.
  const cord = k(CAP.cord);
  const through = head.topAt(boardY + T / 2);
  const collarTube = k(CAP.collar);
  const button = through
    ? new THREE.TorusGeometry(through + 0.5 * collarTube, collarTube, 16, 72).rotateX(Math.PI / 2).translate(0, T / 2 + 0.4 * collarTube, 0)
    : new THREE.CylinderGeometry(k(CAP.button), k(CAP.button), k(0.06), 40).translate(0, T / 2 + k(0.03), 0);
  button.applyMatrix4(place);

  // The cord runs over the board's top to the corner's rounded tip, then
  // hangs plumb from just outside it.
  const [sx, sz] = CAP.corner;
  const diag = v3(sx, 0, sz).normalize();
  const tip = Math.SQRT2 * (B - round) + round; // the rounded corner's reach along the diagonal
  const start = (through ? through + collarTube : k(CAP.button)) * 0.9;
  const onTop = (d, lift = 0) => diag.clone().multiplyScalar(d).setY(T / 2 + lift).applyMatrix4(place);
  const runFrom = onTop(start, 0.5 * cord);
  const runTo = onTop(tip - 0.5 * cord, 0.3 * cord);
  const edge = onTop(tip + 0.8 * cord, -0.5 * T);
  const hangTo = edge.clone().addScaledVector(head.down, k(CAP.hang));
  const tassel = hangAlong(tasselGeometry({ top: k(CAP.tassel.top), bottom: k(CAP.tassel.bottom), length: k(CAP.tassel.length) }), head.down).translate(
    hangTo.x,
    hangTo.y,
    hangTo.z,
  );

  return byTone([
    { geometry: skullcap, tone: 'black' },
    { geometry: board, tone: 'black' },
    { geometry: button, tone: 'offWhite' },
    { geometry: rod(runFrom, runTo, cord), tone: 'offWhite' },
    { geometry: rod(runTo, edge, cord), tone: 'offWhite' },
    { geometry: rod(edge, hangTo, cord), tone: 'offWhite', hang: edge },
    { geometry: tassel, tone: 'offWhite', hang: edge },
  ]);
}

// ---- Daisy crown: a ring of daisies round the crown, touching, each facing
// out and a little up: off-white petals round a yellow heart (the daisy's own
// hue, the only palette hue on any item). The flowers are the read; no band.
const DAISY = {
  ring: 0.72, // the ring's radius about the crown's axis
  ringMin: 0.44, // body units
  size: 0.22, // a daisy's radius
  sizeMin: 0.15,
  spacing: 1.75, // daisy centres this many radii apart round the ring
  petals: 11,
  faceClear: 0.08,
};

function daisyGeometry(size) {
  const petals = [];
  for (let i = 0; i < DAISY.petals; i++) {
    const a = (2 * Math.PI * i) / DAISY.petals;
    // A petal: a flattened ellipsoid from the heart out to the rim, cupped a little forward.
    const g = new THREE.SphereGeometry(1, 14, 8).scale(0.42 * size, 0.15 * size, 0.07 * size);
    g.translate(0.56 * size, 0, 0).rotateY(-0.18).rotateZ(a);
    petals.push(g);
  }
  const heart = new THREE.SphereGeometry(0.3 * size, 24, 14).scale(1, 1, 0.55).translate(0, 0, 0.07 * size);
  return { petals: mergeGeometries(petals), heart };
}

function daisyCrown(head) {
  const W = head.halfWidth;
  const [cx] = head.crown;
  const size = Math.max(DAISY.size * W, DAISY.sizeMin);
  let rho = Math.max(DAISY.ring * W, DAISY.ringMin);
  // Along a lying capsule's ridge the ring stretches out (the head is long
  // that way); toward the face it closes in like any other.
  const stretch = head.lying ? 1.7 : 1;
  let placed = [];
  for (let attempt = 0; attempt < 40; attempt++) {
    const [ax, az] = [Math.max(rho, Math.min(stretch * DAISY.ring * W, stretch * rho * 1.6)), rho];
    const around = Math.PI * (3 * (ax + az) - Math.sqrt((3 * ax + az) * (ax + 3 * az))); // the ellipse's perimeter
    const n = Math.max(6, Math.round(around / (DAISY.spacing * size)));
    placed = [];
    let low = Infinity;
    for (let i = 0; i < n; i++) {
      const phi = Math.PI / 2 + (2 * Math.PI * i) / n; // one daisy at the front
      const px = cx + ax * Math.cos(phi);
      const pz = az * Math.sin(phi);
      const y = head.surfaceAt(px, pz);
      if (y === null) {
        low = -Infinity;
        break;
      }
      const normal = head.normalAt(px, pz);
      const facing = normal.clone().multiplyScalar(0.5).add(v3(Math.cos(phi), 0, Math.sin(phi)).multiplyScalar(0.7)).add(v3(0, 0.15, 0)).normalize();
      const centre = v3(px, y, pz).addScaledVector(normal, 0.25 * size);
      low = Math.min(low, centre.y - size * Math.sqrt(1 - facing.y ** 2));
      placed.push({ centre, facing });
    }
    if (low >= head.faceTop + DAISY.faceClear * W) break;
    rho *= 0.96; // up toward the crown, clear of the face
  }
  const { petals, heart } = daisyGeometry(size);
  const meshes = [];
  for (const { centre, facing } of placed) {
    const m = frameAt(centre, facing);
    meshes.push({ geometry: petals.clone().applyMatrix4(m), tone: 'offWhite' }, { geometry: heart.clone().applyMatrix4(m), tone: 'yellow' });
  }
  return byTone(meshes);
}

// ---- Smart glasses: thick black rectangular frames pushed up above the
// screen (the pet's eyes are its screen, so the glasses perch above it, never
// over it): a rigid frame whose lower edge rests just above the rim, leaning
// back with the forehead but never more than `lean`, so it still faces the
// viewer on a low, curving forehead (a lying capsule, a half-dome). It
// curves round the head across, and its arms run back along the head.
// Sizes are shares of the screen's width.
const GLASSES = {
  a: 0.185, // a lens's half-width
  b: 0.125, // its half-height
  corner: 0.55, // the lens corner radius, share of b
  gap: 0.085, // between the lenses
  tube: 0.04, // the frame's radius
  lift: 0.03, // the frame's lower edge above the rim
  stand: 0.03, // off the surface
  lean: 0.6, // radians, at most
  span: 0.55, // radians: the frame's half-width round the head, at most
  arm: 1, // the arms' length round the head, share of a lens's width
  min: 0.3, // the outline fit (below) shrinks the frame to no less than this share of its full size
};

function smartGlasses(head) {
  const F = head.face;
  const w = F.w;
  const axis = head.lying ? F.x : head.crown[0];
  // The frame spans at most `span` radians round the head where it sits, so
  // the far lens never stands out past the head's edge (the critic's m7). A
  // half-dome ends below that height (its screen sits high on the dome), so
  // there the room is taken at the rim's top, where the dome still has width.
  const ySit = F.top + (GLASSES.lift + GLASSES.tube + GLASSES.b) * w;
  const room = head.lying ? Infinity : GLASSES.span * (head.girth(ySit) || head.girth(F.top));
  let k = Math.min(1, room / ((GLASSES.gap / 2 + 2 * GLASSES.a + GLASSES.tube) * w));
  // The frame at size k: its lenses and bridge as centre lines.
  const frameAtSize = (k) => {
    const [a, b, gap, r] = [GLASSES.a * w * k, GLASSES.b * w * k, GLASSES.gap * w * k, GLASSES.tube * w * k];
    const off = GLASSES.stand * w + r;

    // The frame's lower edge: on the forehead just above the rim.
    const yb = F.top + GLASSES.lift * w + r;
    const base = head.cast(v3(F.x, yb, 10), v3(0, 0, -1));
    const lean = Math.min(GLASSES.lean, Math.max(0, Math.asin(Math.min(1, base.normal.y))));
    const up = v3(0, Math.cos(lean), -Math.sin(lean));
    const out = v3(0, Math.sin(lean), Math.cos(lean));
    const origin = base.point.clone().addScaledVector(out, off);
    // Across, the frame bends round a vertical axis through the head (a lying
    // capsule is straight across its front).
    const bend = head.lying ? Infinity : Math.hypot(origin.x - axis, origin.z);
    const at = (u, v) => {
      const t = u / bend;
      const p = Number.isFinite(bend) ? v3(origin.x + bend * Math.sin(t) - u, 0, bend * (Math.cos(t) - 1)) : v3(0, 0, 0);
      return p.add(origin).add(v3(u, 0, 0)).addScaledVector(up, v);
    };
    const rc = GLASSES.corner * b;
    const lens = (uc) => {
      const pts = [];
      const corners = [
        [a - rc, b - rc, 0],
        [-(a - rc), b - rc, Math.PI / 2],
        [-(a - rc), -(b - rc), Math.PI],
        [a - rc, -(b - rc), (3 * Math.PI) / 2],
      ];
      for (const [x, y, a0] of corners) {
        for (let i = 0; i <= 8; i++) {
          const t = a0 + (i / 8) * (Math.PI / 2);
          pts.push(at(uc + x + rc * Math.cos(t), b + y + rc * Math.sin(t)));
        }
      }
      return pts;
    };
    const lenses = [lens(-(gap / 2 + a)), lens(gap / 2 + a)];
    const bridge = [-1, -0.5, 0, 0.5, 1].map((s) => at((s * (gap + r)) / 2, 1.35 * b + 0.22 * b * (1 - s * s)));
    return { a, b, gap, r, at, lenses, bridge };
  };
  // Seen at three-quarter, the lenses and the bridge stay inside the head's
  // outline (P5 r3: on the capsule's narrowing forehead the far lens stood
  // out past it, and the frame read as floating beside the head). A point
  // at angle psi from the front, d from the head's axis, lies d·sin(PI/4 +
  // |psi|) from the axis on the picture, and the outline at its height is
  // the head's own half-width there: the frame shrinks until every point
  // of its tube is inside, with a tube's radius to spare for the
  // perspective. The arms rest on the head (below), so the far one runs on
  // behind it.
  const outside = ({ r, lenses, bridge }) =>
    !head.lying &&
    [...lenses.flat(), ...bridge].some((p) => {
      const [dx, dz] = [p.x - axis, p.z];
      return (Math.hypot(dx, dz) + r) * Math.sin(Math.PI / 4 + Math.abs(Math.atan2(dx, dz))) > head.girth(p.y) - r;
    });
  let frame = frameAtSize(k);
  while (k > GLASSES.min && outside(frame)) frame = frameAtSize((k *= 0.97));
  const { a, b, gap, r, at, lenses, bridge } = frame;
  const meshes = [...tube(lenses[0], r, 'black', true), ...tube(lenses[1], r, 'black', true), ...tube(bridge, 0.8 * r, 'black')];
  // The arms: short, from each lens's outer edge back round the head at that
  // height, resting on it (standing off like the frame, the far one stuck out
  // past the head's outline at three-quarter) and sinking into it right
  // behind the frame, as on glasses pushed up (P5 r5: a long arm read as a
  // stick across the forehead).
  const armLength = GLASSES.arm * 2 * a;
  for (const side of [-1, 1]) {
    const start = at(side * (gap / 2 + 2 * a), 1.4 * b);
    const pts = [start];
    let psi = Math.atan2(start.x - axis, start.z);
    let length = 0;
    while (length < armLength && Math.abs(psi) < 2.2) {
      psi += side * 0.03;
      const hit = head.cast(v3(axis + 10 * Math.sin(psi), start.y, 10 * Math.cos(psi)), v3(-Math.sin(psi), 0, -Math.cos(psi)));
      if (!hit) break;
      // From resting on the surface to just under it at the arm's end.
      const along = Math.min(1, (length + hit.point.distanceTo(pts[pts.length - 1])) / armLength);
      const p = hit.point.addScaledVector(hit.normal, 0.85 * r * (1 - 2.2 * along));
      length += p.distanceTo(pts[pts.length - 1]);
      pts.push(p);
    }
    // On a half-dome the frame's corner stands off the steep dome by about an
    // arm's length, so the arm is a single step from it into the head.
    if (pts.length > 1) meshes.push(...tube(pts, 0.85 * r, 'black'));
  }
  return byTone(meshes);
}

// The neck: just under the ring's front if there is a ring (the ring is the
// pet's neckline), else just under the rim's lower edge.
const neckY = (head) => (head.ring ? head.ring.at(0).y - head.ring.tube : head.face.bottom);

// ---- Bow tie: a bow at the front centre of the neck, two flared black
// wings and an off-white knot. The wings bend round the body, so at
// three-quarter both stay on the lit body (straight, the far wing stood out
// past the body's edge and was lost on the black page), where black reads in
// grey too and the knot marks the middle.
// Shares of the screen's width; lift in radians; tuck a share of the ring's
// tube; clear in world units (a third of a grown-up's legs).
const BOW = { half: 0.42, height: 0.17, knot: 0.09, depth: 0.1, gap: 0.015, lift: 0.5, reach: 0.7, tuck: 0.3, clear: 0.1, min: 0.55 };

// The bow at k of its full size: two wings and the knot, placed by `place`
// (its middle, facing +z), the wings bent round a body or a ring of radius
// `round` (0: straight).
function bowMeshes(w, k, place, round) {
  const [hw, hh, kw, depth] = [BOW.half * w * k, BOW.height * w * k, BOW.knot * w * k, BOW.depth * w * k];
  // A wing along +y: narrow at the knot, flaring to a rounded end; flattened front to back.
  const L = hw - kw / 2;
  const wingPts = [
    [0, 0],
    [0.42 * hh, 0],
    [0.55 * hh, 0.25 * L],
    [0.88 * hh, 0.7 * L],
    [hh, 0.86 * L],
    [0.8 * hh, 0.97 * L],
    [0, L],
  ];
  // Round the body: each wing turns back by the angle its middle spans on it.
  const curve = round ? (kw / 2.4 + L / 2) / round : 0;
  const wing = (side) =>
    lathe(wingPts, 48)
      .scale(1, 1, (0.5 * depth) / hh)
      .rotateZ((-side * Math.PI) / 2)
      .rotateZ(side * -0.1)
      .translate((side * kw) / 2.4, 0, 0)
      .rotateY(side * curve)
      .applyMatrix4(place);
  const knot = new RoundedBoxGeometry(kw, 0.95 * hh, depth * 1.05, 4, 0.4 * kw).translate(0, 0, 0.1 * depth).applyMatrix4(place);
  return [
    { geometry: wing(-1), tone: 'black' },
    { geometry: wing(1), tone: 'black' },
    { geometry: knot, tone: 'offWhite' },
  ];
}

function bowTie(head) {
  const F = head.face;
  const w = F.w;
  // Under a low face or a low ring (a half-dome; the capsule's screen sits
  // at the middle of its front) the bow shrinks to the room above the feet,
  // down to 55%; with no room at all on the body under a ring it hangs from
  // the ring (hangFromRing).
  const top = neckY(head) - BOW.gap * w;
  // The floor: the lowest point of the front that still faces forward (below
  // it a capsule's belly turns to the feet).
  let floor = 0.04;
  while (floor < top && (head.cast(v3(F.x, floor, 10), v3(0, 0, -1))?.normal.y ?? -1) < -0.7) floor += 0.02;
  const fit = (top - floor) / (2 * BOW.height * w);
  if (head.ring && fit < 0.45) return hangFromRing(head, w);
  // A ring that runs over the rim's lower edge (no room between the screen
  // and the ring: the capsule's near-square screen) stands far out over the
  // bow, and the belly under it turns down to the feet: upright and shrunk
  // to the room above the floor, the bow hid its top under the ring and
  // showed a dark sliver over a foot (P5 r3). There it tilts up by `lift`
  // about its middle, its top edge tucked into the body, so it faces out
  // from under the ring and its wings catch the light from above, which
  // reads over the black feet too. Tilted, its lower edge swings out past
  // the floor, so it needs only `reach` of its upright height above it:
  // full size wherever the room holds that.
  const tilted = head.ring && head.ring.at(0).y + head.ring.tube > F.bottom;
  const k = tilted ? Math.min(1, fit / BOW.reach) : Math.min(1, Math.max(0.55, fit));
  const [hh, depth] = [BOW.height * w * k, BOW.depth * w * k];
  const y = top - hh * (tilted ? Math.cos(BOW.lift) : 1);
  // Upright, facing forward, touching the body along its top edge: under a
  // low ring the body faces down, and a bow lying on it was seen edge-on.
  const hit = head.cast(v3(F.x, y + 0.6 * hh, 10), v3(0, 0, -1));
  const ahead = hit && hit.normal.clone().setY(0).normalize();
  const place = hit
    ? frameAt(v3(hit.point.x, y, hit.point.z).addScaledVector(ahead, 0.45 * depth), ahead)
    : frameAt(head.ring.at(0).add(v3(0, 0, head.ring.tube + 0.3 * depth)), v3(0, 0, 1));
  if (tilted) place.multiply(new THREE.Matrix4().makeRotationX(-BOW.lift));
  return byTone(bowMeshes(w, k, place, hit && !head.lying ? head.girth(y + 0.6 * hh) : 0));
}

// The bow alone, for its wardrobe tile (assemble.js › tile): straight,
// facing front, both wings level and the knot in the middle. Worn under seed
// 9's ring it tilts up and bends round the body; shot alone in that pose at
// three-quarter it read as a funnel. Tilted up by `lift`, more than worn, so
// the black wings face the soft box above and come out lighter than a dark
// tile (upright, they read as a hole in it); PetCanvas.jsx › Studio lights
// their lower edges.
const BOW_TILE = { lift: 0.8 };

function bowTieTile(head) {
  const place = frameAt(v3(0, head.face.y, 0), v3(0, 0, 1)).multiply(new THREE.Matrix4().makeRotationX(-BOW_TILE.lift));
  return byTone(bowMeshes(head.face.w, 1, place, 0));
}

// With no room on the body under a ring (P5 r7: a half-dome's ring runs round
// its bottom rim, a cone's round its bottom, a sphere's sits low; tied on the
// ring's front, the bow covered the ring's line) the bow hangs from the
// ring's front instead, the same way as under a ring over the rim: tilted up
// by `lift`, its top edge tucked up into the ring's tube by `tuck` of it, its
// wings bent round the ring, so it faces out from under the ring, in front of
// the body and the feet. Its lower edge hangs past the body's underside: full
// size, shrunk until its lowest point stays `clear` above the ground (off the
// pool), down to `min`.
function hangFromRing(head, w) {
  const front = head.ring.at(0);
  const neck = front.y - (1 - BOW.tuck) * head.ring.tube;
  const at = (k) => {
    const hh = BOW.height * w * k;
    const place = frameAt(v3(front.x, neck - hh * Math.cos(BOW.lift), front.z + hh * Math.sin(BOW.lift)), v3(0, 0, 1));
    return bowMeshes(w, k, place.multiply(new THREE.Matrix4().makeRotationX(-BOW.lift)), head.ring.radius);
  };
  const lowest = (meshes) => {
    const v = new THREE.Vector3();
    let low = Infinity;
    for (const { geometry } of meshes) {
      const pos = geometry.attributes.position;
      for (let i = 0; i < pos.count; i++) low = Math.min(low, head.aboveGround(v.fromBufferAttribute(pos, i)));
    }
    return low;
  };
  let k = 1;
  let meshes = at(k);
  while (k > BOW.min && lowest(meshes) < BOW.clear) meshes = at((k = Math.max(BOW.min, k * 0.97)));
  return byTone(meshes);
}

// ---- Cozy scarf: a thick off-white band round the neck, knotted at the
// pet's left with two tails hanging plumb, each with two black stripes and a
// fringe. On a ringed pet the ring is the neckline, it passes right under the
// screen at the front and the core light glows under it there: the band
// tucks behind the ring only under the screen, and everywhere else, the
// front quarter the camera sees at three-quarter included, it rides on top
// of the ring (the ring's line stays whole under it, the light stays clear).
// The tails hang down behind the ring, through its gap, where the gap is
// wide enough; else they stop above it. Without a ring the band runs just
// under the rim.
const SCARF = {
  height: 0.3, // the band's height, share of W
  thick: 0.12,
  knot: 0.15,
  tail: { width: 0.26, thick: 0.07, lengths: [0.78, 0.62] },
  knotPast: 0.45, // the knot sits this far round past the screen's side edge, radians
  gap: 0.012, // from the ring and the rim
};

const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const fromFront = (psi) => Math.abs(Math.atan2(Math.sin(psi), Math.cos(psi)));

// A band round the vertical axis: at azimuth psi it spans heights span(psi)
// = [bottom, top] and is thick(psi) thick, its inner side on the body
// (girth), its edges rounded (a superellipse section); clamp(psi, y, r)
// may pull a point in (out of the ring).
function bandGeometry(girth, span, thick, clamp = (psi, y, r) => r, segs = 160, rows = 16) {
  const pos = [];
  // Each section runs up the outside, then back down an inner wall just
  // inside the body, so the band is a closed ring (it shows whole alone).
  const per = 2 * rows;
  for (let j = 0; j < segs; j++) {
    const psi = (2 * Math.PI * j) / segs;
    const [s, c] = [Math.sin(psi), Math.cos(psi)];
    const [lo, hi] = span(psi);
    for (let i = 0; i < per; i++) {
      const inner = i >= rows;
      const v = inner ? 1 - (2 * (i - rows)) / (rows - 1) : -1 + (2 * i) / (rows - 1);
      const y = (lo + hi) / 2 + (v * (hi - lo)) / 2;
      const o = inner ? -0.02 : thick(psi) * Math.pow(Math.max(0, 1 - Math.abs(v) ** 2.6), 1 / 2.6);
      const rr = inner ? girth(y) - 0.02 : Math.max(girth(y) - 0.02, clamp(psi, y, girth(y) + o));
      pos.push(rr * s, y, rr * c);
    }
  }
  const index = [];
  for (let j = 0; j < segs; j++) {
    for (let i = 0; i < per; i++) {
      const a = j * per + i;
      const b = ((j + 1) % segs) * per + i;
      const [a1, b1] = [j * per + ((i + 1) % per), ((j + 1) % segs) * per + ((i + 1) % per)];
      index.push(a, b, a1, b, b1, a1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(index);
  g.computeVertexNormals();
  return g;
}

function scarfTail(W, length, out, down) {
  const { width, thick } = SCARF.tail;
  const [tw, tt] = [width * W, thick * W];
  const parts = [{ geometry: new RoundedBoxGeometry(tw, length, tt, 3, 0.45 * tt).translate(0, -length / 2, 0), tone: 'offWhite' }];
  for (const at of [0.2, 0.36]) {
    parts.push({ geometry: new RoundedBoxGeometry(tw * 1.03, 0.08 * W, tt * 1.12, 2, 0.4 * tt).translate(0, -length + at * W, 0), tone: 'black' });
  }
  for (let i = 0; i < 4; i++) {
    const x = (-0.5 + (i + 0.5) / 4) * tw * 0.85;
    parts.push({ geometry: new THREE.CapsuleGeometry(0.02 * W, 0.07 * W, 4, 8).translate(x, -length - 0.045 * W, 0), tone: 'offWhite' });
  }
  // Built hanging along -y with its face along +z: turn it to hang along
  // `down`, its face toward `out`.
  const z = out.clone().addScaledVector(down, -out.dot(down)).normalize();
  const y = down.clone().negate();
  const x = new THREE.Vector3().crossVectors(y, z);
  const m = new THREE.Matrix4().makeBasis(x, y, z);
  return parts.map((p) => ({ ...p, geometry: p.geometry.applyMatrix4(m) }));
}

function cozyScarf(head) {
  const W = head.halfWidth;
  const meshes = [];
  const kr = SCARF.knot * W;
  // A lying capsule: a band round its long axis, just behind the face.
  if (head.lying) {
    const r = head.crown[1] / 2;
    const height = SCARF.height * W;
    const x = head.face.x - head.face.w / 2 - 0.1 - height / 2;
    const band = bandGeometry(() => r, () => [-height / 2, height / 2], () => SCARF.thick * W)
      .rotateZ(-Math.PI / 2)
      .translate(x, r, 0);
    meshes.push({ geometry: band, tone: 'offWhite' });
    const knot = v3(x, r, 0).add(v3(0, -0.55, 0.84).normalize().multiplyScalar(r + SCARF.thick * W));
    meshes.push({ geometry: new THREE.SphereGeometry(kr, 24, 16).scale(1, 0.8, 0.7).translate(knot.x, knot.y, knot.z), tone: 'offWhite' });
    for (const [i, len] of SCARF.tail.lengths.entries()) {
      const tail = scarfTail(W, Math.min(len * W, knot.y - 0.12), v3(0, 0, 1), head.down);
      const hang = v3(knot.x + (i - 0.5) * 0.09 * W, knot.y, knot.z + i * 0.05 * W);
      for (const t of tail) meshes.push({ ...t, geometry: t.geometry.translate(hang.x, hang.y, hang.z), hang });
    }
    return byTone(meshes);
  }

  const F = head.face;
  const girth = (y) => head.girth(Math.max(0.02, y));
  const faceEdge = Math.asin(Math.min(1, (F.w / 2 + (F.top - F.y - F.h / 2)) / girth(F.y)));
  const psiK = -Math.max(1.1, faceEdge + SCARF.knotPast);
  const Hs = SCARF.height * W;
  const ring = head.ring;
  let span;
  let clamp;
  if (ring) {
    const g = SCARF.gap;
    span = (psi) => {
      const p = ring.at(psi);
      const behind = [p.y - ring.tube + g, Math.min(p.y + ring.tube, F.bottom) - g];
      const over = [p.y + ring.tube + g, p.y + ring.tube + g + Hs];
      const t = smooth(faceEdge + 0.05, faceEdge + 0.45, fromFront(psi)); // up only past the screen's side edge
      return [behind[0] + (over[0] - behind[0]) * t, behind[1] + (over[1] - behind[1]) * t];
    };
    // Never into the ring's tube.
    clamp = (psi, y, rr) => {
      const p = ring.at(psi);
      const m = ring.tube + g;
      const dy = y - p.y;
      return Math.abs(dy) < m ? Math.min(rr, Math.hypot(p.x, p.z) - Math.sqrt(m * m - dy * dy)) : rr;
    };
  } else {
    const top = F.bottom - SCARF.gap;
    span = () => [top - Hs, top];
  }
  meshes.push({ geometry: bandGeometry(girth, span, () => SCARF.thick * W, clamp), tone: 'offWhite' });

  const out = v3(Math.sin(psiK), 0, Math.cos(psiK));
  const [lo, hi] = span(psiK);
  const ky = (lo + hi) / 2;
  const knot = out.clone().multiplyScalar(girth(ky) + SCARF.thick * W * 0.8).setY(ky);
  meshes.push({ geometry: new THREE.SphereGeometry(kr, 28, 18).scale(1, 0.85, 0.7).applyMatrix4(frameAt(knot, out)), tone: 'offWhite' });

  // The tails hang plumb from the knot; where the body swells below (a cone),
  // they swing out just enough to clear it.
  const tangent = new THREE.Vector3().crossVectors(UP, out).normalize();
  // On a ring the tails hang flush with the body, so they pass behind the
  // ring through its gap; where the gap is too narrow they stop above it.
  const tt = SCARF.tail.thick * W;
  const throughGap = ring && Math.hypot(ring.at(psiK).x, ring.at(psiK).z) - ring.tube - girth(ring.at(psiK).y) > tt + 0.025;
  const floor = ring && !throughGap ? ring.at(psiK).y + ring.tube + 0.04 : 0.15;
  for (const [i, len] of SCARF.tail.lengths.entries()) {
    const length = Math.min(len * W, knot.y - floor - 0.4 * kr);
    if (length < 0.06) continue;
    const lift = ring ? 0.55 * tt + 0.01 : (i + 0.2) * 0.07 * W; // on a ring side by side, flush, to fit its gap
    const start = knot.clone().addScaledVector(tangent, (i - 0.5) * 0.16 * W).addScaledVector(head.down, 0.4 * kr);
    if (ring) start.copy(out.clone().multiplyScalar(girth(start.y) + lift).setY(start.y).addScaledVector(tangent, (i - 0.5) * 0.16 * W));
    else start.addScaledVector(out, lift);
    const dir = head.down.clone();
    for (let s = 0; s < 20; s++) {
      const end = start.clone().addScaledVector(dir, length);
      const inner = end.clone().addScaledVector(out, -0.5 * SCARF.tail.thick * W);
      if (Math.hypot(inner.x, inner.z) > girth(inner.y) + 0.01) break;
      dir.applyAxisAngle(tangent, -0.06).normalize();
    }
    dir.applyAxisAngle(out, (i - 0.5) * 0.18).normalize(); // the two tails splay a little
    const tail = scarfTail(W, length, out, dir);
    for (const t of tail) meshes.push({ ...t, geometry: t.geometry.translate(start.x, start.y, start.z), hang: start });
  }
  return byTone(meshes);
}

// The scarf alone, for its wardrobe tile (assemble.js › tile): the band
// round a neck that is not there, dipping at the front to the knot as a scarf
// hangs, and both tails hanging in front of it. Worn, the band follows the
// pet's ring and the knot sits at its side; shot alone in that pose it read as
// a visor. Sizes as worn; the neck's radius and the dip are shares of W.
const SCARF_TILE = { girth: 0.9, dip: 0.5 };

function cozyScarfTile(head) {
  const W = head.halfWidth;
  const R = SCARF_TILE.girth * W;
  const Hs = SCARF.height * W;
  const mid = (psi) => (SCARF_TILE.dip * W * (1 - Math.cos(psi))) / 2; // 0 at the front, the full dip at the back
  const meshes = [{ geometry: bandGeometry(() => R, (psi) => [mid(psi) - Hs / 2, mid(psi) + Hs / 2], () => SCARF.thick * W), tone: 'offWhite' }];
  const out = v3(0, 0, 1);
  const kr = SCARF.knot * W;
  const knot = out.clone().multiplyScalar(R + SCARF.thick * W * 0.8);
  meshes.push({ geometry: new THREE.SphereGeometry(kr, 28, 18).scale(1, 0.85, 0.7).applyMatrix4(frameAt(knot, out)), tone: 'offWhite' });
  const across = new THREE.Vector3().crossVectors(UP, out).normalize();
  for (const [i, len] of SCARF.tail.lengths.entries()) {
    const start = knot
      .clone()
      .addScaledVector(across, (i - 0.5) * 0.16 * W)
      .addScaledVector(head.down, 0.4 * kr)
      .addScaledVector(out, (i + 0.2) * 0.07 * W);
    const dir = head.down.clone().applyAxisAngle(out, (i - 0.5) * 0.18).normalize(); // the two tails splay a little
    for (const t of scarfTail(W, len * W, out, dir)) meshes.push({ ...t, geometry: t.geometry.translate(start.x, start.y, start.z) });
  }
  return byTone(meshes);
}

// ---- Headphones: an off-white band over the head, tilted back behind the
// pet's top part, and two off-white cups with black cushions on the sides of
// the head, level with the upper half of the screen and clear of its rim.
const PHONES = {
  cup: 0.27, // the cup's radius, share of W
  cupMin: 0.2,
  depth: 0.15, // the cup's depth
  cushion: 0.07,
  band: 0.06,
  bandMin: 0.04,
  stand: 0.06, // the band's gap over the head
  tilt: 0.3, // the band leans back this far, more if the top part is in its way
  ear: 0.2, // the cups' middle above the screen's middle, share of its height
};

function headphones(head) {
  const W = head.halfWidth;
  const F = head.face;
  const cR = Math.max(PHONES.cup * W, PHONES.cupMin);
  const [depth, cushion] = [PHONES.depth * W, PHONES.cushion * W];
  const bR = Math.max(PHONES.band * W, PHONES.bandMin);
  const yE = F.y + PHONES.ear * F.h;
  const axis = head.lying ? F.x : head.crown[0];
  const centre = v3(axis, yE, 0);
  const sideAt = (psi, y) => head.cast(v3(axis + 10 * Math.sin(psi), y, 10 * Math.cos(psi)), v3(-Math.sin(psi), 0, -Math.cos(psi)));
  // The cups go round to the sides, further back if the screen wraps round.
  let psi = Math.PI / 2;
  if (!head.lying) {
    const g = head.girth(yE);
    const faceEdge = Math.asin(Math.min(1, (F.w / 2 + 0.1) / g));
    psi = Math.max(psi, faceEdge + Math.asin(Math.min(1, cR / g)) + 0.08);
  }
  const meshes = [];
  const cupProfile = [
    [0, -depth / 2],
    [cR * 0.96, -depth / 2],
    [cR, -depth / 2 + 0.04 * W],
    [cR, depth / 2 - 0.05 * W],
    [cR - 0.05 * W, depth / 2],
    [0, depth / 2],
  ];
  const ends = [];
  for (const side of [-1, 1]) {
    const hit = sideAt(side * psi, yE);
    const n = hit.normal.setY(0).normalize();
    const align = new THREE.Quaternion().setFromUnitVectors(UP, n);
    const at = (d) => hit.point.clone().addScaledVector(n, d);
    const c = at(cushion + depth / 2 - 0.02);
    meshes.push({ geometry: lathe(cupProfile, 64).applyQuaternion(align).translate(c.x, c.y, c.z), tone: 'offWhite' });
    const p = at(cushion / 2 - 0.02);
    meshes.push({ geometry: new THREE.CylinderGeometry(cR * 0.92, cR * 0.92, cushion + 0.04, 48).applyQuaternion(align).translate(p.x, p.y, p.z), tone: 'black' });
    ends.push(at(cushion + depth * 0.4));
  }
  // The band: in the plane through both cups, leaning back by beta; leaning
  // further until it passes clear of a narrow top part.
  const bandAt = (beta) => {
    const pts = [];
    for (let i = 0; i <= 30; i++) {
      const t = -Math.PI / 2 + (i / 30) * Math.PI;
      const dir = v3(Math.sin(t), Math.cos(t) * Math.cos(beta), -Math.cos(t) * Math.sin(beta));
      const hit = head.cast(centre.clone().addScaledVector(dir, 10), dir.clone().negate());
      if (hit) pts.push(hit.point.addScaledVector(hit.normal, PHONES.stand * W + bR));
    }
    return pts;
  };
  const clear = (pts) =>
    pts.every((p) => {
      const reach = head.topAt(p.y);
      return reach === null || Math.hypot(p.x - head.crown[0], p.z) > reach + bR + 0.03;
    });
  let beta = PHONES.tilt;
  let pts = bandAt(beta);
  while (!clear(pts) && beta < 1.2) pts = bandAt((beta += 0.06));
  // Run the band's ends down into the cups.
  pts[0] = ends[0];
  pts[pts.length - 1] = ends[1];
  meshes.push(...tube(pts, bR, 'offWhite'));
  return byTone(meshes);
}

// ---- Party hat: a short stiff off-white cone with black spiral stripes and
// a small black pom on its tip, worn well out on the left of the crown and
// tilted out with the head's slope, so beside the pet's own top part it
// reads as a hat worn next to a crest, not a second spike.
const PARTY = {
  radius: 0.3, // the base's radius, share of W
  radiusMin: 0.23,
  height: 1.0,
  heightMin: 0.75,
  side: 0.28, // off the crown's axis toward the pet's left
  stripes: 3,
  turns: 1.1,
  stripe: 0.36, // a stripe's share of the turn between stripes
  pom: 0.22, // share of the base radius
};

// A ribbon on the cone's surface, winding up it: a black stripe.
function stripeGeometry(radius, height, phase, steps = 64, across = 6) {
  const width = ((2 * Math.PI) / PARTY.stripes) * PARTY.stripe;
  const pos = [];
  for (let i = 0; i <= steps; i++) {
    const u = 0.03 + (0.88 * i) / steps;
    const rr = radius * (1 - u) + 0.006;
    for (let j = 0; j <= across; j++) {
      const phi = phase + PARTY.turns * 2 * Math.PI * u + (j / across - 0.5) * width;
      pos.push(rr * Math.cos(phi), u * height, rr * Math.sin(phi));
    }
  }
  const index = [];
  for (let i = 0; i < steps; i++) {
    for (let j = 0; j < across; j++) {
      const a = i * (across + 1) + j;
      const b = a + across + 1;
      index.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(index);
  g.computeVertexNormals();
  return g;
}

function partyHat(head) {
  const W = head.halfWidth;
  const [cx, crownY] = head.crown;
  const pR = Math.max(PARTY.radius * W, PARTY.radiusMin);
  const pH = Math.max(PARTY.height * W, PARTY.heightMin);
  let d = PARTY.side * W;
  const reach = head.topAt(crownY + 0.03);
  if (reach !== null) d = Math.max(d, reach + pR + 0.15 * W);
  const bx = cx - d;
  const by = head.surfaceAt(bx, 0) ?? crownY;
  const n = head.normalAt(bx, 0);
  const axis = n.clone().multiplyScalar(reach !== null ? 1.6 : 1).add(UP).normalize();
  axis.x -= reach !== null ? 0.12 : 0.08;
  axis.normalize();
  // Sink the base so its low side meets the surface.
  const sink = pR * Math.sin(axis.angleTo(n)) + 0.03;
  const base = v3(bx, by, 0).addScaledVector(axis, -sink);
  const align = new THREE.Quaternion().setFromUnitVectors(UP, axis);
  const place = (g) => g.applyQuaternion(align).translate(base.x, base.y, base.z);
  const cone = lathe([
    [0, 0],
    [pR, 0],
    [0.07 * pR, 0.96 * pH],
    [0, pH],
  ]);
  const meshes = [{ geometry: place(cone), tone: 'offWhite' }];
  for (let s = 0; s < PARTY.stripes; s++) meshes.push({ geometry: place(stripeGeometry(pR, pH, (2 * Math.PI * s) / PARTY.stripes)), tone: 'black' });
  meshes.push({ geometry: place(new THREE.SphereGeometry(PARTY.pom * pR, 24, 16).translate(0, pH, 0)), tone: 'black' });
  return byTone(meshes);
}
