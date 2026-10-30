import { useLayoutEffect, useMemo, useRef } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Environment, Lightformer, OrbitControls } from '@react-three/drei';
import { Bloom, EffectComposer, ToneMapping } from '@react-three/postprocessing';
import { ToneMappingMode } from 'postprocessing';
import { AlphaFromLight } from './AlphaFromLight.js';
import { assemblePet, frameFor } from './assemble.js';
import { Pet } from './Pet.jsx';

// Turntable angles: the pet turns, the camera and the studio stay put.
export const ANGLES = {
  front: 0,
  'three-quarter': Math.PI / 4,
  side: Math.PI / 2,
};

const FOV = 26;
const ELEVATION = (9 * Math.PI) / 180;

// Soft studio light built locally (no HDR download): a big soft box above,
// a key from the front left, a weaker fill on the right, a rim from behind.
// `tile`: an item alone for its wardrobe tile also gets a soft box below it
// in front, a floor's bounce, so a black item's lower edges catch a rim of
// light and its outline closes on the dark tile (the bow tie's wings read as
// a hole in it); a pet never.
function Studio({ tile = false }) {
  return (
    <>
      <Environment resolution={256} environmentIntensity={1}>
        <Lightformer form="rect" intensity={1.1} position={[0, 6, 1]} rotation-x={Math.PI / 2} scale={[6, 6, 1]} />
        <Lightformer form="rect" intensity={2.6} position={[-5, 3, 4]} target={[0, 1, 0]} scale={[4, 4, 1]} />
        <Lightformer form="rect" intensity={0.45} position={[5, 1.5, 3]} target={[0, 1, 0]} scale={[3, 4, 1]} />
        <Lightformer form="rect" intensity={2.4} position={[0, 2, -6]} target={[0, 1, 0]} scale={[10, 2.5, 1]} />
        {tile && <Lightformer form="rect" intensity={2} position={[0, -5, 3]} target={[0, 1, 0]} scale={[8, 8, 1]} />}
      </Environment>
      <directionalLight position={[-3, 5, 4]} intensity={0.8} />
    </>
  );
}

function Framing({ frame }) {
  const camera = useThree((s) => s.camera);
  useLayoutEffect(() => {
    const { centerY, radius, shiftX = 0 } = frame;
    const d = (radius * 1.06) / Math.sin(((FOV / 2) * Math.PI) / 180);
    camera.position.set(0, centerY + d * Math.sin(ELEVATION), d * Math.cos(ELEVATION));
    camera.lookAt(0, centerY, 0);
    // A still centres its pet by sliding the picture (shiftX: a fraction of
    // its width) rather than by moving or turning the camera.
    if (shiftX) camera.setViewOffset(camera.aspect, 1, shiftX * camera.aspect, 0, camera.aspect, 1);
    else camera.clearViewOffset();
    camera.updateProjectionMatrix();
  }, [camera, frame]);
  return null;
}

// Post chain on the linear HDR frame: bloom only what is brighter than white
// (the core light; the vinyl and the eyes stay under the threshold), then the
// Neutral tone mapping the renderer used before, then alpha from the light.
// A dim state falls under the threshold by itself.
function Post() {
  return (
    <EffectComposer multisampling={4}>
      <Bloom mipmapBlur luminanceThreshold={1.5} luminanceSmoothing={0.3} intensity={1} radius={0.42} />
      <ToneMapping mode={ToneMappingMode.NEUTRAL} />
      <AlphaFromLight />
    </EffectComposer>
  );
}

// Tells scripts/stills.mjs this canvas has drawn a few full frames, and hands
// the canvas to `onReady` (the sheet snapshots it).
function ReadySignal({ onReady }) {
  const frames = useRef(0);
  const canvas = useThree((s) => s.gl.domElement);
  useFrame((state) => {
    frames.current += 1;
    if (frames.current < 8) state.invalidate(); // a paused canvas draws on demand
    if (frames.current === 8) {
      onReady?.(canvas);
      window.__petReady = (window.__petReady ?? 0) + 1;
    }
  });
  return null;
}

// `frame` sets the camera from outside: a sheet's shared one (frameFor) or a
// still's own fit (scripts/stills.mjs); without it the camera fits this pet
// alone. `hue`, `gains` and `face` override the pet's own (Pet.jsx).
// `stage`: baby | teen | adult (generator.js › grow). `outfit`: an outfits.js
// slug or 'none'; `itemOnly`: the item alone (Pet.jsx).
// `motion` (useMotion.js › usePetMotion) puts the pet in motion unless
// `paused`; paused, the canvas draws only when something changes.
export function PetCanvas({ seed, state = 'full', stage = 'adult', outfit = 'none', itemOnly = false, angle = 'front', orbit = false, frame, hue, gains, face, motion, paused = false, onReady }) {
  const assembly = useMemo(() => assemblePet(seed, state, stage, outfit, itemOnly), [seed, state, stage, outfit, itemOnly]);
  const view = useMemo(() => frame ?? frameFor([assembly]), [frame, assembly]);
  return (
    <Canvas
      gl={{ alpha: true, preserveDrawingBuffer: true }}
      dpr={[1, 2]}
      camera={{ fov: FOV, near: 0.1, far: 100 }}
      frameloop={motion && paused ? 'demand' : 'always'}
    >
      <Studio tile={itemOnly} />
      <group rotation-y={ANGLES[angle]}>
        {itemOnly ? (
          <group position={[-assembly.itemFrame.center[0], 0, -assembly.itemFrame.center[2]]}>
            <Pet assembly={assembly} hue={hue} gains={gains} face={face} itemOnly />
          </group>
        ) : (
          <Pet assembly={assembly} hue={hue} gains={gains} face={face} motion={motion} paused={paused} />
        )}
      </group>
      <Framing frame={view} />
      {orbit && <OrbitControls target={[0, view.centerY, 0]} enablePan={false} />}
      <Post />
      <ReadySignal onReady={onReady} />
    </Canvas>
  );
}
