// How a lit colour becomes a pixel, per graphics mode, as the World Editor shows it (measured with we-drive,
// 2026-11-08: flat ground of cliff.w3m under lighting models made for the purpose, pictures fitted per channel):
//
// - Classic (SD): texture × light, the light clamped to 1 per channel, as fixed-function lighting does. The editor's
//   ground is the same with View > Lighting on, off and in game view, on map 03 (light 0.97) and on cliff.w3m (1.36).
// - HD (Reforged): the texture taken as sRGB to linear light, multiplied by the light and an exposure, a little more
//   saturated (HD_SATURATION), through the ACES filmic curve (Narkowicz's fit) with the editor's shoulder, never
//   darker than the light without the exposure (hdTone), and back to sRGB. The saturation takes grass's red and blue
//   to nearly 0 (Lords_Grass_Diffuse 20, 124, 18 shows as 3, 131, 0), while dark grey ground keeps its colour; the
//   fit is 4 levels rms on bright pictures, where a plain multiply is 13–16 off. The editor's own light (View >
//   Lighting off) is exposure 0.70 on the texture.
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

/**
 * The HD picture's shoulder: near white the editor's picture is brighter than the ACES curve, which reaches white
 * only slowly. Fitted (we-drive, 2026-11-08) on cliff.w3m's walls (red and green) and grass (green) under twelve
 * lighting variants together with the light of hdLight and shadeWrap: o + 46 o^10.4 (1 - o), o the curve's linear
 * value, white from o = 0.69 (sRGB 218) on, and the same as the curve below about 0.5 (sRGB 190). Plain ACES was 10.5
 * levels rms off (the bright grass 238 against 214, the walls' red 226 against 205), this 3.9.
 */
export const HD_SHOULDER = { gain: 46, power: 10.4 };

/**
 * A linear light value (texture × light × exposure) through the HD picture's curve, linear 0–1 out: ACES (Narkowicz's
 * fit) with the editor's shoulder (HD_SHOULDER), but never darker than the value without the exposure (x /
 * HD_EXPOSURE). The two meet at about sRGB 120; above, the curve is as fitted (it is about that value there anyway).
 * Below, ACES's toe made dark ground far too dark: the editor's HD view with View > Lighting off shows dark textures
 * as they are (we-drive, 2026-11-12, new flat 64×64 maps: Dungeon's Cave_Dirt_Diffuse, mean 30, 26, 25, as 30, 25,
 * 24; Icecrown's Ice_Dirt 29, 45, 49 as 27, 46, 49, level by level from sRGB 18 to 59), where the toe gave 13, 9, 8
 * and 12, 25, 28. The shaders' `toned` does the same per channel.
 */
export function hdTone(x: number): number {
  const v = Math.max(0, x);
  const o = Math.min(1, (v * (2.51 * v + 0.03)) / (v * (2.43 * v + 0.59) + 0.14));
  return Math.min(1, Math.max(o + HD_SHOULDER.gain * o ** HD_SHOULDER.power * (1 - o), v / HD_EXPOSURE));
}

/**
 * The HD picture's saturation, of the linear colour before the curve (hdSaturate): what keeps grass's red and blue
 * near 0 without ACES's toe (hdTone), where a darker curve would also darken grey ground. Fitted on map 03 (grass
 * 8, 120, 10 as with the toe, which matched the editor) and checked on Mount Hyjal's grass, whose darkest tenth of
 * red and blue is 0 in the editor's picture as with it (both 2026-11-12). Dark grey ground (Cave_Dirt) is all but
 * unchanged by it.
 */
export const HD_SATURATION = 1.05;

/** Rec. 709 luminance weights of linear light. */
const LUMA = [0.2126, 0.7152, 0.0722] as const;

/** A linear colour (texture × light × exposure) with the HD picture's saturation (HD_SATURATION), before the curve
 *  (hdTone). The shaders' `toned` does the same. */
export function hdSaturate(rgb: readonly number[]): [number, number, number] {
  const l = LUMA[0] * rgb[0] + LUMA[1] * rgb[1] + LUMA[2] * rgb[2];
  return [0, 1, 2].map((c) => Math.max(0, l + HD_SATURATION * (rgb[c] - l))) as [number, number, number];
}

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toSrgb = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);

