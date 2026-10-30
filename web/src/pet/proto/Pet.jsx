import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { Animator, BODY, ITEM, LIGHT, PARTS, footAt, lightOf } from './animator.js';
import { FOOT } from './assemble.js';
import { makeScreen } from './face.js';
import { HUES } from './generator.js';
import { EASE, GAZE } from './motion.js';
import { HUE_LIGHT, ITEM_TONES, makeFeetMaterial, makeItemVinyl, makePoolMaterial, makeScreenMaterial, makeVinyl } from './materials.js';

// Draws one assembled pet (assemble.js) in its state (the assembly carries
// it). Geometry comes from the assembly; this component owns the materials
// and writes the pet's pose onto its meshes (animator.js).
// `hue` and `gains` override the pet's own hue and its HUE_LIGHT gains; they
// exist for scripts/measure-light.mjs. `face` overrides the state's face
// (full's other mood: calm). `itemOnly` draws the worn item alone, without
// the pet or its light (a wardrobe tile).
// `motion` (useMotion.js › usePetMotion) puts the pet in motion unless
// `paused`; without it, or paused, the pet stands in its still.
export function Pet({ assembly, hue: hueOverride, gains: gainsOverride, face, itemOnly = false, motion = null, paused = false }) {
  const { spec } = assembly;
  const hue = hueOverride ?? spec.hue;
  const accent = HUES[hue];
  const gains = gainsOverride ?? HUE_LIGHT[hue];
  const toe = gains.toe ?? false;
  const expression = face ?? spec.face.expression;
  const light = lightOf(assembly, gains);
  const corePos = useMemo(() => ({ value: new THREE.Vector3() }), []);
  const { w, h, rows, eyes } = assembly.face;
  const eyesKey = eyes?.join(',');

  // Made once per hue and screen size, and kept through changes of state and
  // outfit: the light, the pool's size and the face come from the pose
  // (apply), so they are left out of the keys.
  const mats = useMemo(() => {
    const glow = { color: accent, glowColor: accent, glowStrength: light.glowStrength, glowRadius: light.glowRadius, corePos, toe };
    const screen = makeScreen(w, h, { rows, eyes: eyesKey?.split(',').map(Number) });
    screen.paint(expression);
    return {
      vinyl: makeVinyl(glow),
      rimVinyl: makeVinyl({ ...glow, vertexColors: true }),
      screenTexture: screen,
      screen: makeScreenMaterial(screen.texture),
      feet: makeFeetMaterial(),
      ...Object.fromEntries(Object.keys(ITEM_TONES).map((tone) => [`item-${tone}`, makeItemVinyl(tone)])),
      pool: makePoolMaterial({ color: accent, strength: light.poolStrength, radius: assembly.pool.radius, toe }),
    };
  }, [accent, toe, w, h, rows, eyesKey, corePos]);
  useEffect(() => () => Object.values(mats).forEach((m) => m.dispose()), [mats]);

  const anim = useMemo(() => new Animator(gains), [gains]);
  const moving = Boolean(motion) && !paused && !itemOnly;
  const invalidate = useThree((s) => s.invalidate);
  const refs = useRef({ parts: [], feet: [], plumbs: [] }).current;
  const [leaving, setLeaving] = useState(null); // an item coming off
  const shown = useRef(null);
  refs.leavingCenter = leaving?.center ?? null;

  useLayoutEffect(() => {
    anim.setMoving(moving);
    if (!moving) setLeaving(null);
    invalidate();
  }, [anim, moving, invalidate]);

  // A new assembly or face is the event (`moving` is read as it is then).
  useLayoutEffect(() => {
    const prev = shown.current;
    shown.current = assembly;
    anim.setAssembly(assembly, expression);
    if (moving && prev?.outfit && prev.wearing !== assembly.wearing && prev.spec.tokenId === assembly.spec.tokenId) setLeaving(leavingOf(prev.outfit));
    invalidate();
  }, [anim, assembly, expression, invalidate]);

  useEffect(() => motion?.listen((name, opts) => anim.fire(name, opts)), [motion, anim]);

  // The point the eyes look from: the screen's middle, in the body's frame.
  const facePoint = useMemo(() => new THREE.Vector3().fromBufferAttribute(assembly.screen.attributes.position, 0), [assembly]);
  const scratch = useMemo(() => ({ v: new THREE.Vector3(), pull: { x: 0, y: 0 }, ...applyScratch() }), []);

  useFrame((state, delta) => {
    if (moving) {
      let pull = null;
      if (motion.pointer.active && refs.body) {
        // The pointer against the face on the canvas, in canvas heights.
        const f = scratch.v.copy(facePoint).applyMatrix4(refs.body.matrixWorld).project(state.camera);
        const { left, top, width, height } = state.size;
        const px = ((motion.pointer.x - left) / width) * 2 - 1;
        const py = 1 - ((motion.pointer.y - top) / height) * 2;
        const x = ((px - f.x) * 0.5 * width) / height / GAZE.reach;
        const y = ((py - f.y) * 0.5) / GAZE.reach;
        const length = Math.max(1, Math.hypot(x, y));
        scratch.pull.x = x / length;
        scratch.pull.y = y / length;
        pull = scratch.pull;
      }
      anim.step(delta * 1000, pull);
      if (leaving && anim.out.leaving < 0) setLeaving(null);
    }
    if (anim.dirty && !itemOnly) {
      apply(refs, anim, assembly, mats, scratch);
      anim.dirty = false;
    }
    refs.core.getWorldPosition(corePos.value);
  });

  const { body } = assembly;
  // Tone by tone, each tone's meshes in the order they were built: three.js
  // sorts meshes of one material by their bounding spheres' depth, and a
  // hanging part split off its tone would then draw at another time than it
  // did merged, and its seams' depth ties fall the other way (outfits.js).
  // Over 0 keeps the item after the body, as its materials' ids do.
  const drawOrder = (outfit, i) => 1 + Object.keys(ITEM_TONES).indexOf(outfit.meshes[i].tone) * outfit.meshes.length + i;
  const itemMeshes = (outfit, plumbs) =>
    outfit.meshes.map((m, i) =>
      m.hang && plumbs ? (
        // A hanging part in a group of its own: held plumb (plumb()).
        <group key={i} matrixAutoUpdate={false} userData={{ hang: m.hang }} ref={(g) => (plumbs[i] = g)}>
          <mesh geometry={m.geometry} material={mats[`item-${m.tone}`]} renderOrder={drawOrder(outfit, i)} />
        </group>
      ) : (
        <mesh key={i} geometry={m.geometry} material={mats[`item-${m.tone}`]} renderOrder={drawOrder(outfit, i)} />
      ),
    );
  const item = assembly.outfit && (
    <group position={assembly.outfit.position} rotation={assembly.outfit.rotation} ref={(g) => (refs.item = g)}>
      {itemMeshes(assembly.outfit, itemOnly ? null : refs.plumbs)}
    </group>
  );
  const core = <group ref={(g) => (refs.core = g)} position={assembly.coreLocal} />;
  if (itemOnly) {
    return (
      <group position={body.position} rotation={body.rotation} scale={body.scale}>
        {item}
        {core}
      </group>
    );
  }
  return (
    <group>
      {/* The whole pet's hop, squash and growth, about the ground. */}
      <group ref={(g) => (refs.hop = g)}>
        <group position={body.position} rotation={body.rotation} scale={body.scale} ref={(g) => (refs.body = g)}>
          <mesh geometry={body.geometry} material={mats.vinyl} />
          <mesh geometry={assembly.screen} material={mats.screen} />
          <mesh geometry={assembly.rim} material={mats.rimVinyl} />
          {/* Each part in a group of its own: its lag on its spring. */}
          {assembly.parts.map((p, i) => (
            <group key={i} ref={(g) => (refs.parts[i] = g)}>
              <mesh geometry={p.geometry} material={mats.vinyl} position={p.position} rotation={p.rotation} />
            </group>
          ))}
          <group ref={(g) => (refs.itemLag = g)}>{item}</group>
          {leaving && (
            <group position={leaving.outfit.position} rotation={leaving.outfit.rotation}>
              <group matrixAutoUpdate={false} ref={(g) => (refs.leaving = g)}>
                {itemMeshes(leaving.outfit, null)}
              </group>
            </group>
          )}
          {core}
          {/* The same core spills onto the feet and the ring; the opaque body
              itself only shows the light through the vinyl glow term. */}
          <pointLight position={assembly.coreLocal} color={accent} intensity={light.spill} decay={2} ref={(l) => (refs.light = l)} />
        </group>

        <group ref={(g) => (refs.allFeet = g)}>
          {assembly.feet.map((f, i) => (
            <group key={i} position={f.position} rotation-y={f.angle} ref={(g) => (refs.feet[i] = g)}>
              <mesh geometry={f.geometry} material={mats.feet} rotation-x={-FOOT.tilt} />
            </group>
          ))}
        </group>
      </group>

      <mesh
        geometry={assembly.pool.geometry}
        material={mats.pool}
        position={assembly.pool.position}
        rotation-x={-Math.PI / 2}
        renderOrder={-1}
        ref={(m) => (refs.pool = m)}
      />
    </group>
  );
}

