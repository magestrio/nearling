import * as THREE from 'three';
import { OFF_WHITE } from './generator.js';

// The screen is a grid of ROWS pixel rows and as many square columns as its
// width takes. Each face draws on that grid with lit pixels at a level from 0
// (black) to 1 (#F2F1E9); 'X' in a glyph is a lit pixel. Eyes sit at 31% and
// 69% of the width. Faces belong to states (states.js); calm is full's other
// mood. A near-square screen (the capsule's, P5 fix M2) sets its own `rows`
// and `eyes` (assemble.js › bodyShape): more rows keep its columns enough
// for two eyes, nearer the middle so the far one stays whole on the curve.
const ROWS = 12; // pixel rows on the screen
export const CELL = 24; // texture px per screen pixel
const EYES = [0.31, 0.69];

const ARCS = ['..XXX..', '.X...X.', 'X.....X'];
// A blink presses the arcs flat onto their baseline: two rows, then one.
const ARCS_HALF = ['.XXXXX.', 'X.....X'];
const LINE = ['XXXXXXX'];
// Half-height and drowsy: the lower half of a six-wide eye under a heavy lid.
// The lid is a dim row on top of it, so it reads as a lid over the eye: a
// bright lid line read as a brow (the screen's curve and a lean slant it into
// a frown, and over a narrower sliver it read as «T T»), and a solid bright
// block read as a visor. Six wide, not seven, so the eyes keep a clear gap on
// the narrowest screen.
const LID = { rows: ['XXXXXX'], level: 0.4 };
const HALF_EYE = ['XXXXXX', '.XXXX.'];
const Z = ['XXXXX', '...X.', '..X..', '.X...', 'XXXXX'];
const DOT = ['XX', 'XX'];
// The thinking dots' levels: the still's, and in motion the lit dot's trail
// (the dot just passed, then the one before it).
const DOTS = [1, 0.6, 0.32];
// The boot screen's log lines (waking), top to bottom: [row, lit share, track
// share] of the line's width from the left inset. The lit run reads as typed,
// the dim track to its right as the rest of the line still to come.
const BOOT_LINES = [
  [-2, 0.65, 1], // rows from the middle row
  [0, 0.4, 1],
  [2, 0.5, 0.65],
];

// What a face shows beyond its still, for the pet in motion (animator.js):
//   dx, dy  the eyes moved by this many pixel columns and rows (the gaze, the talk)
//   lid     0 open, 1 half shut, 2 shut (a blink; falling asleep; waking)
//   level   every pixel at this share of its own level (the «z z» coming up)
//   step    the thinking dots' phase (0–2: the lit dot), or the boot log's
//           typed pixels so far; null: the still
export const STILL_LOOK = Object.freeze({ dx: 0, dy: 0, lid: 0, level: 1, step: null });
// The faces with eyes: they blink, look and talk.
export const EYE_FACES = new Set(['happy', 'calm', 'drowsy']);

