// The pet as a flat drawing on a Canvas 2D, for a browser that has no WebGL
// or has lost its context (iOS Safari under memory pressure). The same pet in
// the same state, from the same data as the 3D model: the assembly
// (assemble.js) is plain geometry, built without a GL context, and this file
// reads it as numbers through the stills' camera, so the drawing lands where
// the 3D picture does. Flat shapes, not a render: each primitive is its own
// silhouette in one matte vinyl tone, the ring a band split in front of and
// behind the body, the rim and the screen flat bands with the screen's own
// pixels (face.js › makeScreenTexture), black feet, and the core light as a
// soft glow on the belly and a pool on the ground. three.js is used for its
// math only; nothing here needs WebGL. A worn item (outfits.js) is drawn
// from its fitted geometry, as flat tones.
import { Euler, Matrix4, Mesh, MeshBasicMaterial, PerspectiveCamera, Quaternion, Raycaster, Vector3 } from 'three';
import { assemblePet, CORE_DEPTH, FOOT, frameFor } from './assemble.js';
import { CELL, makeScreenTexture, RIM_ROWS } from './face.js';
import { HUES } from './generator.js';
import { glowAtMintLuminance, HUE_LIGHT, ITEM_TONES } from './materials.js';

// The stills' camera: the same as PetCanvas.jsx (FOV, ELEVATION, ANGLES and
// Framing there). Kept in step by hand, since importing PetCanvas.jsx would
// pull the 3D renderer into the fallback.
const FOV = 26;
const ELEVATION = (9 * Math.PI) / 180;
export const ANGLES = { front: 0, 'three-quarter': Math.PI / 4, side: Math.PI / 2 };

// The studio's light on the vinyl, as one flat tone: accent × EXPOSURE plus a
// little WHITE (the sheen), through the Neutral tone mapper the 3D post chain
// ends with. Measured: the median lit-vinyl colour of the nine adult
// three-quarter stills in design/pet/ (all five hues, every body kind) fits
// this within 11/255 rms; a half-dome reads a little lighter, a capsule a
// little darker.
const EXPOSURE = 0.6;
const WHITE = 0.03;
// The rim's lip catches the light a little more than the body around it.
const LIP = 1.15;
// The belly, where the core light shows, faces down and away from the
// studio: in the 3D it is this shade of the vinyl when the light is all but
// out (the asleep still's lower body, seed 9). The glow is added to that, as
// the 3D adds it, and the flat tone shows wherever it is lighter; so a dim
// light lifts a small spot only, as in the 3D, and the fill never darkens.
// A bright light blooms in the 3D (PetCanvas.jsx › Post: luminance over
// BLOOM[0], softened over BLOOM[1]), which spreads it over that darker
// belly: by the share it blooms, the belly takes the flat tone instead.
const BELLY = 0.35;
const BLOOM = [1.5, 0.3];
// The asleep ember (spec.glow.belowFace) sits darker than the flat tone in the
// 3D, on a belly in shade this fill does not have, and the fill never darkens:
// on the shade it would not show at all. So it lifts the flat tone itself, by
// this share of its light, which keeps it under hungry's spot on the flat
// (checks: hungry's lift on the flat tone against asleep's, five hues).
const EMBER_ON_TONE = 0.4;
// The ring's two lower faces (drawRing): the near run's underside in shade,
// in `tone` of the vinyl, and the far run's inner face lit by the core's
// spill; `lift` sets how much of the band each takes.
// Both lower faces fade in from the run's ends, between `fade` tube radii
// along it: at the ends the band turns away and the two runs meet in the
// plain tone (a face cut off there read as a hook round the end).
const RING_SHADE = { lift: 0.3, tone: 0.5 };
const RING_INNER = { lift: 1.4 };
const RING_FADE = [1, 3];
const SCREEN = '#000';
// The glow and the pool fade to nothing by this many radii (the pool's own
// cut-off, materials.js › makePoolMaterial).
const GLOW_REACH = 2.6;
const POOL_CUT = [1.2, 2.2];
// The 3D post chain cuts light under 2/255 to transparent (AlphaFromLight.js).
const LIGHT_FLOOR = 2 / 255;

// ---- colour