// An item coming off, and its middle in its own frame (it shrinks about it).
function leavingOf(outfit) {
  const box = new THREE.Box3();
  for (const { geometry } of outfit.meshes) {
    geometry.computeBoundingBox();
    box.union(geometry.boundingBox);
  }
  return { outfit, center: box.getCenter(new THREE.Vector3()) };
}

const applyScratch = () => ({
  qNow: new THREE.Quaternion(),
  qRest: new THREE.Quaternion(),
  qItem: new THREE.Quaternion(),
  e: new THREE.Euler(),
  m: new THREE.Matrix4(),
  m2: new THREE.Matrix4(),
});

// Writes the animator's frame onto the pet. At rest every number is the
// assembly's own, so the pet is exactly its still.
function apply(r, anim, a, mats, s) {
  const o = anim.out;
  const p = o.pose;
  const across = 1 / Math.sqrt(1 - o.squash);
  r.hop.position.y = o.hopY;
  r.hop.scale.set(o.grow * across, o.grow * (1 - o.squash), o.grow * across);

  const breathAcross = 1 / Math.sqrt(o.breath);
  r.body.position.set(p[BODY], p[BODY + 1], p[BODY + 2]);
  r.body.rotation.set(p[BODY + 3] + o.pitch, p[BODY + 4] + o.yaw, p[BODY + 5] + o.sway, 'ZYX');
  r.body.scale.set(p[BODY + 6] * breathAcross * o.pop, p[BODY + 7] * o.breath * o.pop, p[BODY + 8] * breathAcross * o.pop);

  for (let i = 0; i < a.parts.length; i++) {
    const wrap = r.parts[i];
    const mesh = wrap.children[0];
    const at = PARTS + 6 * i;
    wrap.position.set(o.partOffset[3 * i], o.partOffset[3 * i + 1], o.partOffset[3 * i + 2]);
    mesh.position.set(p[at], p[at + 1], p[at + 2]);
    mesh.rotation.set(p[at + 3], p[at + 4], p[at + 5]);
    mesh.scale.setScalar(o.partScale[i]);
  }

  if (r.item) {
    r.item.position.set(p[ITEM], p[ITEM + 1], p[ITEM + 2]);
    r.item.rotation.set(p[ITEM + 3], p[ITEM + 4], p[ITEM + 5]);
    r.itemLag.position.set(o.itemOffset[0], o.itemOffset[1], o.itemOffset[2]);
    r.itemLag.visible = !o.itemHidden;
    plumb(r, anim, s);
  }
  const c = r.leavingCenter;
  if (r.leaving && c && o.leaving >= 0) {
    // Lifted and shrunk to nothing about its middle.
    const k = Math.max(1e-4, 1 - EASE.enter(o.leaving));
    const lift = (0.12 * a.bounds.top * o.leaving) / p[BODY + 7];
    r.leaving.matrix.makeTranslation(c.x, c.y + lift, c.z).multiply(s.m.makeScale(k, k, k)).multiply(s.m2.makeTranslation(-c.x, -c.y, -c.z));
    r.leaving.matrixWorldNeedsUpdate = true;
  }

  r.allFeet.scale.y = o.feet;
  for (let i = 0; i < a.feet.length; i++) {
    const top = p[footAt(a, i)];
    r.feet[i].position.y = top;
    r.feet[i].scale.y = top / a.feet[i].position[1];
  }

  r.core.position.set(p[LIGHT + 8], p[LIGHT + 9], p[LIGHT + 10]);
  r.light.position.copy(r.core.position);
  r.light.intensity = p[LIGHT + 2] * o.glow;
  mats.vinyl.userData.glow.uGlowStrength.value = p[LIGHT] * o.glow;
  mats.vinyl.userData.glow.uGlowRadius.value = p[LIGHT + 1];
  mats.rimVinyl.userData.glow.uGlowStrength.value = p[LIGHT] * o.glow;
  mats.rimVinyl.userData.glow.uGlowRadius.value = p[LIGHT + 1];
  r.pool.position.set(p[LIGHT + 6], a.pool.position[1], p[LIGHT + 7]);
  mats.pool.uniforms.uStrength.value = p[LIGHT + 3] * o.pool;
  mats.pool.uniforms.uRadius.value.set(p[LIGHT + 4] * o.poolRadius, p[LIGHT + 5] * o.poolRadius);

  const screen = mats.screenTexture;
  if (screen.key !== o.faceKey) {
    screen.paint(o.face.expression, o.face);
    screen.key = o.faceKey;
  }
}