/** The HD picture's colour (sRGB, 0–1) of a texture colour `base` (sRGB, 0–1) under a light: the shaders' `toned` in HD. */
export function hdPixel(base: readonly number[], light: readonly number[]): [number, number, number] {
  const x = hdSaturate([0, 1, 2].map((c) => toLinear(Math.min(1, Math.max(0, base[c]))) * Math.max(0, light[c]) * HD_EXPOSURE));
  return x.map((v) => toSrgb(hdTone(v))) as [number, number, number];
}

/** How much a surface of normal `n` gets of a sun from `l`: the cosine, and in HD the lift by the shadow intensity
 *  (`wrap`, see shadeWrap), the same for every surface. The shaders' `facing` does the same. */
export function facing(n: readonly number[], l: readonly number[], wrap: number): number {
  const ln = Math.hypot(l[0], l[1], l[2]) || 1, nn = Math.hypot(n[0], n[1], n[2]) || 1;
  const d = Math.max(0, (n[0] * l[0] + n[1] * l[1] + n[2] * l[2]) / (ln * nn));
  return d + (1 - Math.max(0, l[2] / ln)) * wrap;
}

/**
 * The HD view's shading in its real shadows (sunshadow.ts), against the lit shading (facing, shadeWrap): measured
 * (we-drive, 2026-11-09) on a test map on cliff.w3m's flat ground under its lighting (sun 52° from straight up, at
 * 06:00) with one value changed at a time, the light in a footman's and a gryphon's shadow over the editor's own light
 * (the tone curve inverted per pixel, green):
 * - with shadow intensity 0 the shadow is the ambient alone: black without ambient, 0.31 with ambient 0.2 whether the
 *   sun's intensity is 1 or 1.95, where Studio's ambient is 0.17: `ambient` 1.87 times it, none of the sun's cosine;
 * - the shadow intensity lifts the shadow about twice as much as the lit ground (2.05–2.55 times its (1 - z) per unit
 *   over sun 1 and 1.95, ambient 0 and 0.2, shadow intensity 2; 1.98 at 5.85): `lift` 2.2. So the shadow is as light
 *   as the lit ground at shadow intensity 1 (the editor's shadows all but vanish there), lighter above it: cliff.w3m's
 *   5.85 gives shadows 1.64 times the lit ground's light (yellow on orange sand).
 */
export const SUN_SHADE = { ambient: 1.87, lift: 2.2 };

/**
 * The game's own HD lighting models (Environment\DNC\…, _HD.w3mod) give the real shadows a light of their own that a
 * map's lighting model doesn't: map 03 (Lordaeron's HD models: no ambient, shadow intensity 0.27 and 0.35) keeps 0.51
 * of the lit ground's light in a footman's shadow (green; red 0.49, blue 0.68), where the light model alone (SUN_SHADE)
 * leaves 0.06; cliff.w3m's own models with no ambient leave black, also with the HD models' ambient -0.03 (we-drive,
 * 2026-11-09). On the ground it is added in shadow as this share of the lit light (sunLight).
 *
 * On the models it lights every surface alike, lit or not (branch render-fixes-5, TwistedMeadows under the same
 * models, we-drive HD, Shadows on over off, the tone curve inverted per pixel): the editor's tree trunks on their side
 * away from the sun were 79, 52, 22 (sRGB) with Shadows off, where Studio's light model alone gave 24, 11, 3 (objectLight).
 * Not so on the ground: lit there the same way, TwistedMeadows' slopes turned from the sun came out 16 levels brighter
 * than the editor's. The ground in the trees' shadows kept 0.52–0.60 of its light (median, green; map 03's footmen's
 * 0.50).
 */
export const GAME_LIGHT_FILL = 0.5;

/** The light at a point of normal `n` that gets `lit` of the sun, from the light lit (ambient + diffuse × facing) and in
 *  full shadow (sunAmbient, sunFacing at 0, and the light's fill share of the lit light): between the two by `lit`. The
 *  ground's (objectLight is the models'). The shaders' `sunLight` does the same per channel. */
export function sunLight(ambient: number, diffuse: number, n: readonly number[], l: readonly number[], wrap: number, fill: number, lit: number): number {
  const full = ambient + diffuse * facing(n, l, wrap);
  const shade = ambient * sunAmbient(0) + diffuse * sunFacing(n, l, wrap, 0) + fill * full;
  const v = Math.min(1, Math.max(0, lit));
  return shade + (full - shade) * v;
}