const toLinear = (hex) =>
  [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
const encode = (l) => {
  const v = Math.min(Math.max(l, 0), 1);
  return v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
};

// The Neutral tone mapper (three.js › NeutralToneMapping). `toe: false` skips
// its toe, as the lavender vinyl and pool undo it (materials.js › UNDO_TOE).
function neutral([r, g, b], toe = true) {
  const x = Math.min(r, g, b);
  const offset = toe ? (x < 0.08 ? x - 6.25 * x * x : 0.04) : 0;
  let c = [r - offset, g - offset, b - offset];
  const peak = Math.max(...c);
  if (peak < 0.76) return c;
  const d = 0.24;
  const newPeak = 1 - (d * d) / (peak + d - 0.76);
  c = c.map((v) => (v * newPeak) / peak);
  const k = 1 - 1 / (0.15 * (peak - newPeak) + 1);
  return c.map((v) => v * (1 - k) + newPeak * k);
}

// An opaque colour from linear light.
const solid = (lin, toe) => {
  const [r, g, b] = neutral(lin, toe).map((v) => Math.round(255 * encode(v)));
  return `rgb(${r},${g},${b})`;
};

// The feet (materials.js › makeFeetMaterial, #141414) have no sheen, so no
// WHITE: through the tone mapper they come out near-black, as the 3D's do
// (median #010403 on seed 9's still).
const FEET = solid(toLinear('#141414').map((c) => c * EXPOSURE));
// A worn item's face that looks up (its normal this far up) catches the
// studio's soft box: its tone takes this much more white light, as the
// cap's board top does in the 3D (black from 21 to about 70, as the 3D's
// board top reads; off-white a little lighter).
const TOP_FACE = { up: 0.7, light: 0.07 };

// Light on a transparent ground, as the 3D stills keep it: the colour over
// black, its alpha the brightest channel (AlphaFromLight.js).
function light(lin, toe) {
  const c = neutral(lin, toe).map(encode);
  const a = Math.max(...c);
  if (a < LIGHT_FLOOR) return [0, 0, 0, 0];
  return [...c.map((v) => Math.round((255 * v) / a)), a];
}

// ---- geometry

function cameraFor({ centerY, radius, shiftX = 0 }, aspect) {
  const camera = new PerspectiveCamera(FOV, aspect, 0.1, 100);
  const d = (radius * 1.06) / Math.sin(((FOV / 2) * Math.PI) / 180);
  camera.position.set(0, centerY + d * Math.sin(ELEVATION), d * Math.cos(ELEVATION));
  camera.lookAt(0, centerY, 0);
  if (shiftX) camera.setViewOffset(aspect, 1, shiftX * aspect, 0, aspect, 1);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
  return camera;
}

const compose = (position, rotation, scale = [1, 1, 1]) =>
  new Matrix4().compose(new Vector3(...position), new Quaternion().setFromEuler(new Euler(...rotation)), new Vector3(...scale));

function vertices(geometry, matrix) {
  const pos = geometry.attributes.position;
  return Array.from({ length: pos.count }, (_, i) => new Vector3().fromBufferAttribute(pos, i).applyMatrix4(matrix));
}

// Convex hull (monotone chain) of [x, y] points.
function hull(points) {
  const p = points.map((q) => [q.x, q.y]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const half = (list) => {
    const out = [];
    for (const q of list) {
      while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], q) <= 0) out.pop();
      out.push(q);
    }
    return out.slice(0, -1);
  };
  return [...half(p), ...half(p.reverse())];
}

function tracePolygon(ctx, polygon) {
  ctx.beginPath();
  polygon.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
}

function fillPolygon(ctx, polygon, style) {
  ctx.fillStyle = style;
  tracePolygon(ctx, polygon);
  ctx.fill();
}

const boxOf = (points) => ({
  x0: Math.min(...points.map((p) => p[0])),
  y0: Math.min(...points.map((p) => p[1])),
  x1: Math.max(...points.map((p) => p[0])),
  y1: Math.max(...points.map((p) => p[1])),
});

// An offscreen canvas just big enough for `box`, drawn on in canvas
// coordinates; paste() puts it back. Kept small: the fallback runs where
// memory is short.
function layer({ x0, y0, x1, y1 }) {
  const x = Math.floor(x0) - 2;
  const y = Math.floor(y0) - 2;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(x1) + 2 - x);
  canvas.height = Math.max(1, Math.ceil(y1) + 2 - y);
  const ctx = canvas.getContext('2d');
  ctx.translate(-x, -y);
  return { ctx, paste: (target) => target.drawImage(canvas, x, y) };
}