// A hanging part hangs plumb: it was built plumb for the rest pose, so it is
// turned back about the point it hangs from by however far the item has
// turned from that pose (the sway, the gaze's turn, a droop on its way).
function plumb(r, anim, s) {
  const o = anim.out;
  const p = o.pose;
  const rest = anim.rest;
  s.qNow.setFromEuler(s.e.set(p[BODY + 3] + o.pitch, p[BODY + 4] + o.yaw, p[BODY + 5] + o.sway, 'ZYX'));
  s.qNow.multiply(s.qItem.setFromEuler(s.e.set(p[ITEM + 3], p[ITEM + 4], p[ITEM + 5], 'XYZ')));
  s.qRest.setFromEuler(s.e.set(rest[BODY + 3], rest[BODY + 4], rest[BODY + 5], 'ZYX'));
  s.qRest.multiply(s.qItem.setFromEuler(s.e.set(rest[ITEM + 3], rest[ITEM + 4], rest[ITEM + 5], 'XYZ')));
  s.qNow.invert().multiply(s.qRest);
  for (let i = 0; i < r.plumbs.length; i++) {
    const g = r.plumbs[i];
    if (!g) continue;
    if (!anim.moving) g.matrix.identity();
    else {
      const h = g.userData.hang;
      g.matrix.makeTranslation(h.x, h.y, h.z).multiply(s.m.makeRotationFromQuaternion(s.qNow)).multiply(s.m2.makeTranslation(-h.x, -h.y, -h.z));
    }
    g.matrixWorldNeedsUpdate = true;
  }
}