const FACES = {
  // full: pixel arcs
  happy: (d, k) => {
    const top = d.eyeTop(ARCS) + k.dy;
    if (k.lid === 0) d.eyes(ARCS, { dx: k.dx, top });
    else d.eyes(k.lid === 1 ? ARCS_HALF : LINE, { dx: k.dx, top: top + k.lid });
  },
  // full, the other mood: flat lines at eye height; a blink dims them, then
  // puts them out
  calm: (d, k) => k.lid < 2 && d.eyes(LINE, { dx: k.dx, dy: k.dy, level: k.lid ? 0.45 : 1 }),
  // hungry: half-height eyes under their lids, sunk a row below the middle;
  // a blink brings the dim lid down over them
  drowsy: (d, k) => {
    const top = d.eyeTop(DROWSY_ROWS) + 1 + k.dy;
    d.eyes(LID.rows, { dx: k.dx, top, level: LID.level });
    for (let r = 0; r < HALF_EYE.length; r++) {
      d.eyes(HALF_EYE[r], { dx: k.dx, top: top + LID.rows.length + r, level: r < k.lid ? LID.level : 1 });
    }
  },
  // asleep: a dim «z z» in place of the eyes, one z on each eye
  asleep: (d) => d.eyes(Z, { level: 0.55 }),
  // thinking: three dots in place of the eyes, one lit ahead of the others;
  // in motion the lit one steps left to right with its trail behind it
  thinking: (d, k) => {
    const left = Math.round(d.cols / 2 - 5);
    for (let i = 0; i < 3; i++) d.glyph(DOT, left + 4 * i, d.mid - 1, DOTS[k.step === null ? i : (k.step - i + 3) % 3]);
  },
  // waking: the screen boots up — log lines being typed, the eyes not up yet.
  // In motion the lines are typed one after another, `step` pixels so far; a
  // line not reached yet is not shown. Fully typed, it is the still.
  boot: (d, k) => {
    const inset = Math.round(0.17 * d.cols);
    const width = d.cols - 2 * inset;
    let typed = k.step ?? Infinity;
    for (const [dRow, lit, track] of BOOT_LINES) {
      if (typed <= 0) break;
      const row = d.mid + dRow;
      const end = inset + Math.min(Math.round(lit * width), typed);
      typed -= end - inset;
      d.run(row, inset, end, 0.9);
      d.run(row, end, inset + Math.round(track * width), 0.25);
    }
  },
  // the screen dark (a pet still being born, the boot's first instant)
  off: () => {},
};
const DROWSY_ROWS = [...LID.rows, ...HALF_EYE];

// The screen's lit pixels as an emissive texture over the screen's UVs, and a
// `paint(expression, look)` that redraws them (the texture follows). A pet in
// motion repaints only when what it shows changes (animator.js › faceKey).
// layout: the screen's own { rows, eyes }, if it has them.
export function makeScreen(w, h, layout = {}) {
  const rows = layout.rows ?? ROWS;
  const eyesAt = layout.eyes ?? EYES;
  const mid = rows / 2; // eyes sit centred on this row line
  const cols = Math.round((rows * w) / h);
  const W = cols * CELL;
  const H = rows * CELL;

  const lit = document.createElement('canvas');
  lit.width = W;
  lit.height = H;
  const l = lit.getContext('2d');
  let look = STILL_LOOK;
  const pixel = (c, r, level) => {
    l.globalAlpha = level * look.level; // over the black: the off-white scaled to this level
    l.fillRect(c * CELL, r * CELL, CELL, CELL);
  };
  // A glyph is one row (a string) or several.
  const glyph = (glyphRows, left, top, level = 1) => {
    const many = typeof glyphRows !== 'string';
    for (let r = 0; r < (many ? glyphRows.length : 1); r++) {
      const row = many ? glyphRows[r] : glyphRows;
      for (let c = 0; c < row.length; c++) if (row[c] === 'X') pixel(left + c, top + r, level);
    }
  };
  const draw = {
    cols,
    mid,
    glyph,
    // The row a glyph starts on when it is centred on the middle row.
    eyeTop: (glyphRows) => Math.round(mid - glyphRows.length / 2),
    // Both eyes, each centred on its eye column (moved dx columns) and on the
    // middle, shifted down by dy rows (or starting on row `top`).
    eyes: (glyphRows, { dx = 0, dy = 0, level = 1, top = draw.eyeTop(glyphRows) + dy } = {}) => {
      const gw = (typeof glyphRows === 'string' ? glyphRows : glyphRows[0]).length;
      for (const cx of eyesAt) glyph(glyphRows, Math.round(cols * cx - gw / 2) + dx, top, level);
    },
    // Pixels [from, to) of one row.
    run: (row, from, to, level) => {
      for (let c = from; c < to; c++) pixel(c, row, level);
    },
  };

  const texture = new THREE.CanvasTexture(lit);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return {
    texture,
    paint(expression, nextLook = STILL_LOOK) {
      if (!FACES[expression]) throw new Error(`no face "${expression}"`);
      look = nextLook;
      l.globalAlpha = 1;
      l.fillStyle = '#000';
      l.fillRect(0, 0, W, H);
      l.fillStyle = OFF_WHITE;
      FACES[expression](draw, look);
      texture.needsUpdate = true;
    },
    dispose: () => texture.dispose(),
  };
}

