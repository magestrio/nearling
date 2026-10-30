import { Effect } from 'postprocessing';
import { wrapEffect } from '@react-three/postprocessing';

// The last step of the post chain. Bloom and the ground pool add light where
// the scene was cleared to alpha 0; this raises alpha to the brightness of the
// final (sRGB-encoded) colour, so a still with a transparent background keeps
// the halo and the pool as semi-transparent light. The bloom's blur leaves a
// faint residue over the whole frame; below 2/255 on an empty pixel it is cut
// to zero, so the background stays pure #000000.
class AlphaFromLightEffect extends Effect {
  constructor() {
    super(
      'AlphaFromLightEffect',
      `void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
        vec3 encoded = sRGBTransferOETF(vec4(max(inputColor.rgb, 0.0), 1.0)).rgb;
        float light = clamp(max(encoded.r, max(encoded.g, encoded.b)), 0.0, 1.0);
        float keep = max(step(2.0 / 255.0, light), step(0.001, inputColor.a));
        outputColor = vec4(inputColor.rgb * keep, max(inputColor.a, light * keep));
      }`,
    );
  }
}

export const AlphaFromLight = wrapEffect(AlphaFromLightEffect);
