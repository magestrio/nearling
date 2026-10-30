// The pet without WebGL (add-pet › Pet screen › «WebGL недоступен»): a flat drawing on a Canvas 2D from the same
// data as the 3D pet — the prototype's flat.js, ported unchanged in proto/, which reads the assembly through the stills'
// camera and takes the face from makeScreenTexture. It draws on a canvas the caller gives it, stores nothing and
// sends nothing: no network, no storage, no pixels leave the page.
import { drawFlatPet } from './proto/flat.js';

export type PetState = 'full' | 'hungry' | 'asleep' | 'thinking' | 'waking';
export type PetStageName = 'baby' | 'teen' | 'adult';

export interface FlatOptions {
  tokenId: string;
  stage: PetStageName;
  state: PetState;
  /** worn item, an outfits slug; none by default (add-wardrobe) */
  outfit?: string;
}

/** Draws the pet on `canvas`, at the canvas's own pixel size, on a transparent ground — the stills' three-quarter view. */
export function drawFlat(canvas: HTMLCanvasElement, { tokenId, stage, state, outfit }: FlatOptions): void {
  // the JS file's option types are inferred from its defaults, which leave out `seed`
  const draw = drawFlatPet as (canvas: HTMLCanvasElement, options: Record<string, unknown>) => void;
  draw(canvas, { seed: tokenId, stage, state, angle: 'three-quarter', outfit: outfit ?? 'none' });
}

let webgl: boolean | undefined;

/** Whether this browser gives the context the 3D pet needs: three.js asks for WebGL 2 only, so WebGL 1 is no WebGL here.
 *  Asked once per page; the probe context is released at once. */
export function canUseWebGL(): boolean {
  if (webgl !== undefined) return webgl;
  try {
    const probe = document.createElement('canvas');
    const gl = probe.getContext('webgl2');
    webgl = Boolean(gl);
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
  } catch {
    webgl = false;
  }
  return webgl;
}

/** Test seam: ask the browser again. */
export function forgetWebGLProbe(): void {
  webgl = undefined;
}
