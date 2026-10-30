import * as THREE from 'three';
import { HUES, OFF_WHITE } from './generator.js';

const luminance = (c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
const MINT_LUMINANCE = luminance(new THREE.Color(HUES.mint));

// The glow hue at mint's luminance: a dark hue (lavender, coral) shines as
// brightly through the vinyl as mint does, and blooms the same; mint itself
// is unchanged.
export function glowAtMintLuminance(hex) {
  const c = new THREE.Color(hex);
  return c.multiplyScalar(MINT_LUMINANCE / luminance(c));
}

// The Neutral tone mapper (PetCanvas.jsx › Post) starts with a toe that
// subtracts offset(x) = x < 0.08 ? x - 6.25 x² : 0.04 from every channel,
// x the colour's smallest channel. Mint's smallest channel is 0, so it never
// loses anything; lavender's red and green are not, and its dim tones (the
// pool's edge, the bloom's tail, the vinyl's shadow side) lost them and read
// indigo, down to h° 264 where the pool fades (P5 critic M1). With `toe` on,
// the vinyl and the pool undo that toe for their own colour, so they come
// out of the tone mapper at the colour they were lit to. Only lavender needs
// it; the other hues keep their pixels.
const UNDO_TOE = `
vec3 undoToe(vec3 c) {
  float m = min(c.r, min(c.g, c.b));
  float x = m < 0.04 ? 0.4 * sqrt(max(m, 0.0)) : m + 0.04;
  return c + (x - m);
}`;

// Equal light across the five hues (P3). The luminance match alone left two
// hues reading weaker than mint: yellow's glow (a light hue on a light vinyl
// has less room above its own lit vinyl: 75% of mint's lift) and lavender's
// pool (the raw accent at 0.58 of mint's luminance; 80% of mint's even at
// mint's luminance, measured as OKLab L). These gains on top of the match
// raise each weak number to mint's, as measured and solved by
// scripts/measure-light.mjs on one body painted in all five hues; numbers
// already at or over mint keep 1. The bloom has no gain of its own: it
// follows the glow, and the raised yellow glow blooms a little more than
// mint's, which is what makes it read as lit (cutting it back to mint's
// halo needed the bloom all but off and still did not get there). Mint is
// the reference and stays as it was. The pool's colour is matched to mint's
// luminance too (it was the raw accent).
// toe (the pet critic's M1): lavender undoes the tone mapper's toe (UNDO_TOE)
// and holds its hue angle, h° 282, from the body out to the pool's faint
// edge (it was 269° there). The toe had been taking a share of its light as
// well, so with it undone lavender reads brighter: its gains came down from
// 1, 1.67 to 0.65, 0.95, which puts its body and pool where aqua's and
// coral's are against mint (measure-light.mjs, seed 9).
export const HUE_LIGHT = {
  mint: { glow: 1, pool: 1, toe: false },
  aqua: { glow: 1, pool: 1, toe: false },
  lavender: { glow: 0.65, pool: 0.95, toe: true },
  coral: { glow: 1, pool: 1.13, toe: false },
  yellow: { glow: 1.33, pool: 1, toe: false },
};

// Matte soft-touch vinyl that lets the core light through.
// The glow is a faked subsurface term: surface points near the core (a world
// position fed in every frame) gain emissive light in the accent hue, falling
// off with distance, and the hottest centre washes toward white the way a
// bright light behind a thin shell does.
const VINYL = {
  roughness: 0.62,
  metalness: 0,
  specularIntensity: 0.35,
  sheen: 0.3,
  sheenRoughness: 0.85,
};

export function makeVinyl({ color, glowColor, glowStrength, glowRadius, corePos, toe = false, vertexColors = false }) {
  const material = new THREE.MeshPhysicalMaterial({
    color,
    vertexColors,
    ...VINYL,
    sheenColor: new THREE.Color('#ffffff'),
  });
  const uniforms = {
    uCorePos: corePos,
    uGlowColor: { value: glowAtMintLuminance(glowColor) },
    uGlowStrength: { value: glowStrength },
    uGlowRadius: { value: glowRadius },
  };
  material.userData.glow = uniforms; // the pet in motion moves its light (Pet.jsx)
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGlowPos;')
      .replace(
        '#include <project_vertex>',
        '#include <project_vertex>\nvGlowPos = (modelMatrix * vec4(transformed, 1.0)).xyz;',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        [
          '#include <common>',
          'varying vec3 vGlowPos;',
          'uniform vec3 uCorePos;',
          'uniform vec3 uGlowColor;',
          'uniform float uGlowStrength;',
          'uniform float uGlowRadius;',
        ].join('\n'),
      )
      .replace(
        '#include <emissivemap_fragment>',
        [
          '#include <emissivemap_fragment>',
          'float glowD = distance(vGlowPos, uCorePos) / uGlowRadius;',
          'float glow = exp(-glowD * glowD);',
          'totalEmissiveRadiance += uGlowStrength * (uGlowColor * glow + vec3(0.4) * glow * glow * glow);',
        ].join('\n'),
      );
    if (toe) {
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>${UNDO_TOE}`)
        .replace('#include <opaque_fragment>', '#include <opaque_fragment>\ngl_FragColor.rgb = undoToe(gl_FragColor.rgb);');
    }
  };
  // The same onBeforeCompile builds two shaders: keep their programs apart.
  material.customProgramCacheKey = () => (toe ? 'vinyl-toe' : 'vinyl');
  return material;
}

// A worn item (outfits.js): the pet's own matte vinyl without the glow term,
// since nothing lights it from inside. The core's spill light (Pet.jsx)
// reaches it as it reaches the feet and the ring, so the side facing the
// body takes a little of the hue.
// Yellow is only the daisy's heart, a small accent the thing itself has.
// Double-sided: some item surfaces are built as open sheets.
export const ITEM_TONES = { black: '#141414', offWhite: OFF_WHITE, yellow: HUES.yellow };
export function makeItemVinyl(tone) {
  return new THREE.MeshPhysicalMaterial({ color: ITEM_TONES[tone], ...VINYL, sheenColor: new THREE.Color('#ffffff'), side: THREE.DoubleSide });
}

export function makeFeetMaterial() {
  return new THREE.MeshStandardMaterial({ color: '#141414', roughness: 0.38, metalness: 0 });
}

export function makeScreenMaterial(emissiveMap) {
  return new THREE.MeshStandardMaterial({
    color: '#050505',
    roughness: 0.6,
    metalness: 0,
    emissive: '#ffffff',
    emissiveMap,
    // The eyes are the screen's own light. The post chain tone-maps every
    // pixel (Neutral); this gain brings them back out at exactly #F2F1E9,
    // and stays under the bloom threshold so the eyes do not bloom.
    emissiveIntensity: 1.21,
  });
}

// The pool of core light on the ground: a soft gaussian ellipse in the accent
// hue, added onto whatever is below it (black), never a visible plane edge.
export function makePoolMaterial({ color, strength, radius, toe = false }) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: glowAtMintLuminance(color) },
      uStrength: { value: strength },
      uRadius: { value: new THREE.Vector2(radius[0], radius[1]) },
    },
    vertexShader: `
      varying vec2 vPos;
      void main() {
        vPos = position.xy;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    defines: toe ? { UNDO_TOE: '' } : {},
    fragmentShader: `
      uniform vec3 uColor;
      uniform float uStrength;
      uniform vec2 uRadius;
      varying vec2 vPos;
      ${UNDO_TOE}
      void main() {
        vec2 q = vPos / uRadius;
        float r = length(q);
        // A gaussian whose tail is faded to exactly zero by r = 2.2, so the
        // pool never reaches the frame edge (sRGB makes faint tails visible).
        float g = exp(-r * r) * (1.0 - smoothstep(1.2, 2.2, r));
        gl_FragColor = vec4(uColor * uStrength * g, 1.0);
        #ifdef UNDO_TOE
        gl_FragColor.rgb = undoToe(gl_FragColor.rgb);
        #endif
      }`,
    transparent: true,
    depthWrite: false,
    // Add light to the colour only; alpha is left as it was and is derived
    // from the light at the end of the post chain (see AlphaFromLight).
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.OneFactor,
  });
}