/** The light on a model at a point of normal `n` that gets `lit` of the sun: the fill share (`fill`, the game's own
 *  lighting: GAME_LIGHT_FILL) of the light on flat ground (normal straight up) on every surface, lit or in shadow, and
 *  the light model's own (sunLight without a fill) the rest, so a surface facing up keeps its light. The shaders'
 *  `objectLight` does the same per channel. */
export function objectLight(ambient: number, diffuse: number, n: readonly number[], l: readonly number[], wrap: number, fill: number, lit: number): number {
  const f = Math.min(1, Math.max(0, fill));
  const level = ambient + diffuse * facing([0, 0, 1], l, wrap);
  return f * level + (1 - f) * sunLight(ambient, diffuse, n, l, wrap, 0, lit);
}

/** facing() at a point that gets `lit` of the sun (1 lit, 0 in full shadow, between at the soft edge): no cosine in
 *  shadow, the shadow intensity's lift SUN_SHADE.lift times stronger. The shaders' `sunFacing` does the same. */
export function sunFacing(n: readonly number[], l: readonly number[], wrap: number, lit: number): number {
  const ln = Math.hypot(l[0], l[1], l[2]) || 1, nn = Math.hypot(n[0], n[1], n[2]) || 1;
  const d = Math.max(0, (n[0] * l[0] + n[1] * l[1] + n[2] * l[2]) / (ln * nn));
  const v = Math.min(1, Math.max(0, lit));
  return d * v + (1 - Math.max(0, l[2] / ln)) * wrap * (SUN_SHADE.lift + (1 - SUN_SHADE.lift) * v);
}

/** What the ambient light counts for at a point that gets `lit` of the sun: SUN_SHADE.ambient in full shadow, 1 lit.
 *  The shaders' `sunAmbient` does the same. */
export function sunAmbient(lit: number): number {
  const v = Math.min(1, Math.max(0, lit));
  return SUN_SHADE.ambient + (1 - SUN_SHADE.ambient) * v;
}

const glsl = (v: number) => v.toFixed(3);

/** For fragment shaders: `toned(base, light)`, base an sRGB colour (a texture's), light the scene light on it,
 *  `tonedGlow(base, light, glow)` the same with a colour of its own added unlit (an HD emissive texture), and
 *  `facing(n, l)`, how much a surface of normal n gets of a light from l (as facing above), and `sunFacing(n, l, lit)`
 *  and `sunAmbient(lit)` for a point that gets `lit` of the sun (as sunFacing and sunAmbient above), and
 *  `sunLight(ambient, diffuse, n, l, lit)`, the light there on the ground, `objectLight(…)` on a model (as sunLight and
 *  objectLight above; uSunFill the light's fill). */
