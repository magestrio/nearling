import { Environment, Lightformer, PerformanceMonitor } from '@react-three/drei';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Bloom, EffectComposer, ToneMapping } from '@react-three/postprocessing';
import { ToneMappingMode } from 'postprocessing';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import { AlphaFromLight } from './proto/AlphaFromLight.js';
import { assemblePet } from './proto/assemble.js';
import { Pet } from './proto/Pet.jsx';
import { usePetMotion } from './proto/useMotion.js';
import { fakeState } from '../seams/fakes';
import { ELEVATION, ReadySignal, registerPetDraw, useContextLoss } from './PetFigure';
import { stillOf } from './meadowStills';
import { MEADOW_HOPS_PER_BURST, MEADOW_HOP_SECONDS, MEADOW_REST_SECONDS, MEADOW_SPEED_PX_SECOND } from '../ds/meadowMotion';
import type { Group, Material, Mesh, Object3D, ShaderMaterial } from 'three';

export type MeadowPet = {
  seed: number;
  stage: 'baby' | 'teen' | 'adult';
  state: 'full' | 'hungry' | 'asleep';
  outfit?: string;
  view: 'three-quarter';
  x: number;
  depth: number;
  flip?: boolean;
  wide?: boolean;
};
const MovingPet = Pet as unknown as ComponentType<{ assembly: unknown; motion: ReturnType<typeof usePetMotion>; paused: boolean }>;

type Hub = ReturnType<typeof usePetMotion>;
function petHub(pointer: Hub['pointer']): Hub {
  const listeners = new Set<(name: string, opts?: unknown) => void>();
  return {
    pointer,
    fire: (name, opts) => listeners.forEach((listener) => listener(name, opts)),
    listen: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
  } as Hub;
}

const COS = Math.cos(ELEVATION);
const SIN = Math.sin(ELEVATION);

function token(name: string, fallback: number): number {
  const value = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name));
  return Number.isFinite(value) ? value : fallback;
}

// DS Meadow: an asleep pet is its still dimmed further by `brightness-asleep` and `saturate-asleep`. One canvas draws every
// pet, so the same grade goes into the asleep pet's own materials, at the end of their fragment shaders. The DS filter acts on
// the sRGB result and the shaders write linear light, hence the power on the brightness.
function dimAsleep(root: Object3D): void {
  const brightness = token('--brightness-asleep', 0.62) ** 2.2;
  const saturate = token('--saturate-asleep', 0.55);
  const grade = [
    'float asleepLuma = dot(gl_FragColor.rgb, vec3(0.2126, 0.7152, 0.0722));',
    `gl_FragColor.rgb = mix(vec3(asleepLuma), gl_FragColor.rgb, ${saturate.toFixed(3)}) * ${brightness.toFixed(3)};`,
  ].join('\n');
  const seen = new Set<Material>();
  root.traverse((object) => {
    const held = (object as Mesh).material as Material | Material[] | undefined;
    for (const material of held ? (Array.isArray(held) ? held : [held]) : []) {
      if (seen.has(material)) continue;
      seen.add(material);
      if ((material as ShaderMaterial).isShaderMaterial) {
        const shader = material as ShaderMaterial;
        shader.fragmentShader = shader.fragmentShader.replace(/\}\s*$/, `${grade}\n}`);
      } else {
        const before = material.onBeforeCompile.bind(material);
        const key = material.customProgramCacheKey.bind(material);
        material.onBeforeCompile = (shader, renderer) => {
          before(shader, renderer);
          shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>', `#include <opaque_fragment>\n${grade}`);
        };
        material.customProgramCacheKey = () => `${key()}-asleep`;
      }
      material.needsUpdate = true;
    }
  });
}