// A torus ring's centre circle, as points with their on-canvas tube radius
// and the point of the ring's inner face there (world, with its normal),
// split into the run in front of the ring's middle and the run behind it.
function ringRuns(part, matrix, project) {
  const { radius, tube } = part.geometry.parameters;
  const m = matrix.clone().multiply(compose(part.position, part.rotation));
  const middle = new Vector3().applyMatrix4(m);
  const centre = project(middle);
  const tubeWorld = tube * Math.cbrt(Math.abs(m.determinant()));
  const steps = 192;
  const pts = Array.from({ length: steps }, (_, i) => {
    const phi = (i / steps) * 2 * Math.PI;
    const world = new Vector3(radius * Math.cos(phi), 0, radius * Math.sin(phi)).applyMatrix4(m);
    const inward = middle.clone().sub(world).normalize();
    const p = project(world);
    return { ...p, r: tubeWorld * p.scale, front: p.depth < centre.depth, inner: world.addScaledVector(inward, tubeWorld), inward };
  });
  // Start the walk where the ring turns from behind to in front.
  const start = Math.max(0, pts.findIndex((p, i) => p.front && !pts[(i + steps - 1) % steps].front));
  const runs = { front: [], back: [] };
  for (let k = 0; k < steps; k++) {
    const p = pts[(start + k) % steps];
    const side = p.front ? 'front' : 'back';
    const run = runs[side];
    if (!run.length || run[run.length - 1].end) run.push([]);
    run[run.length - 1].push(p);
    // Each run also takes its neighbour's first point, so the two meet.
    const next = pts[(start + k + 1) % steps];
    if (next.front !== p.front) {
      run[run.length - 1].push(next);
      run[run.length - 1].end = true;
    }
  }
  // Each point's distance along its run to the nearer end, in canvas px.
  for (const run of [...runs.front, ...runs.back]) {
    const along = [0];
    for (let i = 1; i < run.length; i++) along.push(along[i - 1] + Math.hypot(run[i].x - run[i - 1].x, run[i].y - run[i - 1].y));
    run.forEach((p, i) => (p.fromEnd = Math.min(along[i], along[along.length - 1] - along[i])));
  }
  return runs;
}

// Runs of the ring as a band: round-capped segments of the tube's width,
// moved down by `drop` of the tube radius. `style`: one colour, or one per
// segment from its first point.
function strokeBand(ctx, runs, style, drop = 0) {
  ctx.lineCap = 'round';
  for (const run of runs) {
    for (let i = 0; i < run.length - 1; i++) {
      const [p, q] = [run[i], run[i + 1]];
      ctx.strokeStyle = typeof style === 'function' ? style(p) : style;
      ctx.lineWidth = p.r + q.r;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y + drop * p.r);
      ctx.lineTo(q.x, q.y + drop * q.r);
      ctx.stroke();
    }
  }
}

// A run of the ring in two faces: the band in `lower`, then `upper` over it
// and only over it, moved up by `lift` of the tube radius, so a crescent of
// `lower` shows along the band's lower edge. The near run's lower face is
// its underside in shade; the far run's is its inner face, which faces the
// core across the hole.
function drawRing(ctx, runs, lower, upper, lift) {
  if (!runs.length) return;
  const l = layer(boxOf(runs.flat().flatMap((p) => [[p.x - p.r, p.y - p.r], [p.x + p.r, p.y + p.r]])));
  strokeBand(l.ctx, runs, lower);
  l.ctx.globalCompositeOperation = 'source-atop';
  strokeBand(l.ctx, runs, upper, -lift);
  l.paste(ctx);
}

// The body's underside height at (x, z) in pet space, or null off the body
// (as assemble.js finds it to seat the feet).
function undersideOf(body) {
  const mesh = new Mesh(body.geometry, new MeshBasicMaterial());
  mesh.matrixWorld.copy(compose(body.position, body.rotation, body.scale));
  const ray = new Raycaster();
  const up = new Vector3(0, 1, 0);
  return (x, z) => {
    ray.set(new Vector3(x, -10, z), up);
    return ray.intersectObject(mesh, false)[0]?.point.y ?? null;
  };
}

// Barycentric lookup on the screen mesh: a texture (u, v) to its point on the
// body, so the pixels sit on the screen as the 3D texture does.
function screenPoint(screen) {
  const uv = screen.attributes.uv;
  const pos = screen.attributes.position;
  const index = screen.index.array;
  return (u, v) => {
    let best = null;
    for (let t = 0; t < index.length; t += 3) {
      const [a, b, c] = [index[t], index[t + 1], index[t + 2]];
      const ax = uv.getX(a);
      const ay = uv.getY(a);
      const [x0, y0] = [uv.getX(b) - ax, uv.getY(b) - ay];
      const [x1, y1] = [uv.getX(c) - ax, uv.getY(c) - ay];
      const [x2, y2] = [u - ax, v - ay];
      const den = x0 * y1 - x1 * y0;
      if (Math.abs(den) < 1e-12) continue;
      const wb = (x2 * y1 - x1 * y2) / den;
      const wc = (x0 * y2 - x2 * y0) / den;
      const wa = 1 - wb - wc;
      const inside = Math.min(wa, wb, wc);
      if (!best || inside > best.inside) best = { inside, a, b, c, wa, wb, wc };
      if (inside >= 0) break;
    }
    const p = (i, w) => new Vector3().fromBufferAttribute(pos, i).multiplyScalar(w);
    return p(best.a, best.wa).add(p(best.b, best.wb)).add(p(best.c, best.wc));
  };
}