// The still of a face, as a texture.
export function makeScreenTexture(w, h, expression = 'happy', layout = {}) {
  const screen = makeScreen(w, h, layout);
  screen.paint(expression);
  return screen.texture;
}

// Point counts for a rounded-rect outline, fixed from the screen's own size so
// that offset outlines (the rim) line up point for point with the screen.
function outlineCounts(w, h, rc, step = 0.02) {
  return {
    arc: Math.max(8, Math.ceil((rc * Math.PI) / 2 / step)),
    top: Math.max(1, Math.ceil((w - 2 * rc) / step)),
    side: Math.max(1, Math.ceil((h - 2 * rc) / step)),
  };
}

// Outline of a rounded rect, counter-clockwise; `grow` pushes it outward
// (same corner centres, larger corner radius) for the rim around the screen.
function roundedRectOutline(w, h, rc, counts, grow = 0) {
  const pts = [];
  const hw = w / 2 - rc;
  const hh = h / 2 - rc;
  const r = rc + grow;
  const corners = [
    [hw, hh, 0, counts.top],
    [-hw, hh, Math.PI / 2, counts.side],
    [-hw, -hh, Math.PI, counts.top],
    [hw, -hh, (3 * Math.PI) / 2, counts.side],
  ];
  corners.forEach(([cx, cy, a0, lineSteps], i) => {
    for (let k = 0; k < counts.arc; k++) {
      const a = a0 + (k / counts.arc) * (Math.PI / 2);
      pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
    const [nx, ny] = corners[(i + 1) % 4];
    const ex = cx + r * Math.cos(a0 + Math.PI / 2);
    const ey = cy + r * Math.sin(a0 + Math.PI / 2);
    const sx = nx + r * Math.cos(a0 + Math.PI / 2);
    const sy = ny + r * Math.sin(a0 + Math.PI / 2);
    for (let k = 0; k < lineSteps; k++) pts.push([ex + ((sx - ex) * k) / lineSteps, ey + ((sy - ey) * k) / lineSteps]);
  });
  return pts;
}

// Pushes flat points (x + dx, y + dy) along -z onto the body, then lifts each
// one off the surface along the surface normal by its own amount.
function projectOntoBody(bodyGeometry, flat, dx, dy, lifts) {
  const target = new THREE.Mesh(bodyGeometry, new THREE.MeshBasicMaterial());
  const ray = new THREE.Raycaster();
  const origin = new THREE.Vector3();
  const dir = new THREE.Vector3(0, 0, -1);
  const positions = new Float32Array(flat.length * 3);
  flat.forEach(([x, y], i) => {
    origin.set(x + dx, y + dy, 10);
    ray.set(origin, dir);
    const hit = ray.intersectObject(target)[0];
    if (!hit) throw new Error(`face point ${i} misses the body: the screen is wider than the body`);
    const n = hit.face.normal;
    const lift = lifts[i];
    positions.set([hit.point.x + n.x * lift, hit.point.y + n.y * lift, hit.point.z + n.z * lift], i * 3);
  });
  return positions;
}

// Triangles between consecutive closed rows of n points each.
function stripIndex(firstRow, rows, n, index = []) {
  for (let k = 0; k < rows - 1; k++) {
    const a = firstRow + k * n;
    const b = firstRow + (k + 1) * n;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      index.push(a + i, b + i, b + j, a + i, b + j, a + j);
    }
  }
  return index;
}

