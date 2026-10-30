import { Environment, Lightformer, PerformanceMonitor } from '@react-three/drei';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Bloom, EffectComposer, ToneMapping } from '@react-three/postprocessing';
import { ToneMappingMode } from 'postprocessing';
import { Component, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentType, type ReactNode } from 'react';
import { cx } from '../ds/util';
import { fakeState, recordCall } from '../seams/fakes';
import { canUseWebGL, drawFlat, type PetStageName, type PetState } from './flat';
import { useMotionPaused } from './motion';
import { AlphaFromLight } from './proto/AlphaFromLight.js';
import { assemblePet } from './proto/assemble.js';
import { Pet } from './proto/Pet.jsx';
import { usePetMotion } from './proto/useMotion.js';

// The DS's `Pet` (design/ds/components.js) for the live client: the 3D pet of the prototype (Pet.jsx, animator.js,
// assemble.js, materials.js, face.js — proto/, unchanged) in one canvas, or the flat drawing when this browser has no
// WebGL or loses its context. The studio light and the post chain are PetCanvas.jsx's, kept in step by hand: PetCanvas
// keeps the drawing buffer for the stills, offers an orbit and a square frame, none of which the game wants. One
// canvas, `frameloop="demand"`, no `preserveDrawingBuffer`: frames are asked for only while the pet plays. The choice
// to play is `motion.ts`, not the prototype's own `useMotionPaused`.

const FOV = 26;
const ELEVATION = (9 * Math.PI) / 180;
const THREE_QUARTER = Math.PI / 4; // the stills' view
const FIT = 1.25; // room around the silhouette for the light on the ground
const POOL_REACH = 2.2; // the pool's light ends at this many radii (materials.js › makePoolMaterial)
// the near edge of the pool stands closer to the camera than the pet, and draws larger
const POOL_NEAR = 1.25;
// The canvas is this much larger than the figure's box, around it: the box is what the page lays out and what the pet
// fills, as a still; its light fades out on the way to the canvas's edge, over whatever stands beside (the canvas is
// transparent and takes no pointer).
export const BLEED = 1.5;
const CANVAS_STYLE = { position: 'absolute', inset: `${((1 - BLEED) / 2) * 100}%`, width: 'auto', height: 'auto', pointerEvents: 'none' } as const;

/** The handle a screen gives its pet (useMotion.js › usePetMotion): `fire('talk', { ms })`, and the pointer. */
export type PetHub = ReturnType<typeof usePetMotion>;
const MovingPet = Pet as unknown as ComponentType<{ assembly: unknown; motion: PetHub | null; paused: boolean }>;

/** e2e and screens only: `hold` keeps every pet on its still, so software GL is not starved by pages that test
 *  something else. The motion spec plays it. */
export const petHeld = () => import.meta.env.VITE_FAKES === 'true' && fakeState().pet?.hold === true;

function subscribeHidden(onChange: () => void): () => void {
  document.addEventListener('visibilitychange', onChange);
  return () => document.removeEventListener('visibilitychange', onChange);
}
const useTabHidden = () => useSyncExternalStore(subscribeHidden, () => document.hidden, () => false);

/** Whether the pet moves now: the viewer's choice (or the system's request), and a tab somebody can see. */
function usePetPlaying(): boolean {
  const [paused] = useMotionPaused();
  const hidden = useTabHidden();
  return !paused && !hidden && !petHeld();
}

const STATE_WORD: Record<PetState, string> = { full: 'full', hungry: 'hungry', asleep: 'asleep', thinking: 'thinking', waking: 'waking up' };

export interface PetFigureProps {
  /** the token_id: the seed of the pet's form and hue */
  tokenId: string;
  name: string;
  state?: PetState;
  stage?: PetStageName;
  /** the outfit's slug and its name for the alt (add-wardrobe) */
  outfit?: string;
  wearing?: string;
  size?: 'hero' | 'md' | 'sm';
  /** the name stands beside it: the picture is `alt=""` */
  decorative?: boolean;
  /** the lost context, when the screen keeps it: the figure is remounted when the screen's layout around it changes
   *  (the flat drawing has no «Pause motion»), and a figure that forgot would try WebGL again */
  lost?: boolean;
  onLost?: () => void;
  /** the screen's handle, when it has moments of its own to fire (a reply landing) */
  hub?: PetHub;
  /** the newborn's first show: the pet is born on the screen (`Birth flow` › «вылупился») */
  birth?: boolean;
}

function Studio() {
  return (
    <>
      <Environment resolution={256} environmentIntensity={1}>
        <Lightformer form="rect" intensity={1.1} position={[0, 6, 1]} rotation-x={Math.PI / 2} scale={[6, 6, 1]} />
        <Lightformer form="rect" intensity={2.6} position={[-5, 3, 4]} target={[0, 1, 0]} scale={[4, 4, 1]} />
        <Lightformer form="rect" intensity={0.45} position={[5, 1.5, 3]} target={[0, 1, 0]} scale={[3, 4, 1]} />
        <Lightformer form="rect" intensity={2.4} position={[0, 2, -6]} target={[0, 1, 0]} scale={[10, 2.5, 1]} />
      </Environment>
      <directionalLight position={[-3, 5, 4]} intensity={0.8} />
    </>
  );
}