// A part's convex pieces, as lists of its vertex indices: a lathe is split
// where its profile turns inward (the cone top's knob at its tip, which one
// outline round the whole part smoothed away); any other part is one piece.
function convexPieces(geometry) {
  const count = geometry.attributes.position.count;
  const points = geometry.type === 'LatheGeometry' ? geometry.parameters.points : null;
  if (!points) return [Array.from({ length: count }, (_, i) => i)];
  const n = points.length;
  const turn = (j) => {
    const [a, b, c] = [points[j - 1], points[j], points[j + 1]];
    const [ux, uy, wx, wy] = [b.x - a.x, b.y - a.y, c.x - b.x, c.y - b.y];
    return (ux * wy - uy * wx) / (Math.hypot(ux, uy) * Math.hypot(wx, wy) || 1);
  };
  const turns = Array.from({ length: n }, (_, j) => (j > 0 && j < n - 1 ? turn(j) : 0));
  const way = Math.sign(turns.reduce((sum, t) => sum + t, 0));
  const cuts = [0, ...turns.flatMap((t, j) => (t * way < -0.05 ? [j] : [])), n - 1];
  const pieces = [];
  for (let k = 0; k < cuts.length - 1; k++) {
    const [from, to] = [cuts[k], cuts[k + 1]];
    pieces.push(Array.from({ length: count }, (_, i) => i).filter((i) => i % n >= from && i % n <= to));
  }
  return pieces;
}

// A mesh's triangles on the canvas: each as its three projected corners
// ({ x, y, depth }) and how far its normal, turned to the eye, looks up.
function trianglesOf(geometry, matrix, project, eye) {
  const pos = geometry.attributes.position;
  const index = geometry.index?.array;
  const world = Array.from({ length: pos.count }, (_, i) => new Vector3().fromBufferAttribute(pos, i).applyMatrix4(matrix));
  const screen = world.map(project);
  const tris = [];
  for (let t = 0; t + 2 < (index ? index.length : pos.count); t += 3) {
    const [i, j, k] = index ? [index[t], index[t + 1], index[t + 2]] : [t, t + 1, t + 2];
    const n = world[j].clone().sub(world[i]).cross(world[k].clone().sub(world[i])).normalize();
    if (n.dot(eye.clone().sub(world[i])) < 0) n.negate();
    tris.push({ pts: [screen[i], screen[j], screen[k]], up: n.y });
  }
  return tris;
}

// A worn item's surfaces are many, not convex, and lie on one another (the
// cap's cord on its board), so it goes by depth: its triangles and the pet's,
// which only hide it, into a small depth buffer over the item's box at
// ITEM_SAMPLES × ITEM_SAMPLES samples a pixel. A pixel takes its item samples'
// flat tones averaged, its alpha their share. No light: flat tones only.
const ITEM_SAMPLES = 3;

function drawItem(ctx, W, H, items, hides, colours) {
  const S = ITEM_SAMPLES;
  let [x0, y0, x1, y1] = [W, H, 0, 0];
  for (const { pts } of items) {
    for (const p of pts) [x0, y0, x1, y1] = [Math.min(x0, p.x), Math.min(y0, p.y), Math.max(x1, p.x), Math.max(y1, p.y)];
  }
  [x0, y0] = [Math.max(0, Math.floor(x0) - 1), Math.max(0, Math.floor(y0) - 1)];
  [x1, y1] = [Math.min(W, Math.ceil(x1) + 1), Math.min(H, Math.ceil(y1) + 1)];
  const [w, h] = [x1 - x0, y1 - y0];
  if (w <= 0 || h <= 0) return;
  const [bw, bh] = [w * S, h * S];
  const depth = new Float32Array(bw * bh).fill(Infinity);
  const id = new Uint8Array(bw * bh); // 0: nothing, or the pet
  const raster = (pts, value) => {
    const [a, b, c] = pts.map((p) => [(p.x - x0) * S, (p.y - y0) * S, p.depth]);
    const area = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    if (Math.abs(area) < 1e-9) return;
    const minX = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0])));
    const maxX = Math.min(bw - 1, Math.ceil(Math.max(a[0], b[0], c[0])));
    const minY = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1])));
    const maxY = Math.min(bh - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
    for (let y = minY; y <= maxY; y++) {
      const py = y + 0.5;
      for (let x = minX; x <= maxX; x++) {
        const px = x + 0.5;
        const wa = ((b[0] - px) * (c[1] - py) - (b[1] - py) * (c[0] - px)) / area;
        const wb = ((c[0] - px) * (a[1] - py) - (c[1] - py) * (a[0] - px)) / area;
        const wc = 1 - wa - wb;
        if (wa < 0 || wb < 0 || wc < 0) continue;
        const z = wa * a[2] + wb * b[2] + wc * c[2];
        const k = y * bw + x;
        if (z < depth[k]) {
          depth[k] = z;
          id[k] = value;
        }
      }
    }
  };
  for (const t of hides) raster(t.pts, 0);
  for (const t of items) raster(t.pts, t.colour);

  const image = new ImageData(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let [n, r, g, b] = [0, 0, 0, 0];
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const v = id[(y * S + sy) * bw + x * S + sx];
          if (!v) continue;
          const c = colours[v];
          [n, r, g, b] = [n + 1, r + c[0], g + c[1], b + c[2]];
        }
      }
      if (n) image.data.set([r / n, g / n, b / n, (255 * n) / (S * S)], (y * w + x) * 4);
    }
  }
  const item = document.createElement('canvas');
  item.width = w;
  item.height = h;
  item.getContext('2d').putImageData(image, 0, 0);
  ctx.drawImage(item, x0, y0);
}

