// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { faceOf, PetFigure, useContextLoss } from './PetFigure';
import { setMotionPaused } from './motion';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The figure's browser parts are replaced where jsdom has none: no WebGL (the flat drawing is a spy), and the 3D scene
// as its props. What stays real is the figure's own choice: which face it hands each of them.
const seen = vi.hoisted(() => ({ webgl: false, flat: [] as Array<Record<string, unknown>>, pet: [] as Array<Record<string, unknown>> }));

vi.mock('./flat', async (original) => ({
  ...(await original<typeof import('./flat')>()),
  canUseWebGL: () => seen.webgl,
  drawFlat: (_canvas: unknown, options: Record<string, unknown>) => void seen.flat.push(options),
}));
vi.mock('./proto/Pet.jsx', () => ({
  Pet: (props: Record<string, unknown>) => {
    seen.pet.push(props);
    return null;
  },
}));
vi.mock('./proto/AlphaFromLight.js', () => ({ AlphaFromLight: () => null }));
vi.mock('@react-three/fiber', () => ({
  Canvas: ({ children }: { children?: ReactNode }) => <>{children}</>,
  useFrame: () => undefined,
  useThree: (select: (s: unknown) => unknown) =>
    select({
      camera: { position: { set: () => undefined }, lookAt: () => undefined, updateProjectionMatrix: () => undefined },
      size: { width: 1, height: 1 },
      invalidate: () => undefined,
    }),
}));
vi.mock('@react-three/drei', () => ({ Environment: () => null, Lightformer: () => null, PerformanceMonitor: () => null }));
vi.mock('@react-three/postprocessing', () => ({ Bloom: () => null, EffectComposer: () => null, ToneMapping: () => null }));
vi.mock('postprocessing', () => ({ ToneMappingMode: { NEUTRAL: 0 } }));

class StillObserver {
  observe() {}
  disconnect() {}
}
globalThis.ResizeObserver = StillObserver as unknown as typeof ResizeObserver;

function Watch({ canvas, onLost }: { canvas: HTMLCanvasElement; onLost: () => void }) {
  const watch = useContextLoss(onLost);
  watch(canvas);
  return null;
}

let root: Root | null = null;

async function show(node: ReactNode) {
  root ??= createRoot(document.createElement('div'));
  await act(async () => root!.render(node));
}

beforeEach(() => {
  seen.flat.length = 0;
  seen.pet.length = 0;
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  localStorage.clear();
  setMotionPaused(false);
});

// spec: add-pet › Pet screen › WebGL недоступен
it('WebGL недоступен: a context lost on a standing figure tells the page; the loss R3F forces on an unmounted canvas does not', async () => {
  const canvas = document.createElement('canvas');
  const onLost = vi.fn();
  const own = createRoot(document.createElement('div'));
  await act(async () => own.render(<Watch canvas={canvas} onLost={onLost} />));

  canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
  expect(onLost).toHaveBeenCalledTimes(1);

  await act(async () => own.unmount());
  canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
  expect(onLost).toHaveBeenCalledTimes(1);
});

// spec: add-pet-life › Mood rule › радостный
it('only a Full pet in a calm mood takes another face; every other state and mood keeps its own', () => {
  expect(faceOf('full', 'calm')).toBe('calm');
  expect(faceOf('full', 'happy')).toBeUndefined();
  expect(faceOf('full', undefined)).toBeUndefined();
  expect(faceOf('full', null)).toBeUndefined();
  for (const state of ['hungry', 'asleep', 'thinking', 'waking'] as const) {
    expect(faceOf(state, 'calm')).toBeUndefined();
    expect(faceOf(state, 'sleepy')).toBeUndefined();
  }
});

// spec: add-pet-life › Pet life display rule › владелец × no WebGL
it('no WebGL: the flat drawing takes the mood\'s face, and the new one when the mood changes', async () => {
  seen.webgl = false;
  await show(<PetFigure tokenId="9" name="Pixel" state="full" stage="adult" mood="calm" />);
  expect(seen.flat.at(-1)).toMatchObject({ tokenId: '9', state: 'full', face: 'calm' });

  await show(<PetFigure tokenId="9" name="Pixel" state="full" stage="adult" mood="happy" />);
  expect(seen.flat.at(-1)).toMatchObject({ state: 'full', face: undefined });

  await show(<PetFigure tokenId="9" name="Pixel" state="hungry" stage="adult" mood="calm" />);
  expect(seen.flat.at(-1)).toMatchObject({ state: 'hungry', face: undefined });
  expect(seen.pet).toHaveLength(0);
});

// spec: add-pet-life › Mood rule › радостный × Pause motion
it('Pause motion: the pet stands and the face still changes', async () => {
  seen.webgl = true;
  setMotionPaused(true);
  await show(<PetFigure tokenId="9" name="Pixel" state="full" stage="adult" mood="calm" />);
  expect(seen.pet.at(-1)).toMatchObject({ paused: true, face: 'calm' });

  await show(<PetFigure tokenId="9" name="Pixel" state="full" stage="adult" mood="happy" />);
  expect(seen.pet.at(-1)).toMatchObject({ paused: true, face: undefined });
  expect(seen.flat).toHaveLength(0);
});

// spec: add-pet-life › Pet life display rule › владелец × no WebGL
it('a caller with no mood is unchanged: no face is handed to either figure', async () => {
  seen.webgl = true;
  await show(<PetFigure tokenId="9" name="Pixel" state="full" stage="adult" />);
  expect(seen.pet.at(-1)).toMatchObject({ paused: false, face: undefined });
  seen.webgl = false;
  await act(async () => root?.unmount());
  root = null;
  await show(<PetFigure tokenId="9" name="Pixel" state="full" stage="adult" />);
  expect(seen.flat.at(-1)).toMatchObject({ face: undefined });
});