// The ten samples share one WebGL context. The ground's CSS coordinates are the source of their size and position;
// one orthographic world unit is 100 CSS pixels, so the model's generated height can be fitted to the DS size.
function Sample({ pet, width, height, rem, playing, motion, index }: {
  pet: MeadowPet; width: number; height: number; rem: number; playing: boolean; motion: Hub; index: number;
}) {
  const assembly = useMemo(() => assemblePet(String(pet.seed), pet.state, pet.stage, pet.outfit ?? 'none'), [pet]);
  const desktop = width >= 768;
  const hub = useMemo(() => petHub(desktop ? motion.pointer : { x: 0, y: 0, active: false }), [motion, desktop]);
  const group = useRef<Group>(null);
  const travel = useRef({ x: pet.x, direction: pet.flip ? -1 : 1, until: (index % 4) * MEADOW_HOP_SECONDS, movingUntil: 0, left: MEADOW_HOPS_PER_BURST });
  const stage = pet.stage === 'baby' ? 0.7 : pet.stage === 'teen' ? 0.85 : 1;
  // The frames draw the still in a box of the DS height whose bottom edge stands at `top` of the ground; the pet is the still's
  // `height` of it, its feet at `feet` (meadowStills.ts), so the 3D pet takes the same body, not the box.
  const size = Math.min(rem * (width >= 768 ? 10 : 7), height * 0.42) * stage * (0.62 + 0.38 * pet.depth);
  const still = stillOf(pet);
  const scale = (size * still.height) / (100 * assembly.bounds.top * COS);
  const boxWidth = size * still.aspect;
  const worldX = (x: number) => (x * width + (0.5 - x) * boxWidth - width / 2) / 100;
  const feetY = (0.3 + 0.66 * pet.depth) * height - size * (1 - still.feet);
  // the camera looks down by ELEVATION (the ground's light shows): a point's screen height is y·cos − z·sin
  const worldY = ((0.5 * height - feetY) / 100 + pet.depth * SIN) / COS;
  useLayoutEffect(() => {
    if (pet.state === 'asleep' && group.current) dimAsleep(group.current);
  }, [pet.state, assembly]);
  useFrame((state, delta) => {
    if (!playing || pet.state === 'asleep' || !group.current) return;
    const t = travel.current;
    const interval = MEADOW_HOP_SECONDS * (pet.state === 'hungry' ? 2 : 1);
    if (state.clock.elapsedTime >= t.until) {
      hub.fire('hop', { height: pet.state === 'hungry' ? 0.015 : 0.03 });
      t.movingUntil = state.clock.elapsedTime + MEADOW_HOP_SECONDS;
      t.left -= 1;
      t.until = state.clock.elapsedTime + (t.left === 0 ? MEADOW_REST_SECONDS + (index % 3) * MEADOW_HOP_SECONDS : interval);
      if (t.left === 0) t.left = MEADOW_HOPS_PER_BURST;
    }
    const pace = MEADOW_SPEED_PX_SECOND * (0.62 + 0.38 * pet.depth) * (pet.state === 'hungry' ? 0.5 : 1);
    if (state.clock.elapsedTime < t.movingUntil) t.x += t.direction * pace * Math.min(delta, MEADOW_HOP_SECONDS) / width;
    if (t.x > 0.97 || t.x < 0.03) { t.x = Math.max(0.03, Math.min(0.97, t.x)); t.direction *= -1; }
    group.current.position.x = worldX(t.x);
    group.current.rotation.y = t.direction < 0 ? -Math.PI / 4 : Math.PI / 4;
  });
  return (
    <group
      ref={group}
      position={[worldX(pet.x), worldY, pet.depth]}
      rotation-y={pet.flip ? -Math.PI / 4 : Math.PI / 4}
      scale={scale}
    >
      <MovingPet assembly={assembly} motion={hub} paused={!playing} />
    </group>
  );
}

function Tick({ playing }: { playing: boolean }) {
  const invalidate = useThree((state) => state.invalidate);
  useEffect(() => { if (playing) invalidate(); }, [playing, invalidate]);
  useFrame(() => { if (playing) invalidate(); });
  return null;
}

function CaptureReady() {
  const resolve = useRef<() => void>(() => undefined);
  useEffect(() => {
    const promise = new Promise<void>((done) => { resolve.current = done; });
    return registerPetDraw(promise);
  }, []);
  return <ReadySignal onReady={() => resolve.current()} />;
}

export function MeadowScene({ pets, width, height, rem, paused, onLost }: {
  pets: MeadowPet[]; width: number; height: number; rem: number; paused: boolean; onLost: () => void;
}) {
  const motion = usePetMotion();
  const hidden = useRef(document.hidden);
  const [visible, setVisible] = useState(!document.hidden);
  const [level, setLevel] = useState(0);
  const watchContext = useContextLoss(onLost);
  const held = import.meta.env.VITE_FAKES === 'true' && fakeState().pet?.hold === true;
  const playing = !paused && visible && !held;
  useEffect(() => {
    const change = () => { hidden.current = document.hidden; setVisible(!hidden.current); };
    document.addEventListener('visibilitychange', change);
    return () => document.removeEventListener('visibilitychange', change);
  }, []);
  return (
    <Canvas
      className="ds-meadow__canvas"
      orthographic
      camera={{ position: [0, 30 * SIN, 30 * COS], zoom: 100, near: 0.1, far: 100 }}
      onCreated={({ gl, camera }) => {
        camera.lookAt(0, 0, 0);
        watchContext(gl.domElement);
      }}
      frameloop="demand"
      dpr={[1, level > 0 ? 1 : 2]}
      gl={{ alpha: true }}
    >
      <PerformanceMonitor onDecline={() => setLevel((n) => Math.min(3, n + 1))} onIncline={() => setLevel((n) => Math.max(0, n - 1))} />
      <Environment resolution={256} environmentIntensity={1}>
        <Lightformer form="rect" intensity={1.1} position={[0, 6, 1]} rotation-x={Math.PI / 2} scale={[6, 6, 1]} />
        <Lightformer form="rect" intensity={2.6} position={[-5, 3, 4]} target={[0, 1, 0]} scale={[4, 4, 1]} />
        <Lightformer form="rect" intensity={0.45} position={[5, 1.5, 3]} target={[0, 1, 0]} scale={[3, 4, 1]} />
        <Lightformer form="rect" intensity={2.4} position={[0, 2, -6]} target={[0, 1, 0]} scale={[10, 2.5, 1]} />
      </Environment>
      <directionalLight position={[-3, 5, 4]} intensity={0.8} />
      {pets.filter((pet) => width >= 768 || !pet.wide).map((pet, index) => (
        <Sample key={index} index={index} pet={pet} width={width} height={height} rem={rem} playing={playing} motion={motion} />
      ))}
      <Tick playing={playing} />
      {import.meta.env.VITE_FAKES === 'true' ? <CaptureReady /> : null}
      <EffectComposer multisampling={level >= 2 ? 0 : 4}>
        {level < 3 ? <Bloom mipmapBlur luminanceThreshold={1.5} luminanceSmoothing={0.3} intensity={1} radius={0.42} /> : <></>}
        <ToneMapping mode={ToneMappingMode.NEUTRAL} />
        <AlphaFromLight />
      </EffectComposer>
    </Canvas>
  );
}