// ---- the drawing

// Draws the pet on `canvas` (its own pixel size), on a transparent ground.
// seed: the token_id. stage: baby | teen | adult. state: full | hungry |
// asleep | thinking | waking. angle: an ANGLES key. frame: the camera, as
// assemble.js › frameFor gives it or scripts/stills.mjs fits it ({ centerY,
// radius, shiftX }); without it the camera fits this pet alone. face: a
// face.js expression in place of the state's own (full's other mood: calm).
// outfit: an outfits.js slug or 'none', worn as fitted.
export function drawFlatPet(canvas, { seed, stage = 'adult', state = 'full', angle = 'three-quarter', frame, face, outfit = 'none' } = {}) {
  const a = assemblePet(String(seed), state, stage, outfit);
  const { spec } = a;
  const W = canvas.width;
  const H = canvas.height;
  const camera = cameraFor(frame ?? frameFor([a]), W / H);
  const focal = H / 2 / Math.tan(((FOV / 2) * Math.PI) / 180);
  const v = new Vector3();
  const project = (p) => {
    v.copy(p).applyMatrix4(camera.matrixWorldInverse);
    const depth = -v.z;
    v.applyMatrix4(camera.projectionMatrix);
    return { x: ((v.x + 1) / 2) * W, y: ((1 - v.y) / 2) * H, depth, scale: focal / depth };
  };
  const outline = (points) => hull(points.map(project));

  // Colours: the vinyl's flat tone, a shade of it, the core light's hue.
  const gains = HUE_LIGHT[spec.hue];
  const toe = !gains.toe;
  const accent = toLinear(HUES[spec.hue]);
  const vinyl = (shade = 1) => accent.map((c) => c * EXPOSURE * shade + WHITE);
  const glowHue = glowAtMintLuminance(HUES[spec.hue]);
  const glowLin = [glowHue.r, glowHue.g, glowHue.b];

  // Placements, as Pet.jsx sets them inside the turntable.
  const turn = new Matrix4().makeRotationY(ANGLES[angle]);
  const { body } = a;
  const bodyM = turn.clone().multiply(compose(body.position, body.rotation, body.scale));
  const bodyPoints = vertices(body.geometry, bodyM);
  const bodyShape = outline(bodyPoints);
  const axis = project(new Vector3(...body.position).applyMatrix4(turn));

  const rings = [];
  const solids = [];
  a.parts.forEach((p, i) => {
    if (p.geometry.type === 'TorusGeometry') return rings.push(ringRuns(p, bodyM, project));
    const m = bodyM.clone().multiply(compose(p.position, p.rotation));
    // The tail is the last part (assemble.js); it is drawn by its depth.
    const isTail = spec.tail && i === a.parts.length - 1;
    const behind = isTail && project(new Vector3().applyMatrix4(m)).depth > axis.depth;
    const points = vertices(p.geometry, m);
    const pieces = convexPieces(p.geometry);
    solids.push({ shapes: pieces.map((piece) => outline(piece.map((k) => points[k]))), behind });
  });

  // A foot's top is inside the body. A far foot is drawn before the body,
  // which hides its top; a near one after it, cut off where its near side
  // goes up into the body's underside.
  const footR = FOOT.radius * (spec.growth ?? 1);
  const underside = undersideOf(body);
  const feet = a.feet.map((f) => {
    const m = turn
      .clone()
      .multiply(new Matrix4().makeTranslation(...f.position))
      .multiply(new Matrix4().makeRotationY(f.angle))
      .multiply(new Matrix4().makeRotationX(-FOOT.tilt));
    const centre = project(new Vector3(...f.position).applyMatrix4(turn));
    const front = centre.depth < axis.depth - footR;
    return { shape: outline(vertices(f.geometry, m)), front, cut: front ? footCut(f, footR, turn, camera, underside, project, H) : null };
  });

  // The core light. On the body it peaks where the surface is nearest the
  // core and falls off with the glow radius (materials.js › makeVinyl).
  const core = new Vector3(...a.coreLocal).applyMatrix4(bodyM);
  const R = a.glowRadius;
  const nearest = bodyPoints.reduce((n, p) => (p.distanceTo(core) < n.distanceTo(core) ? p : n));
  const peak = Math.exp(-((nearest.distanceTo(core) / R) ** 2));
  const glowAt = project(nearest);
  const strength = spec.glow.strength * gains.glow;
  const glowPx = R * glowAt.scale;
  // The core's spill light (Pet.jsx › pointLight, its intensity worked out
  // the same way): it lights the ring's inner face, which faces the core, in
  // the accent on the accent vinyl, falling off with the square of the
  // distance. The far run of the ring shows that face.
  const corePeak = (radius) => Math.exp(-((CORE_DEPTH / radius) ** 2));
  const { radius: glowRadius, radiusShare } = spec.glow;
  const spill = strength * 0.7 * (corePeak(glowRadius) / corePeak(glowRadius / radiusShare)) * radiusShare ** 2;
  const fadeIn = (p) => {
    const u = Math.min(1, Math.max(0, (p.fromEnd / p.r - RING_FADE[0]) / (RING_FADE[1] - RING_FADE[0])));
    return u * u * (3 - 2 * u);
  };
  const innerFace = (p) => {
    const toCore = core.clone().sub(p.inner);
    const d2 = Math.max(toCore.lengthSq(), 0.01);
    const lit = (fadeIn(p) * spill * Math.max(0, p.inward.dot(toCore.normalize()))) / d2 / Math.PI;
    // The inner face is in shade (as the near run's underside) but for the spill on it.
    return solid(vinyl(1 - (1 - RING_SHADE.tone) * fadeIn(p)).map((c, k) => c + accent[k] * accent[k] * lit), toe);
  };

  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  const plain = solid(vinyl(), toe);

  // 1. The pool of core light on the ground, added as light.
  drawPool(ctx, a, turn, camera, W, H, glowLin.map((c) => c * spec.pool.strength * gains.pool), toe);

  // 2. What stands behind the body: the far feet, a tail behind it, the far
  //    run of the ring, its inner face lit by the spill. The ring and the
  //    body share one layer, so the glow reaches the ring past the body.
  for (const f of feet.filter((f) => !f.front)) fillPolygon(ctx, f.shape, FEET);
  for (const s of solids.filter((s) => s.behind)) s.shapes.forEach((shape) => fillPolygon(ctx, shape, plain));
  const back = layer(boxOf([...bodyShape, ...rings.flatMap((r) => r.back.flat().flatMap((p) => [[p.x - p.r, p.y - p.r], [p.x + p.r, p.y + p.r]]))]));
  for (const r of rings) drawRing(back.ctx, r.back, innerFace, plain, RING_INNER.lift);
  fillPolygon(back.ctx, bodyShape, plain);
  // The glow over what the layer holds: opaque where it lights the vinyl,
  // fading out where it is all but the plain tone, so the far ring's own
  // faces stay where the glow does not reach.
  const glow = back.ctx.createRadialGradient(glowAt.x, glowAt.y, 0, glowAt.x, glowAt.y, GLOW_REACH * glowPx);
  const base = neutral(vinyl(), toe).map((v) => 255 * encode(v));
  const atPeak = vinyl().map((c, k) => c + strength * (glowLin[k] * peak + 0.4 * peak ** 3));
  const u = Math.min(1, Math.max(0, (0.2126 * atPeak[0] + 0.7152 * atPeak[1] + 0.0722 * atPeak[2] - BLOOM[0]) / BLOOM[1]));
  const belly = spec.glow.belowFace ? 1 : BELLY + (1 - BELLY) * u * u * (3 - 2 * u);
  const glowShare = spec.glow.belowFace ? EMBER_ON_TONE : 1;
  for (let i = 0; i <= 24; i++) {
    const t = (i / 24) * GLOW_REACH;
    const g = peak * Math.exp(-t * t);
    const lit = neutral(vinyl(belly).map((c, k) => c + glowShare * strength * (glowLin[k] * g + 0.4 * g ** 3)), toe).map((v, k) => Math.max(255 * encode(v), base[k]));
    const alpha = Math.min(1, Math.max(...lit.map((c, k) => Math.abs(c - base[k]))) / 6);
    glow.addColorStop(i / 24, `rgba(${lit.map(Math.round).join(',')},${alpha.toFixed(3)})`);
  }
  back.ctx.globalCompositeOperation = 'source-atop';
  back.ctx.fillStyle = glow;
  back.ctx.fillRect(0, 0, W, H);
  back.paste(ctx);

  // 3. The top pieces and a tail in front, in the plain vinyl tone.
  for (const s of solids.filter((s) => !s.behind)) s.shapes.forEach((shape) => fillPolygon(ctx, shape, plain));

  // 4. The rim, outside in: the lip, then the inner wall in its shades
  //    (face.js › RIM_ROWS), then the black screen and its lit pixels.
  drawScreen(ctx, a, bodyM, project, (shade, lip) => solid(vinyl(shade * (lip ? LIP : 1)), toe), face ?? spec.face.expression);

  // 5. The near run of the ring, then the near feet below the body.
  const ringUnder = (p) => solid(vinyl(1 - (1 - RING_SHADE.tone) * fadeIn(p)), toe);
  for (const r of rings) drawRing(ctx, r.front, ringUnder, plain, RING_SHADE.lift);
  for (const f of feet.filter((f) => f.front)) {
    ctx.save();
    tracePolygon(ctx, f.cut);
    ctx.clip();
    fillPolygon(ctx, f.shape, FEET);
    ctx.restore();
  }

  // 6. The worn item, as fitted, in the item vinyl's flat tones (materials.js
  //    › makeItemVinyl); hidden where the body, a top piece or the ring is
  //    nearer.
  if (a.outfit) {
    const eye = camera.position;
    const hides = [body, ...a.parts].flatMap((p, i) => trianglesOf(p.geometry, i ? bodyM.clone().multiply(compose(p.position, p.rotation)) : bodyM, project, eye));
    const m = bodyM.clone().multiply(compose(a.outfit.position, a.outfit.rotation));
    const tones = Object.keys(ITEM_TONES);
    const colours = [null];
    for (const name of tones) {
      for (const top of [false, true]) {
        const lin = toLinear(ITEM_TONES[name]).map((c) => c * EXPOSURE + WHITE + (top ? TOP_FACE.light : 0));
        colours.push(neutral(lin).map((v) => Math.round(255 * encode(v))));
      }
    }
    const items = a.outfit.meshes.flatMap(({ geometry, tone }) =>
      trianglesOf(geometry, m, project, eye).map((t) => ({ ...t, colour: 1 + 2 * tones.indexOf(tone) + (t.up > TOP_FACE.up ? 1 : 0) })),
    );
    drawItem(ctx, W, H, items, hides, colours);
  }
}

