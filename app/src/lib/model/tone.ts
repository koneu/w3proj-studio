// How a lit colour becomes a pixel, per graphics mode, as the World Editor shows it (measured with we-drive,
// 2026-11-08: flat ground of cliff.w3m under lighting models made for the purpose, pictures fitted per channel):
//
// - Classic (SD): texture × light, the light clamped to 1 per channel, as fixed-function lighting does. The editor's
//   ground is the same with View > Lighting on, off and in game view, on map 03 (light 0.97) and on cliff.w3m (1.36).
// - HD (Reforged): the texture taken as sRGB to linear light, multiplied by the light and an exposure, through the
//   ACES filmic curve (Narkowicz's fit) and back to sRGB. That curve's toe takes grass's red and blue to nearly 0
//   (Lords_Grass_Diffuse 20, 124, 18 shows as 3, 131, 0) and fits every picture to 4 levels rms; a plain multiply
//   is 13–16 off. The editor's own light (View > Lighting off) is exposure 0.70 on the texture.
//
// The lighting models' light reaches the HD picture weaker than it reads (see hdLight).

import type { SceneLight } from "./dnclight";

/** 0: colour × light as it is (the model viewer); 1: classic (SD); 2: HD. */
export type Tone = 0 | 1 | 2;

/** The tone of a graphics mode setting ("sd", "hd", "de"; HD unless it's "sd"). */
export const toneOf = (graphicsMode: string | undefined): Tone => (graphicsMode === "sd" ? 1 : 2);

/** Exposure of the HD picture: what the editor's light without a lighting model (View > Lighting off) gives the
 *  texture, fitted on map 03 and cliff.w3m (0.70 and 0.71) against Studio's even light (1.01 on flat ground). */
export const HD_EXPOSURE = 0.7;

/** For fragment shaders: `toned(base, light)`, base an sRGB colour (a texture's), light the scene light on it, and
 *  `facing(n, l)`, how much a surface of normal n gets of a light from l (shadeWrap: HD's use of the shadow intensity). */
export const TONE_FS = `uniform float uTone; uniform float uShadeWrap;
float facing(vec3 n, vec3 l) { float d = max(dot(normalize(n), normalize(l)), 0.0); return d + (1.0 - d) * uShadeWrap; }
vec3 srgbToLinear(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c)); }
vec3 linearToSrgb(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}
vec3 toned(vec3 base, vec3 light) {
  if (uTone > 1.5) {
    vec3 x = srgbToLinear(clamp(base, 0.0, 1.0)) * max(light, vec3(0.0)) * ${HD_EXPOSURE.toFixed(3)};
    return linearToSrgb((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14));
  }
  if (uTone > 0.5) return base * clamp(light, 0.0, 1.0);
  return base * light;
}`;

/** Sets a shader's tone, and how it shades for this light (shadeWrap). */
export function setTone(gl: WebGL2RenderingContext, where: (name: string) => WebGLUniformLocation | null, tone: Tone | undefined, light?: SceneLight | null) {
  gl.uniform1f(where("uTone"), tone ?? 0);
  gl.uniform1f(where("uShadeWrap"), shadeWrap(tone, light));
}

/**
 * How far HD shading lifts a surface's share of the sun toward all of it: by the light's shadow intensity, the share
 * d (the cosine to the sun) becoming d + (1 - d) × intensity. Measured: a sun 52° from straight up with shadow
 * intensity 5.85 (cliff.w3m's own lighting) lights flat ground about four times as much as with 0, and the same sun
 * straight down is the same with either; 0.62 + 0.38 × 5.85 is 2.9 against the measured 2.5 (the tone curve is near
 * white there). The classic picture shades by the cosine alone, as does a light without the field.
 */
export function shadeWrap(tone: Tone | undefined, light?: SceneLight | null): number {
  return tone === 2 ? Math.max(0, light?.shadow ?? 0) : 0;
}

/**
 * A lighting model's light (lightAt) as it reaches the HD picture. Fitted on lighting models with one directional
 * light (we-drive, flat ground; the factor the light gives the texture after the exposure, from the tone curve's fit):
 * the sun's intensity 0.5, 1, 2 straight down gave 0.80, 1, 1.43 of the intensity 1 light, linear in the angle
 * (0.62 at 52° from straight up, the same from the south, north and east: no shine); ambient alone 0.5 and 1 gave
 * 0.82 and 1.24, 0.2 gave 0.57. So the diffuse colour goes in as colour^0.42 (per channel) and the ambient as
 * 1.24 × colour^0.52; negative ambient (the HD models' -0.03) is none. Map 03's game lighting (Lordaeron's HD model at
 * 06:00) then gives 0.92 against the editor's 0.89.
 *
 * The shadow intensity changes the shading, not the light: see shadeWrap.
 */
export function hdLight(l: SceneLight): SceneLight {
  const pow = (v: number, p: number) => Math.max(0, v) ** p;
  return {
    dir: l.dir, shadow: l.shadow,
    diffuse: [pow(l.diffuse[0], 0.42), pow(l.diffuse[1], 0.42), pow(l.diffuse[2], 0.42)],
    ambient: [1.24 * pow(l.ambient[0], 0.52), 1.24 * pow(l.ambient[1], 0.52), 1.24 * pow(l.ambient[2], 0.52)],
  };
}