// The camera for the canvas around the figure's box: the stills are cropped to the silhouette, so the pet fills the box's
// height (or its width, when it is wide) — a baby stands as large in its box as a grown-up in its own — and the light it
// spreads on the ground fades out inside the canvas, never at its edge. `top` is the pet's height, `width34` its width at
// the three-quarter view (assemble.js › bounds); the pool is an ellipse on the ground, turned with the pet.
interface Framed {
  bounds: { top: number; width34: number };
  pool: { radius: number[]; position: number[] };
}

export function frameOf({ bounds, pool }: Framed, aspect: number): { centerY: number; half: number } {
  const [rx = 0, rz = 0] = pool.radius;
  const [px = 0, , pz = 0] = pool.position;
  const across = Math.SQRT1_2;
  const reach = POOL_REACH * Math.hypot(rx * across, rz * across);
  const reachX = reach + Math.abs(px + pz) * across;
  const reachZ = reach + Math.abs(pz - px) * across;
  const below = reachZ * Math.sin(ELEVATION) * POOL_NEAR;
  // a little under the middle: the light spreads on the ground below the feet
  const centerY = bounds.top * 0.47;
  const box = Math.max(bounds.top / 2, bounds.width34 / 2 / aspect) * FIT * BLEED;
  return { centerY, half: Math.max(box, centerY + below, reachX / aspect) };
}

function Framing({ frame }: { frame: Framed }) {
  const camera = useThree((s) => s.camera);
  const aspect = useThree((s) => s.size.width / Math.max(1, s.size.height));
  useLayoutEffect(() => {
    const { centerY, half } = frameOf(frame, aspect);
    const d = half / Math.sin(((FOV / 2) * Math.PI) / 180);
    camera.position.set(0, centerY + d * Math.sin(ELEVATION), d * Math.cos(ELEVATION));
    camera.lookAt(0, centerY, 0);
    camera.updateProjectionMatrix();
  }, [camera, frame, aspect]);
  return null;
}

// Bloom only what is brighter than white (the core light), then the Neutral tone mapping, then alpha from the light. A
// phone that can't keep up loses the multisampling, then the Bloom (`web-client` › Rendering budget).
function Post({ level }: { level: number }) {
  return (
    <EffectComposer multisampling={level >= 2 ? 0 : 4}>
      {level >= 3 ? <></> : <Bloom mipmapBlur luminanceThreshold={1.5} luminanceSmoothing={0.3} intensity={1} radius={0.42} />}
      <ToneMapping mode={ToneMappingMode.NEUTRAL} />
      <AlphaFromLight />
    </EffectComposer>
  );
}

// `frameloop="demand"`: while the pet plays, each frame asks for the next. On pause, on reduced motion and in a hidden
// tab nothing asks, and no frame is drawn.
function Ticker({ playing, hub }: { playing: boolean; hub: PetHub }) {
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => {
    if (playing) invalidate();
  }, [playing, invalidate]);
  useEffect(() => {
    if (import.meta.env.VITE_FAKES !== 'true') return undefined;
    const stop = hub.listen((name: string) => recordCall(`pet:${name}`));
    return () => void stop();
  }, [hub]);
  useFrame(() => {
    if (playing) invalidate();
    if (import.meta.env.VITE_FAKES === 'true') {
      const g = globalThis as { __nearlingFrames?: number };
      g.__nearlingFrames = (g.__nearlingFrames ?? 0) + 1;
    }
  });
  return null;
}

/** Fires a moment once the pet below it is listening. */
function Moment({ hub, name }: { hub: PetHub; name: 'birth' }) {
  useEffect(() => hub.fire(name), [hub, name]);
  return null;
}

// e2e and screens only (VITE_FAKES): `__nearlingFreeze()` resolves once every pet on the page has drawn a few full
// frames, so a capture never catches an empty canvas. A capture holds its pets on their stills (`pet.hold`).
const drawn = new Set<Promise<void>>();
if (import.meta.env.VITE_FAKES === 'true') {
  (globalThis as { __nearlingFreeze?: () => Promise<void> }).__nearlingFreeze = async () => {
    await Promise.all(drawn);
  };
}

/** A scene that throws (no WebGL 2 after all, a broken asset) must not take the page down: the screen goes on without
 *  it. `onFail` is the same way out as a lost context. */
class FigureBoundary extends Component<{ onFail: () => void; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(): void {
    this.props.onFail();
  }