// What of a near foot shows: the canvas below the line where its near side
// meets the body's underside, carried out past both of its edges.
function footCut(f, radius, turn, camera, underside, project, H) {
  const [fx, top, fz] = f.position;
  const steps = 64;
  const side = Array.from({ length: steps }, (_, i) => {
    const t = (i / steps) * 2 * Math.PI;
    const [x, z] = [fx + radius * Math.cos(t), fz + radius * Math.sin(t)];
    const p = new Vector3(x, Math.min(top, underside(x, z) ?? top), z).applyMatrix4(turn);
    const normal = new Vector3(Math.cos(t), 0, Math.sin(t)).transformDirection(turn);
    return { p, facing: normal.dot(camera.position.clone().sub(p)) > 0 };
  });
  const first = Math.max(0, side.findIndex((s, i) => s.facing && !side[(i + steps - 1) % steps].facing));
  const line = [];
  for (let k = 0; k < steps && side[(first + k) % steps].facing; k++) {
    const q = project(side[(first + k) % steps].p);
    line.push([q.x, q.y]);
  }
  const [a, b] = [line[0], line[line.length - 1]];
  const out = Math.sign(b[0] - a[0]) * 2 * radius * project(side[first].p).scale;
  return [[a[0] - out, a[1]], ...line, [b[0] + out, b[1]], [b[0] + out, H + 1], [a[0] - out, H + 1]];
}