const SCREEN_LIFT = 0.006;
const cornerRadius = (h) => h * 0.44;

// The screen surface: a rounded rect w x h centred at (x, y), built from
// concentric rings and projected onto the body so it hugs any body shape.
// Its edge is geometry, so the canvas's antialiasing smooths it.
export function projectScreen(bodyGeometry, { x, y, w, h }) {
  const rc = cornerRadius(h);
  const outline = roundedRectOutline(w, h, rc, outlineCounts(w, h, rc));
  const rings = 14;
  const n = outline.length;
  const flat = [[0, 0]];
  for (let k = 1; k <= rings; k++) {
    const t = k / rings;
    for (const [x, py] of outline) flat.push([x * t, py * t]);
  }
  const index = [];
  for (let i = 0; i < n; i++) index.push(0, 1 + i, 1 + ((i + 1) % n));
  stripIndex(1, rings, n, index);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(projectOntoBody(bodyGeometry, flat, x, y, flat.map(() => SCREEN_LIFT)), 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(flat.flatMap(([x, py]) => [x / w + 0.5, py / h + 0.5])), 2));
  geometry.setIndex(index);
  geometry.computeVertexNormals();
  return geometry;
}

// The rim: a soft vinyl lip around the screen, so the screen reads as set
// into the body. Rows from the inside out: [outward offset, lift, shade];
// the shade darkens the inner wall like the shadow of a recess.
export const RIM_ROWS = [
  [-0.012, 0.002, 0.45], // tucked under the screen's edge
  [0.0, SCREEN_LIFT + 0.002, 0.45],
  [0.012, 0.024, 0.75],
  [0.026, 0.032, 1],
  [0.048, 0.025, 1],
  [0.072, 0.011, 1],
  [0.098, 0.002, 1], // meets the body
];

export const RIM_OUTSIDE = RIM_ROWS[RIM_ROWS.length - 1][0];
// A screen's `rim` widens its rim by that factor, at the same height (a
// higher lip hid the far eye at three-quarter): the capsule's, so its inset
// reads in the body's colour.
const rimRows = (face) => {
  const k = face.rim ?? 1;
  return k === 1 ? RIM_ROWS : RIM_ROWS.map(([grow, lift, shade]) => [grow * k, lift, shade]);
};
export const rimOutside = (face) => RIM_OUTSIDE * (face.rim ?? 1);

// True when the whole rim lands on the body facing forward, not wrapped
// round a narrow body's side.
export function rimFits(bodyGeometry, face, minFacing = 0.35) {
  const { x, y, w, h } = face;
  const rc = cornerRadius(h);
  const target = new THREE.Mesh(bodyGeometry, new THREE.MeshBasicMaterial());
  const ray = new THREE.Raycaster();
  const dir = new THREE.Vector3(0, 0, -1);
  return roundedRectOutline(w, h, rc, outlineCounts(w, h, rc), rimOutside(face)).every(([px, py]) => {
    ray.set(new THREE.Vector3(px + x, py + y, 10), dir);
    const hit = ray.intersectObject(target)[0];
    return hit && hit.face.normal.z >= minFacing;
  });
}

export function projectRim(bodyGeometry, face) {
  const { x, y, w, h } = face;
  const RIM = rimRows(face);
  const rc = cornerRadius(h);
  const counts = outlineCounts(w, h, rc);
  const flat = [];
  const lifts = [];
  const shades = [];
  for (const [grow, lift, shade] of RIM) {
    for (const p of roundedRectOutline(w, h, rc, counts, grow)) {
      flat.push(p);
      lifts.push(lift);
      shades.push(shade, shade, shade);
    }
  }
  const n = flat.length / RIM.length;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(projectOntoBody(bodyGeometry, flat, x, y, lifts), 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(shades), 3));
  geometry.setIndex(stripIndex(0, RIM.length, n));
  geometry.computeVertexNormals();
  return geometry;
}