  override render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

function ReadySignal({ onReady }: { onReady: () => void }) {
  const frames = useRef(0);
  const quiet = useRef<ReturnType<typeof setTimeout>>(undefined);
  const invalidate = useThree((s) => s.invalidate);
  // `frameloop="demand"` draws only when asked: the capture asks for frames until the pet has had them
  useEffect(() => {
    const keep = setInterval(() => {
      if (frames.current < 10) invalidate();
    }, 100);
    return () => {
      clearInterval(keep);
      clearTimeout(quiet.current);
    };
  }, [invalidate]);
  useFrame(() => {
    frames.current += 1;
    // the studio light (drei's Environment) is built a moment after the first frames and draws again when it is
    // ready: the pet is ready when frames stop for a while
    clearTimeout(quiet.current);
    if (frames.current >= 3) quiet.current = setTimeout(onReady, 500);
  });
  return null;
}

/** What a falling frame rate takes away, one step at a time: the pixel ratio, the multisampling, the Bloom. */
const MOST_DECLINED = 3;

function Scene3D({
  tokenId,
  state,
  stage,
  outfit,
  hub,
  birth,
  onLost,
}: Required<Pick<PetFigureProps, 'tokenId' | 'state' | 'stage'>> & { outfit: string; hub: PetHub; birth: boolean; onLost: () => void }) {
  const [level, setLevel] = useState(0);
  const [paused] = useMotionPaused();
  const playing = usePetPlaying();
  const assembly = useMemo(() => assemblePet(tokenId, state, stage, outfit), [tokenId, state, stage, outfit]);
  // One camera through the pet's states: it does not jump when the pet droops or falls asleep.
  const framed = useMemo(() => assemblePet(tokenId, 'full', stage, outfit), [tokenId, stage, outfit]);
  // the capture waits for this figure (a promise made in an effect, not a memo: a double-run memo under StrictMode would
  // leave one that nobody resolves)
  const resolveReady = useRef<() => void>(() => undefined);
  useEffect(() => {
    const promise = new Promise<void>((resolve) => {
      resolveReady.current = resolve;
    });
    drawn.add(promise);
    return () => void drawn.delete(promise);
  }, [assembly]);
  return (
    <Canvas
      frameloop="demand"
      gl={{ alpha: true }}
      style={CANVAS_STYLE}
      dpr={[1, level >= 1 ? 1 : 2]}
      camera={{ fov: FOV, near: 0.1, far: 100 }}
      onCreated={({ gl }) => {
        gl.domElement.addEventListener('webglcontextlost', (e) => {
          e.preventDefault();
          onLost();
        });
      }}
      data-motion={paused ? 'paused' : 'playing'}
    >
      <PerformanceMonitor onDecline={() => setLevel((l) => Math.min(MOST_DECLINED, l + 1))} onIncline={() => setLevel((l) => Math.max(0, l - 1))} />
      <Studio />
      <group rotation-y={THREE_QUARTER}>
        <MovingPet assembly={assembly} motion={hub} paused={!playing} />
      </group>
      <Ticker playing={playing} hub={hub} />
      {birth ? <Moment hub={hub} name="birth" /> : null}
      <Framing frame={framed} />
      <Post level={level} />
      {import.meta.env.VITE_FAKES === 'true' ? <ReadySignal onReady={() => resolveReady.current()} /> : null}
    </Canvas>
  );
}

function FlatScene({ tokenId, state, stage, outfit }: Required<Pick<PetFigureProps, 'tokenId' | 'state' | 'stage'>> & { outfit: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    const canvas = ref.current;
    if (!canvas) return undefined;
    const draw = () => {
      const scale = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(1, Math.round(canvas.clientWidth * scale));
      const h = Math.max(1, Math.round(canvas.clientHeight * scale));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      drawFlat(canvas, { tokenId, stage, state, outfit });
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [tokenId, state, stage, outfit]);
  return <canvas ref={ref} className="pet-figure__canvas" />;
}

export function PetFigure({ tokenId, name, state = 'full', stage = 'adult', outfit, wearing, size = 'hero', decorative, lost: lostProp, onLost, hub, birth = false }: PetFigureProps) {
  // Flat from the start when WebGL can't be had, and from the moment the one context is lost or the scene fails; the
  // actions around the pet work either way.
  const [ownLost, setOwnLost] = useState(false);
  const ownHub = usePetMotion();
  const flat = (lostProp ?? ownLost) || !canUseWebGL();
  const alt = decorative ? '' : `${name}, ${STATE_WORD[state]}${wearing ? `, wearing the ${wearing}` : ''}`;
  const slug = outfit ?? 'none';
  const lose = () => {
    setOwnLost(true);
    onLost?.();
  };
  return (
    <div className={cx('ds-pet', `ds-pet--${size}`, 'pet-figure', `pet-figure--${size}`)} data-illustration="" data-view={flat ? 'flat' : '3d'}>
      <div className="pet-figure__box" role={decorative ? undefined : 'img'} aria-label={decorative ? undefined : alt} aria-hidden={decorative || undefined}>
        {flat ? (
          <FigureBoundary key="flat" onFail={() => undefined}>
            <FlatScene tokenId={tokenId} state={state} stage={stage} outfit={slug} />
          </FigureBoundary>
        ) : (
          <FigureBoundary key="3d" onFail={lose}>
            <Scene3D tokenId={tokenId} state={state} stage={stage} outfit={slug} hub={hub ?? ownHub} birth={birth} onLost={lose} />
          </FigureBoundary>
        )}
      </div>
    </div>
  );
}