export const TONE_FS = `uniform float uTone; uniform float uShadeWrap; uniform float uSunFill;
float facing(vec3 n, vec3 l) {
  vec3 L = normalize(l);
  return max(dot(normalize(n), L), 0.0) + (1.0 - max(L.z, 0.0)) * uShadeWrap;
}
float sunFacing(vec3 n, vec3 l, float lit) {
  vec3 L = normalize(l);
  float v = clamp(lit, 0.0, 1.0);
  return max(dot(normalize(n), L), 0.0) * v + (1.0 - max(L.z, 0.0)) * uShadeWrap * mix(${glsl(SUN_SHADE.lift)}, 1.0, v);
}
float sunAmbient(float lit) { return mix(${glsl(SUN_SHADE.ambient)}, 1.0, clamp(lit, 0.0, 1.0)); }
vec3 sunLight(vec3 ambient, vec3 diffuse, vec3 n, vec3 l, float lit) {
  vec3 full = ambient + diffuse * facing(n, l);
  vec3 shade = ambient * sunAmbient(0.0) + diffuse * sunFacing(n, l, 0.0) + uSunFill * full;
  return mix(shade, full, clamp(lit, 0.0, 1.0));
}
vec3 objectLight(vec3 ambient, vec3 diffuse, vec3 n, vec3 l, float lit) {
  float f = clamp(uSunFill, 0.0, 1.0);
  vec3 level = ambient + diffuse * facing(vec3(0.0, 0.0, 1.0), l);
  vec3 full = ambient + diffuse * facing(n, l);
  vec3 shade = ambient * sunAmbient(0.0) + diffuse * sunFacing(n, l, 0.0);
  return f * level + (1.0 - f) * mix(shade, full, clamp(lit, 0.0, 1.0));
}
vec3 srgbToLinear(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c)); }
vec3 linearToSrgb(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}
vec3 tonedGlow(vec3 base, vec3 light, vec3 glow) {
  if (uTone > 1.5) {
    vec3 x = (srgbToLinear(clamp(base, 0.0, 1.0)) * max(light, vec3(0.0)) + srgbToLinear(clamp(glow, 0.0, 1.0))) * ${HD_EXPOSURE.toFixed(3)};
    float luma = dot(x, vec3(${LUMA.join(", ")}));
    x = max(vec3(luma) + ${HD_SATURATION.toFixed(3)} * (x - vec3(luma)), vec3(0.0));
    vec3 o = min((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), vec3(1.0));
    return linearToSrgb(max(o + ${glsl(HD_SHOULDER.gain)} * pow(o, vec3(${glsl(HD_SHOULDER.power)})) * (1.0 - o), x / ${HD_EXPOSURE.toFixed(3)}));
  }
  if (uTone > 0.5) return base * clamp(light, 0.0, 1.0) + glow;
  return base * light + glow;
}
vec3 toned(vec3 base, vec3 light) { return tonedGlow(base, light, vec3(0.0)); }`;

/** Sets a shader's tone, and how it shades for this light (shadeWrap). */
export function setTone(gl: WebGL2RenderingContext, where: (name: string) => WebGLUniformLocation | null, tone: Tone | undefined, light?: SceneLight | null) {
  gl.uniform1f(where("uTone"), tone ?? 0);
  gl.uniform1f(where("uShadeWrap"), shadeWrap(tone, light));
  gl.uniform1f(where("uSunFill"), tone === 2 ? Math.max(0, light?.fill ?? 0) : 0);
}

/**
 * How far HD shading lifts every surface by the light's shadow intensity: its share of the sun d (the cosine to it)
 * becomes d + (1 - z) × intensity, z the cosine of the sun to straight up. So the lift is the same on walls as on
 * flat ground (where it is d + (1 - d) × intensity), and none with the sun straight down. Measured (we-drive,
 * 2026-11-08, cliff.w3m's lighting with one value changed at a time; the light factor from the picture's tone): with
 * the sun 52° from straight up at intensity 1.95, shadow intensity 0, 1, 2, 3, 5.85 gave the south walls 0.71, 1.22,
 * 1.67, 2.14, 3.81 and the grass 0.92, 1.45, 2.13 and up: the same 0.5 more per unit, which is 1.32 × (1 - 0.62).
 * A lift by the surface's own (1 - d) whitened the walls (0.75 per unit). The classic picture shades by the cosine
 * alone, as does a light without the field.
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
 * Beside a sun the ambient adds only as it reads: cliff.w3m's lighting (sun 1.95 from 52°, ambient colour 0.84 at
 * 06:00) with ambient intensity 0, 0.2 and 1 lit its walls 3.63, 3.81, 4.65 and, at shadow intensity 0, walls and
 * grass 0.18 and 0.14 more for 0.2 (1.24 × colour^0.52 would be 0.49).
 *
 * The shadow intensity changes the shading, not the light: see shadeWrap.
 */
export function hdLight(l: SceneLight): SceneLight {
  const pow = (v: number, p: number) => Math.max(0, v) ** p;
  const sun = Math.max(...l.diffuse) > 0;
  const ambient = (v: number) => (sun ? Math.max(0, v) : 1.24 * pow(v, 0.52));
  return {
    dir: l.dir, shadow: l.shadow, ...(l.fill !== undefined ? { fill: l.fill } : {}),
    diffuse: [pow(l.diffuse[0], 0.42), pow(l.diffuse[1], 0.42), pow(l.diffuse[2], 0.42)],
    ambient: [ambient(l.ambient[0]), ambient(l.ambient[1]), ambient(l.ambient[2])],
  };
}