function drawScreen(ctx, a, bodyM, project, tone, expression) {
  const toCanvas = (p) => {
    const q = project(p.clone().applyMatrix4(bodyM));
    return [q.x, q.y];
  };
  const rowOf = (geometry, n, k) => {
    const pos = geometry.attributes.position;
    return Array.from({ length: n }, (_, i) => toCanvas(new Vector3().fromBufferAttribute(pos, k * n + i)));
  };
  // The rim is RIM_ROWS rows of one outline each, inside out; the screen's
  // outer ring is the same outline (face.js › projectRim, projectScreen).
  const n = a.rim.attributes.position.count / RIM_ROWS.length;
  const last = RIM_ROWS.length - 1;
  fillPolygon(ctx, rowOf(a.rim, n, last), tone(1, true));
  // The inner wall, outside in: the band inside row k takes the mean shade of
  // rows k and k - 1 (the 3D shades blend between rows). The band inside row
  // 1 lies under the screen.
  for (let k = last - 1; k >= 2; k--) {
    const shade = (RIM_ROWS[k][2] + RIM_ROWS[k - 1][2]) / 2;
    if (shade < 1) fillPolygon(ctx, rowOf(a.rim, n, k), tone(shade, false));
  }
  // The screen's outer ring is its last n points.
  const screenCount = a.screen.attributes.position.count;
  fillPolygon(
    ctx,
    Array.from({ length: n }, (_, i) => toCanvas(new Vector3().fromBufferAttribute(a.screen.attributes.position, screenCount - n + i))),
    SCREEN,
  );

  // The screen's pixels, read off the 3D texture: one quad per lit pixel,
  // its corners carried onto the body through the screen mesh.
  const texture = makeScreenTexture(a.face.w, a.face.h, expression, a.face);
  const image = texture.image;
  const cols = image.width / CELL;
  const rows = image.height / CELL;
  const data = image.getContext('2d').getImageData(0, 0, image.width, image.height).data;
  texture.dispose();
  const at = screenPoint(a.screen);
  const corners = new Map();
  const corner = (c, r) => {
    const key = `${c},${r}`;
    if (!corners.has(key)) corners.set(key, toCanvas(at(c / cols, 1 - r / rows))); // the texture is flipped in v
    return corners.get(key);
  };
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = ((r * CELL + CELL / 2) * image.width + c * CELL + CELL / 2) * 4;
      if (Math.max(data[i], data[i + 1], data[i + 2]) === 0) continue;
      const quad = [corner(c, r), corner(c + 1, r), corner(c + 1, r + 1), corner(c, r + 1)];
      // Grown by a third of a pixel, so neighbouring pixels close up.
      const mx = quad.reduce((s, p) => s + p[0], 0) / 4;
      const my = quad.reduce((s, p) => s + p[1], 0) / 4;
      const grown = quad.map(([x, y]) => {
        const d = Math.hypot(x - mx, y - my) || 1;
        return [x + ((x - mx) / d) * 0.35, y + ((y - my) / d) * 0.35];
      });
      fillPolygon(ctx, grown, `rgb(${data[i]},${data[i + 1]},${data[i + 2]})`);
    }
  }
}

// The pool (materials.js › makePoolMaterial): a gaussian ellipse on the
// ground under the core, faded to zero by POOL_CUT[1] radii. Worked out per
// pixel where the camera's ray meets the ground, so its perspective is the
// 3D one; added onto the canvas as light.
function drawPool(ctx, a, turn, camera, W, H, colour, toe) {
  if (Math.max(...colour) <= 0) return;
  const [cx, , cz] = a.pool.position;
  const [rx, rz] = a.pool.radius;
  const unturn = turn.clone().invert();
  // The canvas box the pool can reach.
  const box = { x0: W, y0: H, x1: 0, y1: 0 };
  const p = new Vector3();
  for (let i = 0; i < 64; i++) {
    const t = (i / 64) * 2 * Math.PI;
    p.set(cx + POOL_CUT[1] * rx * Math.cos(t), 0, cz + POOL_CUT[1] * rz * Math.sin(t)).applyMatrix4(turn).project(camera);
    const x = ((p.x + 1) / 2) * W;
    const y = ((1 - p.y) / 2) * H;
    Object.assign(box, { x0: Math.min(box.x0, x), y0: Math.min(box.y0, y), x1: Math.max(box.x1, x), y1: Math.max(box.y1, y) });
  }
  const x0 = Math.max(0, Math.floor(box.x0));
  const y0 = Math.max(0, Math.floor(box.y0));
  const w = Math.min(W, Math.ceil(box.x1)) - x0;
  const h = Math.min(H, Math.ceil(box.y1)) - y0;
  if (w <= 0 || h <= 0) return;

  // The light at a share of the peak, tabled finely enough that the faint
  // tail crosses the stills' crop threshold where the 3D one does.
  const LEVELS = 1 << 16;
  const table = Array.from({ length: LEVELS + 1 }, (_, i) => light(colour.map((c) => (c * i) / LEVELS), toe));
  const image = new ImageData(w, h);
  const eye = camera.position;
  const ray = new Vector3();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      ray.set(((x0 + x + 0.5) / W) * 2 - 1, 1 - ((y0 + y + 0.5) / H) * 2, 0.5).unproject(camera).sub(eye);
      if (ray.y >= 0) continue;
      const t = (0.002 - eye.y) / ray.y;
      ray.multiplyScalar(t).add(eye).applyMatrix4(unturn);
      const r = Math.hypot((ray.x - cx) / rx, (ray.z - cz) / rz);
      if (r >= POOL_CUT[1]) continue;
      const u = (r - POOL_CUT[0]) / (POOL_CUT[1] - POOL_CUT[0]);
      const fade = u <= 0 ? 1 : 1 - u * u * (3 - 2 * u);
      const [R, G, B, A] = table[Math.round(Math.exp(-r * r) * fade * LEVELS)];
      if (!A) continue;
      image.data.set([R, G, B, Math.round(255 * A)], (y * w + x) * 4);
    }
  }
  const pool = document.createElement('canvas');
  pool.width = w;
  pool.height = h;
  pool.getContext('2d').putImageData(image, 0, 0);
  ctx.globalCompositeOperation = 'lighter';
  ctx.drawImage(pool, x0, y0);
  ctx.globalCompositeOperation = 'source-over';
}
