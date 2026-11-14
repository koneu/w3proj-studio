// WebGL2 terrain: textured ground (Warcraft's corner-mask tile atlas), water,
// placed doodads/units as models, and point markers for objects without one.
// Cliff tiles get cliff models (see cliffs.ts); ramps stay sloped ground.

import type { DecodedImage } from "../../lib/image/index";
import { FOG_FS, FOG_VS, setFog, type Fog } from "../../lib/model/fog";
import { createTexture } from "../../lib/model/gltexture";
import { frustumPlanes, sphereInView, worldSphere } from "../../lib/model/frustum";
import { compile, DEFAULT_LIGHT, INSTANCE_BYTES, mat4, noSunTexture, poseNodes, standClock, type Clock, type EdgeShade, type HeightMap, type InstanceRuns, type Mat4, type ModelGpu, type Vec3 } from "../../lib/model/renderer";
import type { Model } from "../../lib/model/mdx";
import type { SceneLight } from "../../lib/model/dnclight";
import { hdLight, setTone, shadeWrap, sunLight, TONE_FS, type Tone } from "../../lib/model/tone";
import { setSunShadow, SUN_FS, sunShadowFrame, SunShadowMap, viewRays, type SunShadow } from "../../lib/model/sunshadow";
import { ViewDepth } from "../../lib/model/viewdepth";

/** Ground light without the map's lighting: soft ambient plus a light from the south-west. */
const GROUND_DEFAULT: SceneLight = { dir: [-0.3, -0.4, 0.85], diffuse: [0.65, 0.65, 0.65], ambient: [0.45, 0.45, 0.45] };
/** How much of HD water's colour a model's real shadow on it keeps: map 03's ships' shadows on its lake, 0.76, 0.64,
 *  0.82 by channel (we-drive, 2026-11-09, the World Editor's HD view with View > Shadows on over off), and a flying
 *  gryphon's on map 03's lake 0.77, 0.73, 0.86 (branch render-fixes-5; one 0.74 for all three made it too dark in blue). */
const WATER_SHADE: readonly [number, number, number] = [0.77, 0.69, 0.84];

/**
 * HD water by its depth (world units from the ground to the surface), measured (we-drive, branch render-fixes-5) on
 * five pools of set depths, 8, 16, 32, 48 and 96, on map 03's flat grass, the editor's HD view with Lighting off and
 * with Water off for the ground: each pool's colour is the ground's mixed with the water's by 0.24, 0.36, 0.51, 0.65
 * and 0.97 (`(depth / full)^power` within 0.03), and the water's own colour goes from a light grey-blue (`shallow`,
 * sRGB) to the deep colour (hdWaterColor) over the classic ramp's depths (`ramp`, Water.slk's shallow to deep), 1.3
 * levels rms over all fifteen channels. TwistedMeadows' centre is such shallow water (38 deep) over rock, which the
 * editor shows nearly as the rock. Before, Studio's alpha ((depth - 4) / 96)^0.4, fitted on map 03's lake edge, was
 * 0.29, 0.48, 0.66, 0.77 there, and the colour the deep one throughout.
 */
export const HD_WATER = { full: 100, power: 0.58, ramp: [10, 64] as const, shallow: [88, 104, 120] as const };
/** HD water's dark edge: black up to the first of these distances (world units) inside the playable map, its colour
 *  back in full at the second, by the pixel. The World Editor's HD water goes dark that far inside, hard, on all four
 *  sides alike (we-drive, 2026-11-13, a copy of the empty map with lakes across each edge, from above at 1200: half its
 *  colour 39 to 46 pixels inside, a tenth 24 to 29; about a pixel a unit there). */
export const HD_WATER_EDGE = [10, 42] as const;

/** The playable map's rectangle (left, bottom, right, top in world units) round the tiles `edge` leaves (1 per tile
 *  past it, rows from the south); an empty one in the map's middle when there are none. */
export function playRect(t: Pick<Terrain, "width" | "height" | "offsetX" | "offsetY">, edge: ArrayLike<number>): [number, number, number, number] {
  const tilesX = Math.max(0, t.width - 1), tilesY = Math.max(0, t.height - 1);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let y = 0; y < tilesY; y++) for (let x = 0; x < tilesX; x++) {
    if (edge[y * tilesX + x]) continue;
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x + 1); y1 = Math.max(y1, y + 1);
  }
  if (x0 > x1) { const cx = t.offsetX + tilesX * 64, cy = t.offsetY + tilesY * 64; return [cx, cy, cx, cy]; }
  return [t.offsetX + x0 * 128, t.offsetY + y0 * 128, t.offsetX + x1 * 128, t.offsetY + y1 * 128];
}

/** HD water at a depth (world units): how opaque, and how far its colour is from `shallow` to the deep colour (0–1).
 *  The water shader does the same. */
export function hdWaterAt(depth: number): { alpha: number; deep: number } {
  const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
  return {
    alpha: clamp01(depth / HD_WATER.full) ** HD_WATER.power,
    deep: clamp01((depth - HD_WATER.ramp[0]) / (HD_WATER.ramp[1] - HD_WATER.ramp[0])),
  };
}
import { ParticleInstance, ParticleRenderer } from "../../lib/model/particles";
import { MOST_PARTICLES, placeWeather, viewBox, type WeatherBox, type WeatherEffect } from "../../lib/model/weather";
import type { Placed } from "./objects";
import { cornerNormal, heightAt, mapEdgeTiles, playableEdgeTiles, rampLift, type Corner, type Terrain } from "../../lib/terrain/w3e";
import { borderShade, darkWaterCorners } from "../../lib/terrain/area";
import { gridLines } from "./viewcmds";

const norm = (a: Vec3): Vec3 => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

// Ground tile textures are 4×4 cells of corner-transition shapes (a cell's
// index is a bitmask of the tile corners the texture covers); "extended"
// textures are twice as wide and add 16 full-tile variations. Negative cells
// stand for a variation and are resolved once the texture's size is known.
const GROUND_VS = `#version 300 es
in vec3 aPos; in vec3 aNormal; in vec2 aLocal; in float aCell; in float aShade;
uniform mat4 uViewProj; uniform float uExtended;
out vec2 vUV; out vec3 vNormal; out float vShade; out highp vec3 vWorld;
${FOG_VS}
void main() {
  vWorld = aPos;
  int cell = int(aCell);
  bool ext = uExtended > 0.5;
  if (cell < 0) {
    int v = -cell - 1;
    cell = ext ? (v < 16 ? 16 + v : (v == 16 ? 15 : 0)) : (v == 0 ? 0 : 15);
  }
  int c = cell % 16;
  vec2 cr = vec2(float(c % 4) + (cell >= 16 ? 4.0 : 0.0), float(c / 4));
  // Stay clear of the neighbouring cells when filtering.
  vec2 local = mix(vec2(0.02), vec2(0.98), aLocal);
  vUV = (cr + local) / vec2(ext ? 8.0 : 4.0, 4.0);
  vNormal = aNormal; vShade = aShade;
  gl_Position = uViewProj * vec4(aPos, 1.0);
  vFogDepth = gl_Position.w;
}`;
const GROUND_FS = `#version 300 es
precision mediump float;
in vec2 vUV; in vec3 vNormal; in float vShade; in highp vec3 vWorld;
uniform sampler2D uTex;
uniform vec3 uLightDir; uniform vec3 uDiffuse; uniform vec3 uAmbient;
// The ground's shadow map (one texel per 32 × 32 cell over uShadowRect: x, y, width, height): red the baked
// shadows, green the objects' shadow images, which lie half a cell to the north-east (uStampShift, in texels).
// uShadowDark: how much of the picture a cell in full shadow of each takes away (0 without shadows).
uniform sampler2D uShadow; uniform highp vec4 uShadowRect; uniform vec2 uStampShift; uniform vec2 uShadowDark;
out vec4 outColor;
${FOG_FS}
${TONE_FS}
${SUN_FS}
void main() {
  vec4 c = texture(uTex, vUV);
  highp vec2 at = (vWorld.xy - uShadowRect.xy) / uShadowRect.zw;
  float baked = texture(uShadow, at).r;
  float stamped = texture(uShadow, at - uStampShift).g;
  float dark = max(baked * uShadowDark.x, stamped * uShadowDark.y);
  // HD: the models' real shadows from the sun (SUN_FS), which change the shading rather than darken the picture.
  float lit = sunLit(vWorld, vNormal);
  vec3 light = sunLight(uAmbient, uDiffuse, vNormal, uLightDir, lit);
  outColor = vec4(fogged(toned(c.rgb, light) * vShade * (1.0 - dark)), c.a);
}`;

const COLOR_VS = `#version 300 es
in vec3 aPos; in vec4 aColor;
uniform mat4 uViewProj; uniform float uPointSize;
out vec4 vColor;
void main() { vColor = aColor; gl_Position = uViewProj * vec4(aPos, 1.0); gl_PointSize = uPointSize / gl_Position.w; }`;
const COLOR_FS = `#version 300 es
precision mediump float; in vec4 vColor; out vec4 outColor;
void main() { outColor = vColor; }`;
/** Solid editor marks (setShapes): a colour per corner lit by the scene's light and fogged as a placed model is
 *  (objectLight, in the graphics mode's tone), with no texture. */
const SHAPE_VS = `#version 300 es
in vec3 aPos; in vec3 aNormal; in vec4 aColor;
uniform mat4 uViewProj;
out vec4 vColor; out vec3 vNormal;
${FOG_VS}
void main() { vColor = aColor; vNormal = aNormal; gl_Position = uViewProj * vec4(aPos, 1.0); vFogDepth = gl_Position.w; }`;
const SHAPE_FS = `#version 300 es
precision mediump float; in vec4 vColor; in vec3 vNormal; out vec4 outColor;
uniform vec3 uLightDir; uniform vec3 uDiffuse; uniform vec3 uAmbient;
${TONE_FS}
${FOG_FS}
void main() { outColor = vec4(fogged(toned(vColor.rgb, objectLight(uAmbient, uDiffuse, vNormal, uLightDir, 1.0))), vColor.a); }`;

// Water: the tileset's animated texture (one copy per tile) under a colour that goes from
// "shallow min" to "shallow max" as the water deepens to 64/128 of a cliff layer (from 10/128),
// then from "deep min" to "deep max" until 72/128 (TerrainArt\Water.slk).
const WATER_VS = `#version 300 es
in vec3 aPos; in vec2 aUv; in float aDepth; in float aDark;
uniform mat4 uViewProj;
out vec2 vUv; out float vDepth; out highp vec3 vWorld; out float vDark;
${FOG_VS}
void main() { vUv = aUv; vDepth = aDepth; vDark = aDark; vWorld = aPos; gl_Position = uViewProj * vec4(aPos, 1.0); vFogDepth = gl_Position.w; }`;
const WATER_FS = `#version 300 es
precision mediump float;
in vec2 vUv; in float vDepth; in highp vec3 vWorld; in float vDark;
// Past the playable map the water is black: classic, vDark per corner (darkWaterCorners), fading over a tile; HD by the
// pixel, hard, inside the playable rectangle uPlayRect (left, bottom, right, top: hdWaterEdge). uEdgeDark 0 when the
// border isn't shown.
uniform float uEdgeDark; uniform highp vec4 uPlayRect;
uniform sampler2D uTex; uniform vec4 uShallowMin; uniform vec4 uShallowMax; uniform vec4 uDeepMin; uniform vec4 uDeepMax;
// The scene light on a flat surface (the map's water tint is in the ramp: waterRamp).
uniform vec3 uLight;
// HD (uTone 2): the colour the editor shows (hdWaterColor), the texture only rippling it.
uniform vec3 uHdWater; uniform float uWaterBrightness;
// HD: the depth picture of the models under the water (uSceneOn 1; drawWaterDepth), at the view's size (uViewSize), from
// the eye uEye looking along uForward with the projection's near and far planes (uNearFar).
uniform highp sampler2D uScene; uniform float uSceneOn; uniform highp vec2 uViewSize;
uniform highp vec3 uEye; uniform highp vec3 uForward; uniform highp vec2 uNearFar;
out vec4 outColor;
${FOG_FS}
${TONE_FS}
${SUN_FS}
// The water a pixel shows (world units): the bed's depth, or less where a model under the surface is nearer than the bed,
// by how far below the surface its point seen lies (viewdepth.ts waterSeenDepth, eyeDistance).
float seenDepth(float bed) {
  if (uSceneOn < 0.5) return bed;
  highp float d = texture(uScene, gl_FragCoord.xy / uViewSize).r;
  // Nothing drawn there, or a model in front of the water (above it): the bed.
  if (d >= 1.0 || d <= gl_FragCoord.z) return bed;
  highp float n = uNearFar.x, f = uNearFar.y;
  highp float behind = 2.0 * n * f / (f + n - (2.0 * d - 1.0) * (f - n));
  highp float here = dot(vWorld - uEye, uForward);
  highp float seenZ = uEye.z + (vWorld.z - uEye.z) * behind / max(here, 1.0);
  return min(bed, max(vWorld.z - seenZ, 0.0));
}
void main() {
  const float minDepth = 10.0 / 128.0, deepLevel = 64.0 / 128.0, maxDepth = 72.0 / 128.0;
  vec4 c = vDepth <= deepLevel
    ? mix(uShallowMin, uShallowMax, clamp((vDepth - minDepth) / (deepLevel - minDepth), 0.0, 1.0))
    : mix(uDeepMin, uDeepMax, clamp((vDepth - deepLevel) / (maxDepth - deepLevel), 0.0, 1.0));
  vec4 t = texture(uTex, vUv);
  if (uTone > 1.5) {
    // How opaque and which colour by the depth: hdWaterAt (the editor's pools of set depths), the depth being that of
    // the water in front of what's behind (seenDepth).
    float depth = seenDepth(vDepth * 128.0);
    float a = pow(clamp(depth / ${HD_WATER.full.toFixed(1)}, 0.0, 1.0), ${HD_WATER.power.toFixed(3)}) * t.a;
    float deep = clamp((depth - ${HD_WATER.ramp[0].toFixed(1)}) / ${(HD_WATER.ramp[1] - HD_WATER.ramp[0]).toFixed(1)}, 0.0, 1.0);
    vec3 colour = mix(vec3(${HD_WATER.shallow.map((v) => (v / 255).toFixed(4)).join(", ")}), uHdWater, deep);
    float ripple = clamp(dot(t.rgb, vec3(0.299, 0.587, 0.114)) / max(uWaterBrightness, 0.05), 0.5, 1.5);
    // The models' real shadows fall on the water too, keeping WATER_SHADE of its colour.
    vec3 shade = mix(vec3(${WATER_SHADE.map((v) => v.toFixed(3)).join(", ")}), vec3(1.0), sunLit(vWorld, vec3(0.0, 0.0, 1.0)));
    highp vec2 inside = min(vWorld.xy - uPlayRect.xy, uPlayRect.zw - vWorld.xy);
    float lit = smoothstep(${HD_WATER_EDGE[0].toFixed(1)}, ${HD_WATER_EDGE[1].toFixed(1)}, min(inside.x, inside.y));
    outColor = vec4(fogged(colour * mix(1.0, ripple, 0.5) * shade * (1.0 - (1.0 - lit) * uEdgeDark)), a);
    return;
  }
  vec4 w = t * c;
  outColor = vec4(fogged(toned(w.rgb, uLight) * (1.0 - vDark * uEdgeDark)), w.a);
}`;

/** Texture unit of HD water's depth picture of the models (drawWaterDepth): beside SUN_UNIT (5). */
const WATER_DEPTH_UNIT = 6;

/** Tiles around a water tile whose models count as possibly under its surface (wetLevels), and how far above the
 *  surface a model's origin may be and still count (underWater). */
const WET_REACH = 1, WET_MARGIN = 16;

/**
 * Per tile (row by row, `tilesX` × `tilesY`), the highest water surface within `reach` tiles of it, -Infinity where
 * there's none: a model standing on such a tile no higher than about that level may show through HD water (the water
 * pass's depth picture of the models takes only those: underWater). `surface(x, y)`: a tile's highest surface, null
 * without water.
 */
export function wetLevels(tilesX: number, tilesY: number, surface: (x: number, y: number) => number | null, reach = WET_REACH): Float32Array {
  const own = new Float32Array(tilesX * tilesY).fill(-Infinity);
  for (let y = 0; y < tilesY; y++) for (let x = 0; x < tilesX; x++) own[y * tilesX + x] = surface(x, y) ?? -Infinity;
  // Spread along the rows, then along the columns: the highest within the square around each tile.
  const rows = new Float32Array(own.length).fill(-Infinity), out = new Float32Array(own.length).fill(-Infinity);
  for (let y = 0; y < tilesY; y++) for (let x = 0; x < tilesX; x++) {
    let m = -Infinity;
    for (let k = Math.max(0, x - reach); k <= Math.min(tilesX - 1, x + reach); k++) m = Math.max(m, own[y * tilesX + k]);
    rows[y * tilesX + x] = m;
  }
  for (let y = 0; y < tilesY; y++) for (let x = 0; x < tilesX; x++) {
    let m = -Infinity;
    for (let k = Math.max(0, y - reach); k <= Math.min(tilesY - 1, y + reach); k++) m = Math.max(m, rows[k * tilesX + x]);
    out[y * tilesX + x] = m;
  }
  return out;
}

/** What of a corner the water reads. */
type WaterCorner = Pick<Corner, "height" | "water" | "hasWater" | "layer">;

/**
 * A tile's water, its four corners given in any fixed order: the surface height and the depth (world units; how clear
 * the water is) at each, or null where no water is drawn (no corner has water, or the ground is above the surface at
 * all four).
 *
 * Corners without water (the shore) keep the surface level: their stored level is often the default far below, which
 * would tilt the water into the ground. Their depth is their own level's, though, as the World Editor fades it: shore
 * corners at the lake's level give a smooth edge, those far below one that follows the wet corners tile by tile
 * (we-drive, map 03 with both, 2026-11-08). On a cliff tile the dry corners are on the cliff top, but the wall goes
 * down into the water: they keep the wet corners' depth (no fade to clear at the wall).
 */
export function waterTile(cs: readonly WaterCorner[]): { z: number[]; depth: number[] } | null {
  if (!cs.some((c) => c.hasWater) || cs.every((c) => c.water <= c.height)) return null;
  const wet = cs.filter((c) => c.hasWater);
  const level = Math.max(...wet.map((c) => c.water));
  const cliff = !cs.every((c) => c.layer === cs[0].layer);
  const wetDepth = Math.max(...wet.map((c) => c.water - c.height));
  return {
    z: cs.map((c) => (c.hasWater ? c.water : level)),
    depth: cs.map((c) => (!c.hasWater && cliff ? wetDepth : c.water - c.height)),
  };
}

/** A tileset's water: animation frames (by index; null until loaded), frames per second and
 *  the colour ramp (r, g, b, a in 0–1). */
export interface WaterLook {
  frames: (WebGLTexture | null)[];
  rate: number;
  shallowMin: number[]; shallowMax: number[]; deepMin: number[]; deepMax: number[];
}

type WaterRamp = Pick<WaterLook, "shallowMin" | "shallowMax" | "deepMin" | "deepMax">;

/** The colour ramp the water is drawn with (the shader multiplies the texture by it). The map's water tint
 *  (war3map.w3i, stored blue, green, red, alpha; null when its tinting is off) multiplies the ramp, as the World
 *  Editor draws it in SD: 03b_Water_Tint's red tint (255, 100, 100) over Lordaeron's blue ramp and texture is a dark
 *  purple there (we-drive, SD, 2026-11-13: deep water 39, 19, 53 unlit; ramp times tint times the texture's mean
 *  gives 39, 17, 54). The game draws it plainly red instead; the user chose the editor's look. Its alpha scales the
 *  ramp's, so the shallows still fade out at the shore. */
export function waterRamp(look: WaterRamp, tint: number[] | null): WaterRamp {
  if (!tint) return { shallowMin: look.shallowMin, shallowMax: look.shallowMax, deepMin: look.deepMin, deepMax: look.deepMax };
  const [b, g, r, a = 255] = tint;
  const apply = (c: number[]) => [c[0] * (r / 255), c[1] * (g / 255), c[2] * (b / 255), c[3] * (a / 255)];
  return { shallowMin: apply(look.shallowMin), shallowMax: apply(look.shallowMax), deepMin: apply(look.deepMin), deepMax: apply(look.deepMax) };
}

/**
 * The water's colour in HD (sRGB, 0–1), as the World Editor draws it: Reforged's water doesn't take its colour
 * from Water.slk's HD ramp (Lordaeron's is green, 0, 200, 80; Northrend's near white; Barrens' pink) but comes
 * out a dark teal on every tileset measured (we-drive, game view on and off, 2026-11-08: Lordaeron 22, 54–61, 73;
 * Northrend 22, 48–52, 39–41; Barrens 25–26, 41–46, 42–44), Lordaeron Summer bluer, the one tileset with its own
 * water environment map (Environment\EnvironmentMap\LordaeronSummer\Water_IBL). A map's water tint takes that blue
 * away (03b_Water_Tint, red: 23, 50, 40) rather than showing its colour. Cityscape's water is blue (OrcX02_03's city
 * pool in game view, 2026-11-09: 50, 61, 121), and so is Sunken Ruins' (Z), which has the same HD Water.slk row
 * (shallow to deep 117, 117, 200 to 96, 96, 192): fitted on Murgul Oasis' shallow water in game view (we-drive,
 * 2026-11-12), with `shallow` as it is, over 2460 blocks of 16 × 16 pixels where the deep colour counts for up to 0.4.
 * With the teal its water was olive grey (whole picture blue 59 against the editor's 86, mean difference 18.6), with
 * Cityscape's colour 8.8 levels off per block, with this 6.4 (whole picture 9.9). Unproven in deep water.
 */
export function hdWaterColor(tileset: string, tinted: boolean): [number, number, number] {
  if (tinted) return [23 / 255, 47 / 255, 41 / 255];
  const own: Record<string, [number, number, number]> = { L: [22 / 255, 57 / 255, 73 / 255], Y: [50 / 255, 61 / 255, 121 / 255], Z: [30 / 255, 94 / 255, 174 / 255] };
  return own[tileset.toUpperCase()] ?? [23 / 255, 47 / 255, 41 / 255];
}

/** The brightness HD water's ripple is measured against until the texture is known (Lordaeron's Water00). */
const WATER_BRIGHTNESS = 0.45;

/** An image's mean brightness (0–1, Rec. 601 weights), from a small mip level; null if it can't be decoded. */
export function meanBrightness(img: DecodedImage): number | null {
  try {
    let level = 0;
    while (level + 1 < img.mipCount && img.height >> (level + 1) >= 16) level++;
    const { rgba } = img.mip(level);
    let sum = 0;
    for (let p = 0; p < rgba.length; p += 4) sum += 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2];
    return rgba.length ? sum / (rgba.length / 4) / 255 : null;
  } catch {
    return null;
  }
}

/** Until the game's water is known: an untextured blue-grey ramp. */
const WATER_DEFAULT: WaterLook = {
  frames: [], rate: 1,
  shallowMin: [0.12, 0.32, 0.5, 0.25], shallowMax: [0.12, 0.32, 0.5, 0.6], deepMin: [0.12, 0.32, 0.5, 0.6], deepMax: [0.1, 0.27, 0.45, 0.85],
};

// Building ground marks (splats): a texture draped over the ground, tinted, lit like the ground.
const SPLAT_VS = `#version 300 es
in vec3 aPos; in vec2 aUv;
uniform mat4 uViewProj;
out vec2 vUv; out highp vec3 vWorld;
${FOG_VS}
void main() { vUv = aUv; vWorld = aPos; gl_Position = uViewProj * vec4(aPos, 1.0); vFogDepth = gl_Position.w; }`;
const SPLAT_FS = `#version 300 es
precision mediump float;
in vec2 vUv; in highp vec3 vWorld;
// uLight lit, uShadeLight in the sun's full shadow (HD's real shadows, SUN_FS).
uniform sampler2D uTex; uniform vec4 uColor; uniform vec3 uLight; uniform vec3 uShadeLight;
out vec4 outColor;
${FOG_FS}
${TONE_FS}
${SUN_FS}
void main() {
  vec4 c = texture(uTex, vUv) * uColor;
  vec3 light = mix(uShadeLight, uLight, sunLit(vWorld, vec3(0.0, 0.0, 1.0)));
  outColor = vec4(fogged(toned(c.rgb, light)), c.a);
}`;

// Ground overlay: a texture spread over the map (one texel per 32×32 pathing
// cell), e.g. the pathing editor's view.
const OVERLAY_VS = `#version 300 es
in vec3 aPos;
uniform mat4 uViewProj; uniform vec4 uRect;
out vec2 vUV;
${FOG_VS}
void main() { vUV = (aPos.xy - uRect.xy) / uRect.zw; gl_Position = uViewProj * vec4(aPos, 1.0); vFogDepth = gl_Position.w; }`;
const OVERLAY_FS = `#version 300 es
precision mediump float; in vec2 vUV; uniform sampler2D uTex; out vec4 outColor;
${FOG_FS}
void main() { outColor = texture(uTex, vUV); if (outColor.a < 0.01) discard; outColor.rgb = fogged(outColor.rgb); }`;

// Grid lines over the ground, drawn per pixel so any map size costs the same: up to three sets of lines (finest first,
// every uSteps[i] world units from the map's corner, in uColors[i]), each fading out once its cells are too small to tell
// apart, the coarser lying over the finer.
const GRID_VS = `#version 300 es
in vec3 aPos;
uniform mat4 uViewProj;
out highp vec2 vW;
${FOG_VS}
void main() { vW = aPos.xy; gl_Position = uViewProj * vec4(aPos, 1.0); vFogDepth = gl_Position.w; }`;
const GRID_FS = `#version 300 es
precision highp float; in vec2 vW; uniform vec2 uOrigin; uniform float uSteps[3]; uniform int uLevels; uniform vec4 uColors[3]; out vec4 outColor;
${FOG_FS}
// p: the point from the grid's origin; fw: fwidth(p), taken once in main. A derivative inside the loop below (it ends
// on a uniform) is undefined on Direct3D, where Windows' WebGL runs (ANGLE): the lines came out faded to nothing there.
// fwidth(p / step) is fwidth(p) / step, the step being the same for the whole draw.
float lineAt(vec2 p, vec2 fw, float step) {
  vec2 g = p / step, w = max(fw / step, vec2(1e-6));
  vec2 d = abs(fract(g - 0.5) - 0.5) / w;
  // About a pixel wide and solid, as the World Editor's lines (solid within 0.4 of a pixel, gone at 0.9).
  return clamp(2.0 * (0.9 - min(d.x, d.y)), 0.0, 1.0) * (1.0 - smoothstep(0.2, 0.45, max(w.x, w.y)));
}
void main() {
  vec3 rgb = vec3(0.0); float a = 0.0;
  vec2 p = vW - uOrigin, fw = fwidth(p);
  for (int i = 0; i < 3; i++) {
    if (i >= uLevels) break;
    float ai = uColors[i].a * lineAt(p, fw, uSteps[i]);
    rgb = uColors[i].rgb * ai + rgb * (1.0 - ai);
    a = ai + a * (1.0 - ai);
  }
  if (a < 0.02) discard;
  outColor = vec4(fogged(rgb / a), a);
}`;

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

/** A ground-following circle (selection, brush outline). */
export interface Ring {
  x: number;
  y: number;
  /** Height of the ring when it doesn't follow the ground: round a doodad that has a height of its own. */
  z?: number;
  r: number;
  rgb: Vec3;
  /** A square outline (half side `r`) instead of a circle. */
  square?: boolean;
  /** A closed line through these points (x, y; on the ground or at `z`) instead of a circle: `x`, `y`, `r` unused. */
  outline?: readonly (readonly [number, number])[];
}

export interface Marker {
  x: number;
  y: number;
  z: number;
  rgb: Vec3;
}

/** What a placed object is, for picking. */
export interface PickInfo {
  /** Object data kind: w3d, w3b, w3u or w3t. */
  kind: string;
  id: string;
  /** Base object of a custom id. */
  base?: string;
  /** Position in the placement file's list. */
  index: number;
  placed: Placed;
  model: string;
  /** Model scale on top of the placement's own (units' skin scale). */
  extraScale: number;
  /** The scales it's drawn within (objects.ts scaleRange: a doodad type's minScale to maxScale); none: as stored. */
  scaleRange?: readonly [number, number];
}

export interface ObjectInstance {
  world: Mat4;
  team: number;
  pick?: PickInfo;
  /** World-space bounding sphere [x, y, z, r]. */
  sphere?: [number, number, number, number];
  /** The model's own bounding sphere [x, y, z, r], in model space: `sphere` is it placed by `world`. */
  bounds?: readonly [number, number, number, number];
  /** Drawn with another instance (a doodad's click helper): `world` is the owner's world times `local`, made again
   *  each frame, so it moves and turns with the owner. Such an instance has no `pick` of its own. */
  follows?: { owner: ObjectInstance; local: Mat4 };
}

/** One model placed any number of times; `group` is a toggle name (e.g. "doodads"). */
/** Particle emitters drawn for a batch's instances: the model's own, or (`classic`) those of the
 *  game's classic model for a Reforged one whose effects are PopcornFX. */
export interface EffectSource {
  model: Model;
  textures: (WebGLTexture | null)[];
  nodeWorld: Mat4[];
  clock: Clock;
  classic: boolean;
}

/** The order object groups are drawn in; others come after, in the order they came. */
export const GROUP_ORDER = ["cliffs", "shoreline", "doodads", "units"];

/** The batches with one group's replaced, at the group's place in GROUP_ORDER. */
export function withGroup<B extends { group: string }>(batches: readonly B[], group: string, replacement: readonly B[]): B[] {
  const rank = (g: string) => { const i = GROUP_ORDER.indexOf(g); return i < 0 ? GROUP_ORDER.length : i; };
  const others = batches.filter((b) => b.group !== group);
  const at = others.findIndex((b) => rank(b.group) > rank(group));
  return at < 0 ? [...others, ...replacement] : [...others.slice(0, at), ...replacement, ...others.slice(at)];
}

export interface ObjectBatch {
  group: string;
  gpu: ModelGpu;
  instances: ObjectInstance[];
  effects?: EffectSource;
  /** Bend the model onto the ground height map (cliffs). */
  followGround?: boolean;
  /** Drawn see-through with this colour and alpha, among the blended layers (start buildings). */
  tint?: [number, number, number, number];
  /** Only the editor shows it (start locations, start buildings): left out in game view (`showEditorOnly`). */
  editorOnly?: boolean;
}

/** Whether a batch's objects cast HD's real shadows: not see-through previews, the shoreline's waves or the cliffs.
 *  The World Editor's HD view casts nothing from cliffs, nor from the ground itself: cliff.w3m's picture is the same
 *  with View > Shadows on and off (we-drive, 2026-11-09). */
export function castsSunShadow(b: Pick<ObjectBatch, "group" | "instances" | "tint" | "followGround">): boolean {
  return b.instances.length > 0 && !b.tint && !b.followGround && b.group !== "cliffs" && b.group !== "shoreline";
}

/** How a batch's models take the border's shade past the playable map (EdgeShade's mode). The World Editor (we-drive,
 *  game view on and off, branch border-shade-models, 2026-11-13; TESTING.md "Border shade"): the cliffs and the special
 *  doodads, which are the ground's, as the ground and per pixel ("pixel": a cliff fades across the edge as the ground,
 *  three tiles past it a hollow keeps 0.146 of its colour, the SD ground 0.149); units, items and start locations black,
 *  whole, when the tile under them lies past the edge ("tile": a footman at the edge's corner line is lit, one 64
 *  further out black, in both modes); doodads and trees so in SD, and in HD the whole model as the ground at its origin
 *  ("object": a tree on the corner line is shaded whole, a hay cart 32 inside lit; three tiles out a tree keeps 0.107,
 *  a hay cart 0.071, the HD ground 0.088). The shore's waves lie on the border's black water: black. */
export function edgeMode(b: Pick<ObjectBatch, "group" | "followGround">, tone: Tone): EdgeShade["mode"] {
  if (b.group === "cliffs" || b.followGround) return "pixel";
  return b.group === "doodads" && tone === 2 ? "object" : "tile";
}

interface Mesh {
  vao: WebGLVertexArrayObject;
  count: number;
}

/** The sun's shadow map (HD): texels each way, how far above the ground in view a caster can stand and still be in
 *  it (flying units, tall trees and buildings), and how far from the eye (in camera distances) shadows are drawn. */
const SUN_MAP_SIZE = 2048, SUN_CASTER_HEIGHT = 800, SUN_REACH = 4;

/** Texture slot of the tileset's blight (beyond any ground tile index). */
export const BLIGHT_TEXTURE = 100;

/** A weather's emitter doesn't animate: it has one still node. */
const WEATHER_CLOCK = { frame: 0, seqStart: 0, seqEnd: 0, time: 0 };
const WEATHER_NODES = [new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])];

export class TerrainRenderer {
  readonly gl: WebGL2RenderingContext;
  private groundProg: WebGLProgram;
  private colorProg: WebGLProgram;
  private shapeProg: WebGLProgram;
  private ground: WebGLVertexArrayObject;
  /** Index range per ground texture, in draw order. */
  private ranges: { texture: number; offset: number; count: number }[] = [];
  private textures: ({ tex: WebGLTexture; extended: boolean } | null)[];
  private placeholder: WebGLTexture;
  private water: Mesh;
  private waterProg: WebGLProgram;
  /** The tileset's water (see setWaterLook); the default ramp until then. */
  private waterLook: WaterLook = WATER_DEFAULT;
  /** Water frame shown by the last render (the view redraws when it changes). */
  private waterFrameShown = -1;
  /** Mean brightness of the water's first frame (meanBrightness): HD water ripples around it. */
  private waterBrightness = WATER_BRIGHTNESS;
  /** White texture for untextured water. */
  private waterWhite: WebGLTexture;
  /** The map's water tint as stored (b, g, r, a in 0–255; see waterRamp) when tinting is on; null: none. */
  waterTint: number[] | null = null;
  private splatProg: WebGLProgram;
  /** Splat meshes by texture path and blend mode. */
  private splats: { texture: string; blend: number; color: number[]; vao: WebGLVertexArrayObject; count: number }[] = [];
  private splatTextures = new Map<string, WebGLTexture>();
  /** View > Shadows: the ground's shadow map (setShadowMap) and the units' shadow textures (setUnitShadows). */
  showShadows = true;
  /** How shadows are drawn (see viewshadows.ts SHADOW_LOOK): how much of the ground's picture a cell in full baked
   *  shadow and in an object's shadow image takes away, how much a unit's shadow texture at full alpha does, and
   *  how far (world units, east and north) the objects' shadow images lie from their cells. */
  shadowLook: { baked: number; stamp: number; unit: number; stampShift: [number, number] } = { baked: 0, stamp: 0, unit: 0, stampShift: [0, 0] };
  private shadowMap: WebGLTexture | null = null;
  /** No shadow anywhere: what the ground samples without a shadow map. */
  private noShadow: WebGLTexture;
  private unitShadows: { texture: string; vao: WebGLVertexArrayObject; count: number }[] = [];
  /** HD: the sun's shadow map of the models (sunshadow.ts), made on first use. */
  private sunMap: SunShadowMap | null = null;
  /** The last frame's: whether it cast the models' real shadows (HD, the map's lighting on, View > Shadows), how big a
   *  texel of the shadow map was on the ground, and how many instances cast into it. For tests and measuring. */
  readonly sunShadowState = { drawn: false, texel: 0, casters: 0 };
  /** The ground's lowest and highest point (water included), for fitting the shadow map; null: worked out again. */
  private heightRange: [number, number] | null = null;
  private overlayProg: WebGLProgram | null = null;
  private overlay: { vao: WebGLVertexArrayObject; count: number; pos: WebGLBuffer; tex: WebGLTexture } | null = null;
  /** The dark over the map's border: its own layer, as tools use the overlay. */
  private border: { vao: WebGLVertexArrayObject; count: number; pos: WebGLBuffer; tex: WebGLTexture } | null = null;
  showBorder = true;
  /** What the View toggles show over the ground (Height Map, Pathing - Naval, Camera Objects), one texture; tools keep `overlay`. */
  private viewLayer: { vao: WebGLVertexArrayObject; count: number; pos: WebGLBuffer; tex: WebGLTexture; top?: WebGLTexture } | null = null;
  private held: { viewLayer: { vao: WebGLVertexArrayObject; count: number; pos: WebGLBuffer; tex: WebGLTexture; top?: WebGLTexture } | null } | null = null;
  /** Grid lines every this many world units (0: none). */
  gridStep = 0;
  private gridProg: WebGLProgram | null = null;
  private gridMesh: { vao: WebGLVertexArrayObject; count: number; pos: WebGLBuffer } | null = null;
  /** The map's fog, and whether it's shown. */
  fog: Fog | null = null;
  showFog = true;
  /** A sky model drawn around the camera, and the radius it reaches at scale 1. */
  sky: { gpu: ModelGpu; radius: number } | null = null;
  showSky = true;
  private markers = new Map<string, Mesh>();
  /** Named sets of solid editor marks (the Camera Objects layer's cameras): coloured triangles, see setShapes. */
  private shapes = new Map<string, Mesh>();
  private selection: Mesh[] = [];
  showWater = true;
  /** The map's day/night lighting at the chosen hour: terrain (ground, cliffs, doodads) and
   *  units; null: a neutral default light. */
  terrainLight: SceneLight | null = null;
  unitLight: SceneLight | null = null;
  /** How lit colours become pixels: the graphics mode's (tone.ts). */
  tone: Tone = 2;

  /** A map light as it's drawn: in HD the editor's response to it (hdLight). */
  private drawnLight(l: SceneLight | null): SceneLight | null {
    return l && this.tone === 2 ? hdLight(l) : l;
  }

  /** The light on a flat surface (normal straight up: water, building marks), shaded as the ground is
   *  (shadeWrap); without the map's lighting the even light, 1. `sun` is already drawnLight's; `lit` how much of the
   *  sun gets there (0: in the real shadows' full shadow, see tone.ts sunLight). */
  private flatLight(sun: SceneLight | null, lit = 1): number[] {
    if (!sun) return [1, 1, 1];
    const wrap = shadeWrap(this.tone, sun);
    return [0, 1, 2].map((k) => sunLight(sun.ambient[k], sun.diffuse[k], [0, 0, 1], sun.dir, wrap, sun.fill ?? 0, lit));
  }
  /** Particle effects (fires, glows, …) of placed objects. */
  showEffects = true;
  private particleRenderer: ParticleRenderer | null = null;
  /** Particles per placed object (new instances after a rebuild start fresh). */
  private particleStates = new WeakMap<ObjectInstance, ParticleInstance>();
  private lastParticleTime = -1;
  /** The map's weather: over its box, or following the view without one. */
  weather: { effect: WeatherEffect; particles: ParticleInstance; texture: WebGLTexture | null; box: WeatherBox | null }[] = [];
  showWeather = true;
  /** Object groups (models and markers) that aren't drawn. */
  hiddenGroups = new Set<string>();
  /** Lit as the game is (the map's lighting on): the pair of the World Editor's game view. */
  gameView = false;
  /** The ground textured, as a wireframe (lines on black, no cliff models), or not drawn (View > Terrain). */
  groundLook: "textured" | "wireframe" | "hidden" = "textured";
  /** Batches marked `editorOnly` (the start locations and their start buildings) are drawn and picked. */
  showEditorOnly = true;
  /** Blighted ground shows the blight; off, its own tile (the ground is built again: see terrainChanged). */
  showBlight = true;
  /** Named sets of rings drawn over everything but the selection (the light ranges). */
  private ringSets = new Map<string, Mesh[]>();
  /** The wireframe of View > Terrain > Wireframe, made when first drawn and again after the ground changed. */
  private terrainWire: Mesh | null = null;

  /** Whether a group's objects are drawn: not hidden by its toggle, and not the shoreline waves in HD with the
   *  lighting on. The World Editor's HD game view draws no shoreline waves (map 03, we-drive 2026-11-08); its
   *  classic game view, and either mode without game view, does. */
  groupShown(group: string): boolean {
    if (group === "cliffs" && this.groundLook !== "textured") return false;
    return !this.hiddenGroups.has(group) && !(group === "shoreline" && this.gameView && this.tone === 2);
  }
  /** Whether a batch is drawn and can be picked: its group is shown, and it isn't an editor-only one hidden. */
  batchShown(b: Pick<ObjectBatch, "group" | "editorOnly">): boolean {
    return this.groupShown(b.group) && (this.showEditorOnly || !b.editorOnly);
  }
  /** A model previewing a placement (drawn see-through; red when `ok` is false). */
  ghost: { gpu: ModelGpu; world: Mat4; team: number; ok: boolean } | null = null;
  /** Several at once, for what's being pasted. */
  ghosts: NonNullable<TerrainRenderer["ghost"]>[] = [];
  readonly batches: ObjectBatch[] = [];

  /** Puts the batches of one group in place of its old ones. Groups keep a fixed order, so what is
   *  drawn over what (see-through layers blend in drawing order) doesn't follow which group
   *  finished loading first. */
  setGroup(group: string, batches: ObjectBatch[]) {
    const next = withGroup(this.batches, group, batches);
    this.batches.length = 0;
    this.batches.push(...next);
    // The instance buffers of batches that are gone go with them.
    const kept = new Set(next);
    for (const store of [this.instanceBuffers, this.sunInstanceBuffers, this.wetInstanceBuffers]) {
      for (const [b, buf] of store) if (!kept.has(b)) { this.gl.deleteBuffer(buf.buffer); store.delete(b); }
    }
  }

  /** Per batch, a GPU buffer of the world matrices of its instances in view, filled at each frame. */
  private instanceBuffers = new Map<ObjectBatch, { buffer: WebGLBuffer | null; bytes: number }>();
  /** The same for the instances that cast into the sun's shadow map (in view of the sun, not of the camera). */
  private sunInstanceBuffers = new Map<ObjectBatch, { buffer: WebGLBuffer | null; bytes: number }>();
  /** The same for the instances in view that may show through HD water (underWater), drawn into `waterDepth`. */
  private wetInstanceBuffers = new Map<ObjectBatch, { buffer: WebGLBuffer | null; bytes: number }>();
  /** HD: the depth picture of the models under water (viewdepth.ts), made on first use. */
  private waterDepth: ViewDepth | null = null;
  /** The last frame's: whether HD water read the depth picture of models under it, and how many were in it. */
  readonly waterDepthState = { drawn: false, models: 0 };
  /** Room to gather a batch's matrices before they're uploaded. */
  private instanceData = new Float32Array(16 * 1024);

  /** Fills a batch's instance buffer with its instances in view (all of them without `planes`), in runs
   *  of one player colour, and says what's where. */
  private gatherInstances(b: ObjectBatch, planes: Float32Array | null, store = this.instanceBuffers,
    opts: { from?: readonly ObjectInstance[]; wet?: ObjectInstance[] } = {}): InstanceRuns {
    const gl = this.gl;
    const byTeam = new Map<number, ObjectInstance[]>();
    let n = 0;
    // `from`: these instead of the batch's; `wet`: collects those in view that stand in the water (underWater).
    const { from = b.instances, wet } = opts;
    for (const inst of from) {
      if (inst.follows) {
        inst.world = mat4.mul(inst.follows.owner.world, inst.follows.local);
        if (inst.bounds) inst.sphere = worldSphere(inst.world, inst.bounds);
      }
      if (planes && inst.sphere && !sphereInView(planes, inst.sphere)) continue;
      if (wet && this.underWater(inst.world)) wet.push(inst);
      let list = byTeam.get(inst.team);
      if (!list) byTeam.set(inst.team, (list = []));
      list.push(inst);
      n++;
    }
    const runs: InstanceRuns["runs"] = [];
    let entry = store.get(b);
    if (!entry) store.set(b, (entry = { buffer: gl.createBuffer(), bytes: 0 }));
    if (!n) return { buffer: entry.buffer, runs };
    if (this.instanceData.length < n * 16) this.instanceData = new Float32Array(Math.max(n * 16, this.instanceData.length * 2));
    const data = this.instanceData;
    let at = 0;
    for (const [team, list] of byTeam) {
      runs.push({ team, first: at, count: list.length });
      for (const inst of list) data.set(inst.world, (at++) * 16);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, entry.buffer);
    if (entry.bytes < n * INSTANCE_BYTES) {
      entry.bytes = Math.max(n, 16, (entry.bytes / INSTANCE_BYTES) * 2) * INSTANCE_BYTES;
      gl.bufferData(gl.ARRAY_BUFFER, entry.bytes, gl.DYNAMIC_DRAW);
    }
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, data, 0, n * 16);
    return { buffer: entry.buffer, runs };
  }
  /** Camera: looks at `target` from `distance` away. */
  yaw = -Math.PI / 2;
  pitch = 0.95;
  /** Vertical field of view (radians). */
  fov = Math.PI / 4;
  distance: number;
  target: Vec3;
  readonly center: Vec3;
  /** Ground heights without cliff layers, for models that follow the terrain. */
  private heightMap: HeightMap;
  /** Tiles covered by cliff models and the cliff ground rim, kept for rebuilds. */
  private cliffTiles = new Set<number>();
  private groundOverrides = new Map<number, number>();
  /** Brush outline under the pointer (editing tools). */
  private brush: Mesh | null = null;

  constructor(readonly canvas: HTMLCanvasElement, readonly terrain: Terrain) {
    // Opaque: blended layers (leaves, the boundary's shade) would otherwise leave the picture part see-through,
    // and the page behind lightened them, as pale ghosts in a fog that hides everything else.
    const gl = canvas.getContext("webgl2", { antialias: true, alpha: false });
    if (!gl) throw new Error("WebGL2 is not available");
    this.gl = gl;
    this.groundProg = compile(gl, GROUND_VS, GROUND_FS);
    this.colorProg = compile(gl, COLOR_VS, COLOR_FS);
    this.shapeProg = compile(gl, SHAPE_VS, SHAPE_FS);
    this.waterProg = compile(gl, WATER_VS, WATER_FS);
    this.splatProg = compile(gl, SPLAT_VS, SPLAT_FS);
    this.waterWhite = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.waterWhite);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
    this.noShadow = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.noShadow);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
    this.textures =terrain.groundTiles.map(() => null);
    this.placeholder = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.placeholder);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([110, 110, 100, 255]));
    this.ground = this.buildGround();
    this.water = this.buildWater();
    this.heightMap = this.buildHeightMap();
    this.refreshBorder();

    const t = terrain, w = (t.width - 1) * 128, h = (t.height - 1) * 128;
    this.center = [t.offsetX + w / 2, t.offsetY + h / 2, 0];
    this.target = [...this.center];
    this.distance = Math.max(w, h) * 0.9;
  }

  private corner(x: number, y: number) {
    return this.terrain.corners[y * this.terrain.width + x];
  }

  /** Normal at a corner from its neighbours' heights. */
  private normal(x: number, y: number): Vec3 {
    return cornerNormal(this.terrain, x, y);
  }

  /** Rebuilds the ground without the tiles that cliff models cover, with
   *  ground textures replaced at some corners (corner index → texture). */
  setCliffTiles(tiles: Set<number>, overrides = new Map<number, number>()) {
    this.cliffTiles = tiles;
    this.groundOverrides = overrides;
    this.freeVao(this.ground);
    this.ranges = [];
    this.ground = this.buildGround(tiles, overrides);
  }

  /** Rebuilds everything derived from the corners after an edit. */
  terrainChanged() {
    const gl = this.gl;
    this.setCliffTiles(this.cliffTiles, this.groundOverrides);
    this.heightRange = null;
    this.freeVao(this.water.vao);
    this.water = this.buildWater();
    if (this.terrainWire) { this.freeVao(this.terrainWire.vao); this.terrainWire = null; }
    // Same size, new heights: the overlays' meshes only get new positions.
    for (const layer of [this.overlay, this.border, this.viewLayer, this.held?.viewLayer, this.gridMesh]) if (layer) this.reshapeOverlay(layer.pos);
    // The marks of the tiles past the playable map are part of the corners too.
    this.refreshBorder();
    gl.bindTexture(gl.TEXTURE_2D, this.heightMap.texture);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.terrain.width, this.terrain.height, gl.RED, gl.FLOAT, this.groundHeights());
  }

  private groundHeights(): Float32Array {
    return new Float32Array(this.terrain.corners.map((c) => c.height - (c.layer - 2) * 128));
  }

  private buildGround(skip = new Set<number>(), overrides = new Map<number, number>()): WebGLVertexArrayObject {
    const t = this.terrain, gl = this.gl;
    // Quads per texture so each texture is one draw call.
    const perTexture: number[][] = t.groundTiles.map(() => []);
    const normals: Vec3[] = [];
    for (let y = 0; y < t.height; y++) for (let x = 0; x < t.width; x++) normals.push(this.normal(x, y));

    for (let y = 0; y < t.height - 1; y++) {
      for (let x = 0; x < t.width - 1; x++) {
        if (skip.has(y * (t.width - 1) + x)) continue;
        const bl = this.corner(x, y), br = this.corner(x + 1, y), tl = this.corner(x, y + 1), tr = this.corner(x + 1, y + 1);
        // Blight covers everything, so it gets its own slot drawn last.
        const tex = (cx: number, cy: number) => (this.corner(cx, cy).blight && this.showBlight ? BLIGHT_TEXTURE : overrides.get(cy * t.width + cx) ?? this.corner(cx, cy).texture);
        const [tBl, tBr, tTl, tTr] = [tex(x, y), tex(x + 1, y), tex(x, y + 1), tex(x + 1, y + 1)];
        const used = [...new Set([tBl, tBr, tTl, tTr])].sort((a, b) => a - b);
        // Tiles at the camera boundary are shown darkened, like the editor does.
        const shade = bl.boundary || br.boundary || tl.boundary || tr.boundary ? 0.35 : 1;
        used.forEach((id, i) => {
          const cell = i === 0
            ? -1 - bl.variation
            : (tTl === id ? 8 : 0) | (tTr === id ? 4 : 0) | (tBl === id ? 2 : 0) | (tBr === id ? 1 : 0);
          const quad = perTexture[id] ?? (perTexture[id] = []);
          const push = (cx: number, cy: number, u: number, v: number) => {
            const c = this.corner(cx, cy), n = normals[cy * t.width + cx];
            quad.push(t.offsetX + cx * 128, t.offsetY + cy * 128, c.height + rampLift(t, cx, cy), n[0], n[1], n[2], u, v, cell, shade);
          };
          // Image rows run top-down: the tile's north edge is v = 0.
          push(x, y, 0, 1); push(x + 1, y, 1, 1); push(x + 1, y + 1, 1, 0); push(x, y + 1, 0, 0);
        });
      }
    }

    const floats = perTexture.reduce((n, q) => n + q.length, 0);
    const data = new Float32Array(floats);
    const quads = floats / 40;
    const index = new Uint32Array(quads * 6);
    let fo = 0, qo = 0;
    perTexture.forEach((q, texture) => {
      if (!q.length) return;
      data.set(q, fo);
      const n = q.length / 40;
      this.ranges.push({ texture, offset: qo * 6, count: n * 6 });
      for (let i = 0; i < n; i++) {
        const b = (qo + i) * 4;
        index.set([b, b + 1, b + 2, b, b + 2, b + 3], (qo + i) * 6);
      }
      fo += q.length;
      qo += n;
    });

    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const vb = this.buf(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vb);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    const attr = (name: string, size: number, offset: number) => {
      const loc = gl.getAttribLocation(this.groundProg, name);
      if (loc < 0) return;
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 40, offset * 4);
    };
    attr("aPos", 3, 0); attr("aNormal", 3, 3); attr("aLocal", 2, 6); attr("aCell", 1, 8); attr("aShade", 1, 9);
    const ib = this.buf(vao);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, index, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    return vao;
  }

  private buildHeightMap(): HeightMap {
    const t = this.terrain, gl = this.gl;
    const data = this.groundHeights();
    const texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, t.width, t.height, 0, gl.RED, gl.FLOAT, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    return { texture, x: t.offsetX, y: t.offsetY, width: t.width, height: t.height };
  }

  private colorMesh(data: number[]): Mesh {
    const gl = this.gl, vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const b = this.buf(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW);
    const pos = gl.getAttribLocation(this.colorProg, "aPos"), col = gl.getAttribLocation(this.colorProg, "aColor");
    gl.enableVertexAttribArray(pos);
    gl.vertexAttribPointer(pos, 3, gl.FLOAT, false, 28, 0);
    gl.enableVertexAttribArray(col);
    gl.vertexAttribPointer(col, 4, gl.FLOAT, false, 28, 12);
    gl.bindVertexArray(null);
    return { vao, count: data.length / 7 };
  }

  /** Water tiles: position, texture coordinate (one copy per tile), depth in cliff layers. */
  private buildWater(): Mesh {
    const t = this.terrain, gl = this.gl, out: number[] = [];
    const surfaces = new Float32Array((t.width - 1) * (t.height - 1)).fill(NaN);
    const dark = darkWaterCorners(t, this.edgeTiles());
    for (let y = 0; y < t.height - 1; y++) {
      for (let x = 0; x < t.width - 1; x++) {
        const cs = [this.corner(x, y), this.corner(x + 1, y), this.corner(x + 1, y + 1), this.corner(x, y + 1)];
        const tile = waterTile(cs);
        if (!tile) continue;
        surfaces[y * (t.width - 1) + x] = Math.max(...tile.z);
        const v = cs.map((_, i) => {
          const dx = i === 1 || i === 2 ? 1 : 0, dy = i >= 2 ? 1 : 0;
          return [t.offsetX + (x + dx) * 128, t.offsetY + (y + dy) * 128, tile.z[i], dx, 1 - dy, tile.depth[i] / 128, dark[(y + dy) * t.width + x + dx]];
        });
        out.push(...v[0], ...v[1], ...v[2], ...v[0], ...v[2], ...v[3]);
      }
    }
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const vb = this.buf(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vb);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(out), gl.STATIC_DRAW);
    const attr = (name: string, size: number, offset: number) => {
      const loc = gl.getAttribLocation(this.waterProg, name);
      if (loc < 0) return;
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 28, offset * 4);
    };
    attr("aPos", 3, 0); attr("aUv", 2, 3); attr("aDepth", 1, 5); attr("aDark", 1, 6);
    gl.bindVertexArray(null);
    this.wet = wetLevels(t.width - 1, t.height - 1, (x, y) => {
      const s = surfaces[y * (t.width - 1) + x];
      return Number.isNaN(s) ? null : s;
    });
    return { vao, count: out.length / 7 };
  }

  /** Per tile, the highest water surface near it (wetLevels), made with the water. */
  private wet = new Float32Array(0);

  /** Whether a placed model stands in the water near it, so that parts of it may show through: its origin (where it's
   *  drawn: a swimming unit's or a ship's on the surface, a unit wading through a ford on the bed) at most a little
   *  above the surface. Trees and buildings on the shore stand above it; flying units fly above it. */
  private underWater(world: Mat4): boolean {
    const t = this.terrain, tx = Math.floor((world[12] - t.offsetX) / 128), ty = Math.floor((world[13] - t.offsetY) / 128);
    if (tx < 0 || ty < 0 || tx >= t.width - 1 || ty >= t.height - 1) return false;
    return world[14] < this.wet[ty * (t.width - 1) + tx] + WET_MARGIN;
  }

  /** Building ground marks: squares (half-size `scale`) draped over the ground in 32-unit
   *  cells, grouped by texture, blend mode and colour. */
  setSplats(list: { x: number; y: number; scale: number; texture: string; blend: number; color: number[] }[]) {
    for (const s of this.splats) this.freeVao(s.vao);
    const groups = new Map<string, { texture: string; blend: number; color: number[]; data: number[] }>();
    for (const s of list) {
      const key = `${s.texture}|${s.blend}|${s.color.join(",")}`;
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { texture: s.texture, blend: s.blend, color: s.color, data: [] }));
      this.drapeQuad(g.data, s.x - s.scale, s.y - s.scale, 2 * s.scale, 2 * s.scale);
    }
    this.splats = [...groups.values()].map((g) => ({ texture: g.texture, blend: g.blend, color: g.color, vao: this.drapedVao(g.data), count: g.data.length / 5 }));
  }

  /** A texture's square draped over the ground in 32-unit cells: position and texture coordinate per vertex. */
  private drapeQuad(data: number[], x0: number, y0: number, w: number, h: number) {
    const t = this.terrain;
    const nx = Math.max(1, Math.ceil(w / 32)), ny = Math.max(1, Math.ceil(h / 32));
    const v = (i: number, j: number) => {
      const x = x0 + (w * i) / nx, y = y0 + (h * j) / ny;
      return [x, y, heightAt(t, x, y) + 2, i / nx, 1 - j / ny];
    };
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      data.push(...v(i, j), ...v(i + 1, j), ...v(i + 1, j + 1), ...v(i, j), ...v(i + 1, j + 1), ...v(i, j + 1));
    }
  }

  private drapedVao(data: number[]): WebGLVertexArrayObject {
    const gl = this.gl;
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const vb = this.buf(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vb);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW);
    const attr = (name: string, size: number, offset: number) => {
      const loc = gl.getAttribLocation(this.splatProg, name);
      if (loc < 0) return;
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 20, offset * 4);
    };
    attr("aPos", 3, 0); attr("aUv", 2, 3);
    gl.bindVertexArray(null);
    return vao;
  }

  /** The ground's shadow map: two values per 32 × 32 cell (baked, objects' images; 0 lit, 255 in shadow, see
   *  viewshadows.ts groundShadows), rows from the south, over the whole map; null: none. Filtered between cells, as
   *  the World Editor softens it. */
  setShadowMap(values: Uint8Array | null, width = 0, height = 0) {
    const gl = this.gl;
    if (!values) { if (this.shadowMap) gl.deleteTexture(this.shadowMap); this.shadowMap = null; return; }
    if (gl.isContextLost()) return;
    this.shadowMap ??= gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.shadowMap);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG8, width, height, 0, gl.RG, gl.UNSIGNED_BYTE, values);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  /** The units' shadows: textures (by path; their images come through setSplatTexture) draped over the ground,
   *  each over its rectangle (x0, y0 the south-west corner). */
  setUnitShadows(list: { x0: number; y0: number; w: number; h: number; texture: string }[]) {
    for (const s of this.unitShadows) this.freeVao(s.vao);
    const groups = new Map<string, number[]>();
    for (const s of list) {
      let data = groups.get(s.texture);
      if (!data) groups.set(s.texture, (data = []));
      this.drapeQuad(data, s.x0, s.y0, s.w, s.h);
    }
    this.unitShadows = [...groups].map(([texture, data]) => ({ texture, vao: this.drapedVao(data), count: data.length / 5 }));
  }

  setSplatTexture(path: string, img: DecodedImage) {
    this.splatTextures.set(path.toLowerCase(), createTexture(this.gl, img, { repeat: [false, false] }));
  }

  /** The tileset's water (frames are filled in by setWaterFrame as they load). */
  setWaterLook(look: Omit<WaterLook, "frames">, frames: number) {
    this.waterLook = { ...look, frames: new Array(frames).fill(null) };
    this.waterFrameShown = -1;
  }

  setWaterFrame(i: number, img: DecodedImage) {
    if (i >= this.waterLook.frames.length) return;
    this.waterLook.frames[i] = createTexture(this.gl, img, { repeat: [true, true] });
    if (i === 0) this.waterBrightness = meanBrightness(img) ?? WATER_BRIGHTNESS;
  }

  /** The water animation frame for now. */
  private waterFrame(): number {
    const n = this.waterLook.frames.length;
    return n > 1 ? Math.floor((performance.now() / 1000) * this.waterLook.rate) % n : 0;
  }

  /** View > Terrain > Wireframe: every tile's edges and one diagonal, green, as the World Editor draws it. */
  private buildTerrainWire(): Mesh {
    const t = this.terrain, out: number[] = [];
    const p = (x: number, y: number) => [t.offsetX + x * 128, t.offsetY + y * 128, this.corner(x, y).height + rampLift(t, x, y), 0.15, 0.85, 0.15, 0.9];
    for (let y = 0; y < t.height; y++) for (let x = 0; x < t.width; x++) {
      if (x + 1 < t.width) out.push(...p(x, y), ...p(x + 1, y));
      if (y + 1 < t.height) out.push(...p(x, y), ...p(x, y + 1));
      if (x + 1 < t.width && y + 1 < t.height) out.push(...p(x, y), ...p(x + 1, y + 1));
    }
    return this.colorMesh(out);
  }

  /** Shows an RGBA texture over the ground (`width` × `height` texels, rows from
   *  the south, covering the whole map); null removes it. Re-calling with the
   *  same size only re-uploads the pixels. */
  /** Everything shown, whatever the user switched off, apart from what the tool asks to `hide`,
   *  until the function it returns runs: a tool sees the map, not this person's way of looking at it. */
  showEverything(hide: { groups: string[]; water: boolean } = { groups: [], water: false }) {
    const { hiddenGroups, showWater, showEffects, overlay, showBorder, showFog, showSky, showWeather, viewLayer, gridStep, groundLook, showEditorOnly, ringSets } = this;
    // The view layer is put aside, not dropped: a layer set while this lasts goes there, and is what comes back.
    this.held = { viewLayer };
    this.groundLook = "textured";
    this.showEditorOnly = true;
    this.ringSets = new Map();
    this.hiddenGroups = new Set(hide.groups);
    this.showWater = !hide.water;
    this.showEffects = true;
    this.overlay = null;
    this.viewLayer = null;
    this.gridStep = 0;
    this.showBorder = false;
    this.showFog = false;
    this.showSky = false;
    this.showWeather = false;
    return () => {
      this.setGroundOverlay(null);
      const held = this.held;
      this.held = null;
      // Rings set while this lasted (none: the picture is taken in one go) replace the ones put aside.
      for (const [name, rings] of this.ringSets) { ringSets.get(name)?.forEach((r) => this.freeVao(r.vao)); ringSets.set(name, rings); }
      Object.assign(this, { hiddenGroups, showWater, showEffects, overlay, showBorder, showFog, showSky, showWeather, viewLayer: held?.viewLayer ?? null, gridStep, groundLook, showEditorOnly, ringSets });
    };
  }

  setGroundOverlay(rgba: Uint8Array | null, width = 0, height = 0) {
    const gl = this.gl;
    if (!rgba) {
      if (this.overlay) { this.freeVao(this.overlay.vao); gl.deleteTexture(this.overlay.tex); }
      this.overlay = null;
      return;
    }
    if (!this.overlayProgram()) return;
    if (!this.overlay) {
      const tex = gl.createTexture()!;
      this.overlay = { ...this.overlayMesh(), tex };
    }
    this.uploadOverlay(this.overlay.tex, rgba, width, height);
  }

  /** The View toggles' picture (one texel per pathing cell, rows from the south); null removes it. */
  setViewLayer(rgba: Uint8Array | null, width = 0, height = 0, top: Uint8Array | null = null) {
    const gl = this.gl;
    // While showEverything lasts the layer lives in `held`; the picture taken doesn't show it.
    const slot = this.held ?? (this as unknown as NonNullable<TerrainRenderer["held"]>);
    if (!rgba) {
      if (slot.viewLayer) { this.freeVao(slot.viewLayer.vao); gl.deleteTexture(slot.viewLayer.tex); if (slot.viewLayer.top) gl.deleteTexture(slot.viewLayer.top); }
      slot.viewLayer = null;
      return;
    }
    if (!this.overlayProgram()) return;
    slot.viewLayer ??= { ...this.overlayMesh(), tex: gl.createTexture()! };
    this.uploadOverlay(slot.viewLayer.tex, rgba, width, height);
    // `top`: the part drawn after the water (over the border: Pathing - Ground and Regions show over water there).
    if (top) { slot.viewLayer.top ??= gl.createTexture()!; this.uploadOverlay(slot.viewLayer.top, top, width, height); }
    else if (slot.viewLayer.top) { gl.deleteTexture(slot.viewLayer.top); slot.viewLayer.top = undefined; }
  }

  /** The w3i's camera complements (left, right, bottom, top, in tiles), which say where the playable map ends; null
   *  until the editor has read them (or when the w3i can't say), and the terrain's own marks stand in. */
  private complements: number[] | null = null;

  /** The playable map as the w3i's camera complements leave it (null: the terrain's marks stand in). The border's
   *  shade and its black water follow; nothing is made again when they didn't change. */
  setPlayable(complements: readonly number[] | null) {
    const next = complements ? [...complements] : null;
    if (JSON.stringify(next) === JSON.stringify(this.complements)) return;
    this.complements = next;
    this.refreshBorder();
    this.freeVao(this.water.vao);
    this.water = this.buildWater();
  }

  /** The tiles past the playable map (1 per tile, rows from the south): by the w3i's complements, as the World Editor
   *  draws them (w3e.ts playableEdgeTiles), else by the terrain's marks. */
  edgeTiles(): Uint8Array {
    return this.complements ? playableEdgeTiles(this.terrain, this.complements) : mapEdgeTiles(this.terrain);
  }

  /** The border's shade over the tiles past the playable map (edgeTiles, area.ts borderShade): made with the
   *  renderer, after each change of the corners and when the playable map changes (setPlayable). */
  refreshBorder() {
    if (!this.overlayProgram()) return;
    // Most edits leave the edge alone, and a big map's shade has millions of texels: made again only when it moved.
    const marks = this.edgeTiles();
    if (this.border && this.borderMarks && sameBytes(marks, this.borderMarks)) return;
    this.borderMarks = marks;
    this.playRect = playRect(this.terrain, marks);
    const { rgba, width, height } = borderShade(this.terrain, marks);
    this.border ??= { ...this.overlayMesh(), tex: this.gl.createTexture()! };
    this.uploadOverlay(this.border.tex, rgba, width, height, true);
  }
  /** The marks the border's shade was made from. */
  private borderMarks: Uint8Array | null = null;
  /** The playable rectangle round them, for HD water's dark edge (playRect). */
  private playRect: [number, number, number, number] = [0, 0, 0, 0];

  /** Where the border's texture lies in the world (x, y, width, height): its texels sit on the pathing cells' corners
   *  (borderShade), half a cell past the terrain's rim. */
  private borderRect(): [number, number, number, number] {
    const t = this.terrain, half = 16;
    return [t.offsetX - half, t.offsetY - half, (t.width - 1) * 128 + 2 * half, (t.height - 1) * 128 + 2 * half];
  }

  /** The border's shade for the placed models (EdgeShade: cliffs, doodads, specials, units, items, start locations,
   *  the shore's waves), from the ground's own texture, so what's shaded as the ground fades out over the same first
   *  playable cell; each batch takes it as edgeMode says. Null when the ground's shade isn't drawn (Boundary off, or
   *  no textured ground). */
  private edgeShade(textured: boolean): EdgeShade | null {
    if (!textured || !this.showBorder || !this.border) return null;
    // Four texels a tile (borderShade: one per pathing cell's corner).
    return { texture: this.border.tex, rect: this.borderRect(), tiles: [this.terrain.offsetX, this.terrain.offsetY, 128, 4], mode: "pixel" };
  }

  /** The overlay program, compiled the first time; null once the context is gone (the editor closed
   *  while a file was still being read for a layer): a shader can't compile then, and nothing is drawn anyway. */
  private overlayProgram(): WebGLProgram | null {
    if (this.gl.isContextLost()) return null;
    return (this.overlayProg ??= compile(this.gl, OVERLAY_VS, OVERLAY_FS));
  }

  /** `smooth`: drawn blended between the texels (the border's shade), else a texel's square each. */
  private uploadOverlay(tex: WebGLTexture, rgba: Uint8Array, width: number, height: number, smooth = false) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    const filter = smooth ? gl.LINEAR : gl.NEAREST;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  /** Every buffer made for a vertex array, so that dropping the array drops them too. */
  private vaoBuffers = new Map<WebGLVertexArrayObject, WebGLBuffer[]>();
  private buf(vao: WebGLVertexArrayObject): WebGLBuffer {
    const b = this.gl.createBuffer()!;
    const list = this.vaoBuffers.get(vao);
    if (list) list.push(b); else this.vaoBuffers.set(vao, [b]);
    return b;
  }
  private freeVao(vao: WebGLVertexArrayObject) {
    for (const b of this.vaoBuffers.get(vao) ?? []) this.gl.deleteBuffer(b);
    this.vaoBuffers.delete(vao);
    this.gl.deleteVertexArray(vao);
  }

  /** Corner positions for the overlay meshes, a little above the ground. */
  private overlayPositions(): Float32Array {
    const t = this.terrain;
    const pos = new Float32Array(t.width * t.height * 3);
    for (let y = 0; y < t.height; y++) for (let x = 0; x < t.width; x++) {
      const o = (y * t.width + x) * 3;
      pos[o] = t.offsetX + x * 128; pos[o + 1] = t.offsetY + y * 128; pos[o + 2] = this.corner(x, y).height + rampLift(t, x, y) + 2;
    }
    return pos;
  }

  /** The ground changed height: the same mesh, new positions. */
  private reshapeOverlay(pos: WebGLBuffer) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, pos);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.overlayPositions());
  }

  /** Ground-hugging tile quads for the overlay (positions only). */
  private overlayMesh(prog = this.overlayProg!): { vao: WebGLVertexArrayObject; count: number; pos: WebGLBuffer } {
    const t = this.terrain, gl = this.gl;
    const idx = new Uint32Array((t.width - 1) * (t.height - 1) * 6);
    let k = 0;
    for (let y = 0; y < t.height - 1; y++) for (let x = 0; x < t.width - 1; x++) {
      const a = y * t.width + x, b = a + 1, c = a + t.width, d = c + 1;
      idx.set([a, b, d, a, d, c], k); k += 6;
    }
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const pos = this.buf(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, pos);
    gl.bufferData(gl.ARRAY_BUFFER, this.overlayPositions(), gl.DYNAMIC_DRAW);
    const loc = gl.getAttribLocation(prog, "aPos");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 3, gl.FLOAT, false, 12, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.buf(vao));
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    return { vao, count: idx.length, pos };
  }

  /** Replaces a named group of point markers (e.g. "doodads", "units"). */
  setMarkers(name: string, markers: Marker[]) {
    const old = this.markers.get(name);
    if (old) this.freeVao(old.vao);
    this.markers.set(name, this.colorMesh(markers.flatMap((m) => [m.x, m.y, m.z + 8, m.rgb[0] / 255, m.rgb[1] / 255, m.rgb[2] / 255, 1])));
  }

  /** Replaces a named set of solid marks: triangles, 10 floats per corner (x, y, z, the face's normal, then r, g, b, a
   *  in 0..1: the colour before light), drawn with depth over the ground and models and lit as the units are
   *  (SHAPE_FS); null or [] removes it. Like the view layer, left out of showEverything's picture. */
  setShapes(name: string, triangles: readonly number[] | null) {
    const old = this.shapes.get(name);
    if (old) this.freeVao(old.vao);
    this.shapes.delete(name);
    if (!triangles?.length) return;
    const gl = this.gl, vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf(vao));
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(triangles), gl.STATIC_DRAW);
    for (const [attr, size, at] of [["aPos", 3, 0], ["aNormal", 3, 12], ["aColor", 4, 24]] as const) {
      const loc = gl.getAttribLocation(this.shapeProg, attr);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 40, at);
    }
    gl.bindVertexArray(null);
    this.shapes.set(name, { vao, count: Math.floor(triangles.length / 10) });
  }

  /** How many corners each set of shapes has (for tests and the app's state). */
  shapeCounts(): Record<string, number> {
    return Object.fromEntries([...this.shapes].map(([name, m]) => [name, m.count]));
  }

  /** How many rings each named set has (setRings; for tests and the app's state). */
  ringCounts(): Record<string, number> {
    return Object.fromEntries([...this.ringSets].map(([name, rings]) => [name, rings.length]));
  }

  setGroundTexture(i: number, img: DecodedImage) {
    // Deeper mip levels would blend neighbouring cells together.
    const tex = createTexture(this.gl, img, { repeat: [false, false], maxLevel: Math.max(0, Math.log2(img.height / 4) - 3) });
    this.textures[i] = { tex, extended: img.width > img.height };
  }

  /** Camera position. */
  eye(): Vec3 {
    return [
      this.target[0] + this.distance * Math.cos(this.pitch) * Math.cos(this.yaw),
      this.target[1] + this.distance * Math.cos(this.pitch) * Math.sin(this.yaw),
      this.target[2] + this.distance * Math.sin(this.pitch),
    ];
  }

  /** World-space ray through a canvas point (CSS pixels). Matches render()'s camera. */
  ray(px: number, py: number): { origin: Vec3; dir: Vec3 } {
    const w = Math.max(1, this.canvas.clientWidth), h = Math.max(1, this.canvas.clientHeight);
    const eye = this.eye();
    const f = norm([this.target[0] - eye[0], this.target[1] - eye[1], this.target[2] - eye[2]]);
    const r = norm([f[1], -f[0], 0]);
    const u: Vec3 = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
    const t = Math.tan(this.fov / 2), nx = ((px / w) * 2 - 1) * t * (w / h), ny = (1 - (py / h) * 2) * t;
    return { origin: eye, dir: norm([f[0] + r[0] * nx + u[0] * ny, f[1] + r[1] * nx + u[1] * ny, f[2] + r[2] * nx + u[2] * ny]) };
  }

  /** Ground height (layers and ramps included) at a world point, bilinear between corners. */
  groundHeight(x: number, y: number): number {
    return heightAt(this.terrain, x, y);
  }

  /** The nearest placed object a ray hits. With `radiusOf`, objects are
   *  upright cylinders of that radius (their footprint) standing at their
   *  position up to the top of the model; otherwise the model's bounding sphere.
   *  `extra` are objects drawn without a model of their own (the stand-ins of
   *  objects shown as markers), picked the same way; a hidden group's are left out too. */
  pickObject(ray: { origin: Vec3; dir: Vec3 }, radiusOf?: (inst: ObjectInstance) => number | undefined,
    extra: readonly { group: string; inst: ObjectInstance }[] = []): ObjectInstance | null {
    const { origin: o, dir: d } = ray;
    let best: ObjectInstance | null = null, bestT = Infinity;
    const sources = [...this.batches.map((b) => ({ group: b.group, instances: b.instances, editorOnly: b.editorOnly })),
      ...extra.map((s) => ({ group: s.group, instances: [s.inst], editorOnly: s.inst.pick?.id === "sloc" }))];
    for (const b of sources) {
      // By the toggles alone: what's left out otherwise (the shoreline) has nothing to pick. Nor have the start
      // locations in game view.
      if (this.hiddenGroups.has(b.group) || (b.editorOnly && !this.showEditorOnly)) continue;
      for (const inst of b.instances) {
        // A doodad's click helper picks its doodad, by the helper's own sphere.
        const target = inst.follows?.owner ?? inst, pick = target.pick;
        if (!pick || !inst.sphere) continue;
        const [cx, cy, cz, sr] = inst.sphere;
        const r = inst.follows ? undefined : radiusOf?.(inst);
        let t = Infinity;
        if (r === undefined) {
          const ox = o[0] - cx, oy = o[1] - cy, oz = o[2] - cz;
          const p = ox * d[0] + oy * d[1] + oz * d[2], q = ox * ox + oy * oy + oz * oz - sr * sr;
          const disc = p * p - q;
          if (disc >= 0) t = -p - Math.sqrt(disc);
        } else {
          const [px, py, pz] = pick.placed.position;
          const bottom = pz - 16, top = Math.max(pz + 32, cz + sr * 0.8);
          // Side of the cylinder (the xy circle), then its top cap.
          const ox = o[0] - px, oy = o[1] - py;
          const a = d[0] * d[0] + d[1] * d[1], bq = ox * d[0] + oy * d[1], c = ox * ox + oy * oy - r * r;
          const disc = bq * bq - a * c;
          if (a > 1e-9 && disc >= 0) {
            const t0 = (-bq - Math.sqrt(disc)) / a, t1 = (-bq + Math.sqrt(disc)) / a;
            for (const tt of [t0, t1]) {
              const z = o[2] + d[2] * tt;
              if (tt > 0 && z >= bottom && z <= top) { t = Math.min(t, tt); break; }
            }
          }
          if (Math.abs(d[2]) > 1e-9) {
            const tc = (top - o[2]) / d[2];
            const hx = o[0] + d[0] * tc - px, hy = o[1] + d[1] * tc - py;
            if (tc > 0 && hx * hx + hy * hy <= r * r) t = Math.min(t, tc);
          }
        }
        if (t > 0 && t < bestT) { bestT = t; best = target; }
      }
    }
    return best;
  }

  /** Where a ray meets the ground, or null if it misses the map. */
  pickGround(ray: { origin: Vec3; dir: Vec3 }): Vec3 | null {
    const { origin: o, dir: d } = ray;
    const at = (t: number): Vec3 => [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t];
    const above = (t: number) => { const p = at(t); return p[2] > this.groundHeight(p[0], p[1]); };
    const step = 32, far = this.distance * 10;
    let lo = 0;
    for (let t = step; t < far; t += step) {
      if (above(t)) { lo = t; continue; }
      let hi = t;
      for (let i = 0; i < 12; i++) { const mid = (lo + hi) / 2; if (above(mid)) lo = mid; else hi = mid; }
      const p = at(hi), tt = this.terrain;
      const inside = p[0] >= tt.offsetX && p[1] >= tt.offsetY && p[0] <= tt.offsetX + (tt.width - 1) * 128 && p[1] <= tt.offsetY + (tt.height - 1) * 128;
      return inside ? p : null;
    }
    return null;
  }

  /** Marks spots with rings that follow the ground; null or [] clears them. */
  setSelection(sel: Ring | Ring[] | null) {
    for (const m of this.selection) this.freeVao(m.vao);
    const rings = sel === null ? [] : Array.isArray(sel) ? sel : [sel];
    this.selection = rings.map((r) => this.ring(r, rings.length > 50 ? 16 : 64));
  }

  /** A named set of rings (the light ranges), drawn until replaced; [] removes it. A ring with `z` stays at that
   *  height, the others follow the ground. */
  setRings(name: string, rings: readonly Ring[]) {
    this.ringSets.get(name)?.forEach((m) => this.freeVao(m.vao));
    if (rings.length) this.ringSets.set(name, rings.map((r) => this.ring(r, rings.length > 50 ? 24 : 64)));
    else this.ringSets.delete(name);
  }

  /** Canvas point (CSS pixels) of a world point, or null behind the camera. Inverse of ray(). */
  project(p: Vec3): [number, number] | null {
    const w = Math.max(1, this.canvas.clientWidth), h = Math.max(1, this.canvas.clientHeight);
    const eye = this.eye();
    const f = norm([this.target[0] - eye[0], this.target[1] - eye[1], this.target[2] - eye[2]]);
    const r = norm([f[1], -f[0], 0]);
    const u: Vec3 = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
    const d = [p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]];
    const z = d[0] * f[0] + d[1] * f[1] + d[2] * f[2];
    if (z <= 0) return null;
    const t = Math.tan(this.fov / 2);
    const nx = (d[0] * r[0] + d[1] * r[1] + d[2] * r[2]) / z / (t * (w / h)), ny = (d[0] * u[0] + d[1] * u[1] + d[2] * u[2]) / z / t;
    return [((nx + 1) / 2) * w, ((1 - ny) / 2) * h];
  }

  /** The brush outline (editing tools); null hides it. */
  setBrush(b: Ring | null) {
    if (this.brush) this.freeVao(this.brush.vao);
    this.brush = b ? this.ring(b) : null;
  }

  private ring(r: Ring, segments = 64): Mesh {
    const data: number[] = [];
    const [cr, cg, cb] = [r.rgb[0] / 255, r.rgb[1] / 255, r.rgb[2] / 255];
    if (r.outline) {
      for (const [x, y] of r.outline) data.push(x, y, (r.z ?? this.groundHeight(x, y)) + 4, cr, cg, cb, 1);
      return this.colorMesh(data);
    }
    for (let i = 0; i < segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      let dx = Math.cos(a), dy = Math.sin(a);
      // Square: the same directions pushed out to the square's edge.
      if (r.square) { const m = Math.max(Math.abs(dx), Math.abs(dy)); dx /= m; dy /= m; }
      const x = r.x + dx * r.r, y = r.y + dy * r.r;
      data.push(x, y, (r.z ?? this.groundHeight(x, y)) + 4, r.rgb[0] / 255, r.rgb[1] / 255, r.rgb[2] / 255, 1);
    }
    return this.colorMesh(data);
  }

  /** Placed objects play their Stand animation (see setAnimate). */
  private animate = true;
  private animStart = performance.now();
  /** When the last frame with animated objects was drawn (they redraw about 30 times a second). */
  private lastAnimFrame = 0;

  /** Placed objects play their Stand animation in a loop, or stand still at its start. */
  setAnimate(on: boolean) {
    this.animate = on;
    if (!on) for (const gpu of new Set(this.batches.map((b) => b.gpu))) gpu.pose(standClock(gpu.model, gpu.props));
  }

  /** Poses the placed models at the current moment of their Stand animation (one pose per
   *  model, shared by its instances), and the classic models whose effects stand in. Only models
   *  with an instance in view (`inView`) are posed, and those whose particles follow their pose
   *  (near objects have particles in view) or that a placement preview shows: the others are posed
   *  when they come into view, before they're drawn. */
  private poseAnimated(inView: ReadonlySet<ObjectBatch>) {
    const t = performance.now() - this.animStart;
    const at = (c: Clock): Clock => ({ ...c, frame: c.seqStart + (t % Math.max(1, c.seqEnd - c.seqStart)), time: t });
    const posed = new Set<ModelGpu>();
    const previewed = new Set([this.ghost, ...this.ghosts].map((g) => g?.gpu));
    for (const b of this.batches) {
      if (!this.groupShown(b.group)) continue;
      if (!inView.has(b) && !b.effects && !previewed.has(b.gpu)) continue;
      if (!posed.has(b.gpu) && b.gpu.model.sequences.length) {
        posed.add(b.gpu);
        b.gpu.pose(at(standClock(b.gpu.model, b.gpu.props)));
      }
      const fx = b.effects;
      if (fx?.classic) {
        fx.clock = at(standClock(fx.model, b.gpu.props));
        fx.nodeWorld = poseNodes(fx.model, fx.clock);
      }
    }
  }

  /** Whether the view changes by itself (animation, particles, water): then it's redrawn. */
  get animating(): boolean {
    if (this.showWater && this.water.count && this.waterLook.frames.length > 1 && this.waterFrame() !== this.waterFrameShown) return true;
    if (this.animate && performance.now() - this.lastAnimFrame > 33
      && this.batches.some((b) => b.instances.length && b.gpu.model.sequences.length && this.groupShown(b.group))) return true;
    if (this.showWeather && this.weather.length) return true;
    return this.showEffects && this.batches.some((b) => b.instances.length && b.effects && this.groupShown(b.group));
  }

  /** Weather to draw from now on. */
  setWeather(list: { effect: WeatherEffect; box: WeatherBox | null }[]) {
    this.weather = list.map((w) => ({ ...w, particles: new ParticleInstance(w.effect.model, Math.random, MOST_PARTICLES), texture: null }));
    return this.weather;
  }

  setWeatherTexture(w: TerrainRenderer["weather"][number], img: DecodedImage) {
    w.texture = createTexture(this.gl, img, { repeat: [false, false] });
  }

  /** Steps and draws the particles of placed objects near the view. */
  private drawParticles(viewProj: Mat4, eye: Vec3) {
    const now = performance.now();
    const dt = this.lastParticleTime < 0 ? 0 : Math.min(0.1, (now - this.lastParticleTime) / 1000);
    this.lastParticleTime = now;
    // Far objects aren't simulated (they keep their particles until the view comes back).
    const reach = this.distance * 2.5 + 1024;
    const items: Parameters<ParticleRenderer["draw"]>[2] = [];
    for (const b of this.showEffects ? this.batches : []) {
      const fx = b.effects;
      if (!fx || !this.groupShown(b.group)) continue;
      for (const inst of b.instances) {
        if (Math.hypot(inst.world[12] - this.target[0], inst.world[13] - this.target[1]) > reach) continue;
        let p = this.particleStates.get(inst);
        if (!p) this.particleStates.set(inst, (p = new ParticleInstance(fx.model)));
        // A model's own emitters follow its current pose; a classic stand-in has its own.
        p.step(dt, fx.classic ? fx.clock : b.gpu.poseClock, fx.classic ? fx.nodeWorld : b.gpu.nodeWorld, inst.world);
        items.push({ particles: p, textures: fx.textures, world: inst.world });
      }
    }
    if (this.showWeather) for (const w of this.weather) {
      const box = w.box ?? viewBox(this.target[0], this.target[1], this.distance);
      const world = placeWeather(w.effect, box, w.box ? this.groundHeight((box.left + box.right) / 2, (box.bottom + box.top) / 2) : this.target[2]);
      w.particles.step(dt, WEATHER_CLOCK, WEATHER_NODES, world);
      items.push({ particles: w.particles, textures: [w.texture], world });
    }
    if (!items.length) return;
    this.particleRenderer ??= new ParticleRenderer(this.gl);
    this.particleRenderer.draw(viewProj, eye, items);
  }

  /** CPU time of the frames drawn (ms, by performance.now): all of render, posing the placed models
   *  in it, the particles, and HD water's depth picture of the models in it (drawWaterDepth). For measuring (see
   *  TerrainEditorHandle.frameCost). */
  readonly frameCost = { frames: 0, frameMs: 0, poseMs: 0, particleMs: 0, waterMs: 0 };

  render() {
    const started = performance.now();
    try {
      this.drawFrame();
    } finally {
      this.frameCost.frames++;
      this.frameCost.frameMs += performance.now() - started;
    }
  }

  private drawFrame() {
    const gl = this.gl;
    const w = this.canvas.clientWidth * devicePixelRatio, h = this.canvas.clientHeight * devicePixelRatio;
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    const far = this.distance * 10, near = Math.max(10, this.distance / 50);
    const viewProj = mat4.mul(
      mat4.perspective(this.fov, w / Math.max(1, h), near, far),
      mat4.lookAt(this.eye(), this.target, [0, 0, 1]),
    );
    const terrainLight = this.drawnLight(this.terrainLight), unitLight = this.drawnLight(this.unitLight);

    // Placed objects in view, and (HD's real shadows) those that cast into it, posed before anything is drawn: the
    // sun's shadow map is drawn first. Cliffs aren't culled: the ground they follow moves them up in the shader.
    const planes = frustumPlanes(viewProj);
    const gathered: [ObjectBatch, InstanceRuns][] = [];
    // HD water reads a depth picture of the models in view that stand in it (drawWaterDepth), found on the way.
    const wetWanted = this.tone === 2 && this.showWater && this.water.count > 0;
    const wet = new Map<ObjectBatch, ObjectInstance[]>();
    for (const b of this.batches) {
      if (!this.batchShown(b) || !b.instances.length) continue;
      // See-through previews and the editor's helpers don't hide the water behind them; cliffs and waves aren't models.
      const found: ObjectInstance[] | undefined = wetWanted && !b.tint && !b.followGround && b.group !== "shoreline" ? [] : undefined;
      const list = this.gatherInstances(b, b.followGround ? null : planes, this.instanceBuffers, { wet: found });
      if (list.runs.length) gathered.push([b, list]);
      if (found?.length) wet.set(b, found);
    }
    // Shadows fall from the units' sun (map 03's footmen's to the north-east, as its unit light, not to the east as its
    // terrain light: we-drive), the ground's where the map has no unit light.
    const sunFit = this.sunFit(w, h, unitLight ?? terrainLight);
    const casting: [ObjectBatch, InstanceRuns][] = [];
    if (sunFit) {
      const sunPlanes = frustumPlanes(sunFit.viewProj);
      for (const b of this.batches) {
        if (!this.casts(b)) continue;
        const list = this.gatherInstances(b, b.followGround ? null : sunPlanes, this.sunInstanceBuffers);
        if (list.runs.length) casting.push([b, list]);
      }
    }
    if (this.animate) {
      const started = performance.now();
      // Only what's in view moves: a model that only casts into it keeps the pose it was last seen in (a model never
      // posed yet is, so its shadow isn't missing), which saves half a millisecond on GoldRush's trees.
      this.poseAnimated(new Set([...gathered.map(([b]) => b), ...casting.filter(([b]) => b.gpu.fullPoses === 0).map(([b]) => b)]));
      this.lastAnimFrame = performance.now();
      this.frameCost.poseMs += this.lastAnimFrame - started;
    }
    const sun = sunFit ? this.drawSunMap(sunFit, casting) : null;
    this.sunShadowState.drawn = !!sun;
    this.sunShadowState.texel = sun ? sun.texel : 0;
    this.sunShadowState.casters = sun ? casting.reduce((n, [, l]) => n + l.runs.reduce((k, r) => k + r.count, 0), 0) : 0;
    const noSun = noSunTexture(gl);
    const waterStarted = performance.now();
    const seen = this.drawWaterDepth(viewProj, wet, w, h);
    this.frameCost.waterMs += performance.now() - waterStarted;
    // The classic view's objects' shadows (images and textures): in SD, and in HD only in place of real shadows that
    // couldn't be drawn (a GPU without the shadow map). HD without the map's lighting has none at all, as the editor.
    const standIns = this.tone !== 2 || (!sun && !!terrainLight);

    gl.viewport(0, 0, w, h);
    // Past the end of the fog there's nothing to see, so the background is the fog too. The fog counts from
    // the eye as in the game, also from further out than the game's camera: zoomed out, a near fog covers
    // everything, as it does there (the view's Fog box turns it off).
    const fog = this.showFog && this.fog ? this.fog : null;
    // With the terrain as a wireframe or hidden, the World Editor shows black behind it, and past the map's edge too
    // (we-drive, map 03 and HillsbradCreek, 2026-11-12: 0, 0, 0 there; Studio's was 28, 31, 36).
    const textured = this.groundLook === "textured";
    const back = textured && fog ? fog.color : [0, 0, 0];
    gl.clearColor(back[0], back[1], back[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.enable(gl.CULL_FACE);

    // The sky: behind everything, around the camera, as far as the view reaches.
    if (this.sky && this.showSky) {
      const s = (far * 0.7) / Math.max(1, this.sky.radius), [x, y, z] = this.eye();
      gl.disable(gl.CULL_FACE);
      gl.depthMask(false);
      this.sky.gpu.draw(viewProj, new Float32Array([s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, x, y, z, 1]), { onTop: true, pass: "all" });
      gl.depthMask(true);
      gl.enable(gl.DEPTH_TEST);
      gl.enable(gl.CULL_FACE);
      gl.disable(gl.BLEND);
    }

    // Ground: lowest texture first, the others blend over it.
    gl.useProgram(this.groundProg);
    setFog(gl, (name) => gl.getUniformLocation(this.groundProg, name), fog);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.groundProg, "uViewProj"), false, viewProj);
    const groundLight = terrainLight ?? GROUND_DEFAULT;
    setSunShadow(gl, (name) => gl.getUniformLocation(this.groundProg, name), sun, noSun);
    setTone(gl, (name) => gl.getUniformLocation(this.groundProg, name), this.tone, groundLight);
    gl.uniform3fv(gl.getUniformLocation(this.groundProg, "uLightDir"), groundLight.dir);
    gl.uniform3fv(gl.getUniformLocation(this.groundProg, "uDiffuse"), groundLight.diffuse);
    gl.uniform3fv(gl.getUniformLocation(this.groundProg, "uAmbient"), groundLight.ambient);
    gl.uniform1i(gl.getUniformLocation(this.groundProg, "uTex"), 0);
    const shadowMap = this.showShadows ? this.shadowMap : null;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, shadowMap ?? this.noShadow);
    gl.uniform1i(gl.getUniformLocation(this.groundProg, "uShadow"), 1);
    const tr = this.terrain;
    gl.uniform4f(gl.getUniformLocation(this.groundProg, "uShadowRect"), tr.offsetX, tr.offsetY, (tr.width - 1) * 128, (tr.height - 1) * 128);
    const look = this.shadowLook;
    gl.uniform2f(gl.getUniformLocation(this.groundProg, "uStampShift"), look.stampShift[0] / ((tr.width - 1) * 128), look.stampShift[1] / ((tr.height - 1) * 128));
    // The real shadows take the objects' shadow images' place (they stand in for them without a shadow map).
    gl.uniform2f(gl.getUniformLocation(this.groundProg, "uShadowDark"), shadowMap ? look.baked : 0, shadowMap && standIns ? look.stamp : 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindVertexArray(this.ground);
    for (const r of textured ? this.ranges : []) {
      const t = this.textures[r.texture];
      gl.bindTexture(gl.TEXTURE_2D, t?.tex ?? this.placeholder);
      gl.uniform1f(gl.getUniformLocation(this.groundProg, "uExtended"), t?.extended ? 1 : 0);
      gl.drawElements(gl.TRIANGLES, r.count, gl.UNSIGNED_INT, r.offset * 4);
    }

    // What lies on the ground goes with it when the terrain is hidden.
    const onGround = this.groundLook !== "hidden";
    // The border's dark first: the View layers and the tools' marks go over it, as the World Editor's naval view
    // lies over the map's edge. They lie under the water, which is drawn later: the World Editor's Pathing - Ground
    // vanishes under deep water too (viewcmds.ts groundPathingColors).
    for (const layer of onGround ? [textured && this.showBorder ? this.border : null, this.viewLayer, this.overlay] : []) {
      if (!layer || !this.overlayProg) continue;
      const t = this.terrain;
      gl.useProgram(this.overlayProg);
      // The border is part of the map, and fades with it. What a tool shows has to stay readable.
      setFog(gl, (name) => gl.getUniformLocation(this.overlayProg as WebGLProgram, name), layer === this.border ? fog : null);
      gl.uniformMatrix4fv(gl.getUniformLocation(this.overlayProg, "uViewProj"), false, viewProj);
      // The border's texels sit on the pathing cells' corners (borderRect), the layers' on the cells.
      const rect = layer === this.border ? this.borderRect() : [t.offsetX, t.offsetY, (t.width - 1) * 128, (t.height - 1) * 128];
      gl.uniform4f(gl.getUniformLocation(this.overlayProg, "uRect"), rect[0], rect[1], rect[2], rect[3]);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, layer.tex);
      gl.uniform1i(gl.getUniformLocation(this.overlayProg, "uTex"), 0);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      gl.bindVertexArray(layer.vao);
      gl.drawElements(gl.TRIANGLES, layer.count, gl.UNSIGNED_INT, 0);
      gl.depthMask(true);
    }

    if (this.gridStep > 0 && onGround) this.drawGrid(viewProj);

    // Building ground marks, on the ground under the objects.
    if (this.splats.length && !this.hiddenGroups.has("units") && textured) {
      gl.useProgram(this.splatProg);
      setFog(gl, (name) => gl.getUniformLocation(this.splatProg, name), fog);
      gl.uniformMatrix4fv(gl.getUniformLocation(this.splatProg, "uViewProj"), false, viewProj);
      gl.uniform1i(gl.getUniformLocation(this.splatProg, "uTex"), 0);
      setTone(gl, (name) => gl.getUniformLocation(this.splatProg, name), this.tone);
      setSunShadow(gl, (name) => gl.getUniformLocation(this.splatProg, name), sun, noSun);
      const lit = this.flatLight(terrainLight), shade = this.flatLight(terrainLight, 0);
      gl.uniform3f(gl.getUniformLocation(this.splatProg, "uLight"), lit[0], lit[1], lit[2]);
      gl.uniform3f(gl.getUniformLocation(this.splatProg, "uShadeLight"), shade[0], shade[1], shade[2]);
      gl.activeTexture(gl.TEXTURE0);
      gl.enable(gl.BLEND);
      gl.depthMask(false);
      gl.disable(gl.CULL_FACE);
      for (const s of this.splats) {
        const tex = this.splatTextures.get(s.texture.toLowerCase());
        if (!tex) continue;
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.uniform4fv(gl.getUniformLocation(this.splatProg, "uColor"), s.color);
        gl.blendFunc(gl.SRC_ALPHA, s.blend === 1 ? gl.ONE : gl.ONE_MINUS_SRC_ALPHA);
        gl.bindVertexArray(s.vao);
        gl.drawArrays(gl.TRIANGLES, 0, s.count);
      }
      gl.depthMask(true);
      gl.enable(gl.CULL_FACE);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    }

    // The units' shadows: the ground under them darkened by the texture's alpha. Not with the real shadows (HD), whose
    // stand-ins they are.
    if (this.showShadows && standIns && this.unitShadows.length && !this.hiddenGroups.has("units")) {
      gl.useProgram(this.splatProg);
      setSunShadow(gl, (name) => gl.getUniformLocation(this.splatProg, name), null, noSun);
      setFog(gl, (name) => gl.getUniformLocation(this.splatProg, name), fog);
      gl.uniformMatrix4fv(gl.getUniformLocation(this.splatProg, "uViewProj"), false, viewProj);
      gl.uniform1i(gl.getUniformLocation(this.splatProg, "uTex"), 0);
      setTone(gl, (name) => gl.getUniformLocation(this.splatProg, name), this.tone);
      gl.uniform4f(gl.getUniformLocation(this.splatProg, "uColor"), 0, 0, 0, this.shadowLook.unit);
      gl.activeTexture(gl.TEXTURE0);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ZERO, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      gl.disable(gl.CULL_FACE);
      for (const s of this.unitShadows) {
        const tex = this.splatTextures.get(s.texture.toLowerCase());
        if (!tex) continue;
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.bindVertexArray(s.vao);
        gl.drawArrays(gl.TRIANGLES, 0, s.count);
      }
      gl.depthMask(true);
      gl.enable(gl.CULL_FACE);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    }

    // Placed objects (gathered and posed above): every opaque layer, then every blended one; each model once per layer
    // for all its instances in view. Past the playable map they're shaded as the ground there, by the same texture.
    const edge = this.edgeShade(textured);
    const edges = new Map<EdgeShade["mode"], EdgeShade>();
    for (const pass of ["opaque", "blended"] as const) {
      for (const [b, list] of gathered) {
        const light = (b.group === "units" ? unitLight : terrainLight) ?? undefined;
        // A see-through batch is blended whole, after everything opaque (which then shows through it).
        if (b.tint && pass === "opaque") continue;
        const mode = edgeMode(b, this.tone);
        const shade = edge && (edges.get(mode) ?? edges.set(mode, { ...edge, mode }).get(mode));
        b.gpu.drawInstances(viewProj, list, { pass: b.tint ? "all" : pass, heightMap: b.followGround ? this.heightMap : undefined, light, fog, tint: b.tint, tone: this.tone, sun, edge: shade });
      }
    }
    if (this.showEffects || this.showWeather) {
      const started = performance.now();
      this.drawParticles(viewProj, this.eye());
      this.frameCost.particleMs += performance.now() - started;
    }
    else this.lastParticleTime = -1;
    // Placement preview: see-through, red where the object doesn't fit.
    for (const g of this.ghost ? [this.ghost, ...this.ghosts] : this.ghosts) {
      g.gpu.draw(viewProj, g.world, { team: g.team, pass: "all", tint: [1, 1, 1, 0.75], mix: g.ok ? undefined : [1, 0.1, 0.1, 0.65], onTop: true });
    }
    gl.enable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    gl.useProgram(this.colorProg);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.colorProg, "uViewProj"), false, viewProj);
    gl.uniform1f(gl.getUniformLocation(this.colorProg, "uPointSize"), 5000);
    if (this.groundLook === "wireframe") {
      this.terrainWire ??= this.buildTerrainWire();
      gl.bindVertexArray(this.terrainWire.vao);
      gl.drawArrays(gl.LINES, 0, this.terrainWire.count);
    }
    gl.disable(gl.BLEND);
    for (const [name, m] of this.markers) {
      // "starts": start locations without their model, shown and hidden with the units, and left out in game view.
      if (this.hiddenGroups.has(name) || (name === "starts" && (this.hiddenGroups.has("units") || !this.showEditorOnly))) continue;
      gl.bindVertexArray(m.vao);
      gl.drawArrays(gl.POINTS, 0, m.count);
    }
    // Solid marks (camera objects): both sides of each face; not in a picture taken by showEverything.
    if (this.shapes.size && !this.held) {
      // The units' light as the lighting model gives it, without the HD picture's response to it (hdLight), which
      // placed models get: so the World Editor's camera models come out (we-drive, 2026-11-13, HD), blue under
      // 12b_RoC_Orc04Interlude's night and light cyan under cliff.w3m's strong sun; with the response one colour
      // couldn't match both (25 levels off at best, against 12 without).
      const light = this.unitLight ?? DEFAULT_LIGHT;
      gl.useProgram(this.shapeProg);
      const where = (name: string) => gl.getUniformLocation(this.shapeProg, name);
      gl.uniformMatrix4fv(where("uViewProj"), false, viewProj);
      setTone(gl, where, this.tone, light);
      setFog(gl, where, fog);
      gl.uniform3fv(where("uLightDir"), light.dir);
      gl.uniform3fv(where("uDiffuse"), light.diffuse);
      gl.uniform3fv(where("uAmbient"), light.ambient);
      gl.disable(gl.CULL_FACE);
      for (const m of this.shapes.values()) {
        gl.bindVertexArray(m.vao);
        gl.drawArrays(gl.TRIANGLES, 0, m.count);
      }
      gl.enable(gl.CULL_FACE);
      gl.useProgram(this.colorProg);
    }
    if (this.showWater && this.water.count) {
      const look = this.waterLook, frame = this.waterFrame();
      this.waterFrameShown = frame;
      gl.useProgram(this.waterProg);
      setSunShadow(gl, (name) => gl.getUniformLocation(this.waterProg, name), sun, noSun);
      setFog(gl, (name) => gl.getUniformLocation(this.waterProg, name), fog);
      gl.uniformMatrix4fv(gl.getUniformLocation(this.waterProg, "uViewProj"), false, viewProj);
      gl.uniform1i(gl.getUniformLocation(this.waterProg, "uTex"), 0);
      const ramp = waterRamp(look, this.waterTint);
      for (const [name, v] of [["uShallowMin", ramp.shallowMin], ["uShallowMax", ramp.shallowMax], ["uDeepMin", ramp.deepMin], ["uDeepMax", ramp.deepMax]] as const) {
        gl.uniform4fv(gl.getUniformLocation(this.waterProg, name), v);
      }
      setTone(gl, (name) => gl.getUniformLocation(this.waterProg, name), this.tone);
      gl.uniform3fv(gl.getUniformLocation(this.waterProg, "uHdWater"), hdWaterColor(this.terrain.tileset, !!this.waterTint));
      gl.uniform1f(gl.getUniformLocation(this.waterProg, "uWaterBrightness"), look.frames.some((f) => f) ? this.waterBrightness : 1);
      // The border's black water goes with the border's shade (the Boundary switch, and the textured ground it lies on).
      gl.uniform1f(gl.getUniformLocation(this.waterProg, "uEdgeDark"), this.showBorder && textured ? 1 : 0);
      gl.uniform4fv(gl.getUniformLocation(this.waterProg, "uPlayRect"), this.playRect);
      const lit = this.flatLight(terrainLight);
      gl.uniform3f(gl.getUniformLocation(this.waterProg, "uLight"), lit[0], lit[1], lit[2]);
      // The models' depth picture (a texture of its own is always bound to the sampler, as for the shadow map).
      const eye = this.eye(), forward = norm([this.target[0] - eye[0], this.target[1] - eye[1], this.target[2] - eye[2]]);
      gl.activeTexture(gl.TEXTURE0 + WATER_DEPTH_UNIT);
      gl.bindTexture(gl.TEXTURE_2D, seen ?? this.waterWhite);
      gl.uniform1i(gl.getUniformLocation(this.waterProg, "uScene"), WATER_DEPTH_UNIT);
      gl.uniform1f(gl.getUniformLocation(this.waterProg, "uSceneOn"), seen ? 1 : 0);
      gl.uniform2f(gl.getUniformLocation(this.waterProg, "uViewSize"), w, h);
      gl.uniform3f(gl.getUniformLocation(this.waterProg, "uEye"), eye[0], eye[1], eye[2]);
      gl.uniform3f(gl.getUniformLocation(this.waterProg, "uForward"), forward[0], forward[1], forward[2]);
      gl.uniform2f(gl.getUniformLocation(this.waterProg, "uNearFar"), near, far);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, look.frames[frame] ?? look.frames.find((f) => f) ?? this.waterWhite);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      gl.disable(gl.CULL_FACE);
      gl.bindVertexArray(this.water.vao);
      gl.drawArrays(gl.TRIANGLES, 0, this.water.count);
      gl.depthMask(true);
      // The rings below use the colour program (its view matrix is still set).
      gl.useProgram(this.colorProg);
    }
    // The View layers' part over the border, over the water too (setViewLayer's `top`).
    if (onGround && this.viewLayer?.top && this.overlayProg) {
      const layer = this.viewLayer, t = this.terrain, prog = this.overlayProg;
      gl.useProgram(prog);
      setFog(gl, (name) => gl.getUniformLocation(prog, name), null);
      gl.uniformMatrix4fv(gl.getUniformLocation(prog, "uViewProj"), false, viewProj);
      gl.uniform4f(gl.getUniformLocation(prog, "uRect"), t.offsetX, t.offsetY, (t.width - 1) * 128, (t.height - 1) * 128);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, layer.top!);
      gl.uniform1i(gl.getUniformLocation(prog, "uTex"), 0);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      gl.bindVertexArray(layer.vao);
      gl.drawElements(gl.TRIANGLES, layer.count, gl.UNSIGNED_INT, 0);
      gl.depthMask(true);
      gl.useProgram(this.colorProg);
    }
    // Rings stay visible through trees and water.
    gl.disable(gl.DEPTH_TEST);
    for (const ring of [...[...this.ringSets.values()].flat(), ...this.selection, this.brush]) {
      if (!ring) continue;
      gl.bindVertexArray(ring.vao);
      gl.drawArrays(gl.LINE_LOOP, 0, ring.count);
    }
    gl.enable(gl.DEPTH_TEST);
    gl.bindVertexArray(null);
  }

  /** Whether a batch casts into the sun's shadow map: one that's drawn and castsSunShadow. */
  private casts(b: ObjectBatch): boolean {
    return castsSunShadow(b) && this.batchShown(b);
  }

  /** The ground's lowest and highest point, water included. */
  private groundRange(): [number, number] {
    let lo = Infinity, hi = -Infinity;
    const t = this.terrain;
    for (let y = 0; y < t.height; y++) for (let x = 0; x < t.width; x++) {
      const c = this.corner(x, y), z = c.height + rampLift(t, x, y);
      lo = Math.min(lo, z); hi = Math.max(hi, z, c.hasWater ? c.water : -Infinity);
    }
    return lo <= hi ? [lo, hi] : [0, 0];
  }

  /**
   * The sun's shadow map for this frame, fitted to the view (sunshadow.ts), or null where the World Editor casts no
   * real shadows: they're HD's (its classic view has war3map.shd and the stand-in images instead), need the map's
   * lighting (with View > Lighting off the editor's HD view has none, we-drive 2026-11-09), View > Shadows, the
   * textured ground, and something to cast.
   */
  private sunFit(w: number, h: number, light: SceneLight | null) {
    if (this.tone !== 2 || !this.showShadows || !light || this.groundLook !== "textured" || this.gl.isContextLost()) return null;
    if (!this.batches.some((b) => this.casts(b))) return null;
    const eye = this.eye(), t = this.terrain;
    const [zMin, zMax] = (this.heightRange ??= this.groundRange());
    return sunShadowFrame(light.dir, {
      eye, rays: viewRays(eye, this.target, this.fov, w / Math.max(1, h)), zMin, zMax, reach: this.distance * SUN_REACH,
      rect: [t.offsetX, t.offsetY, t.offsetX + (t.width - 1) * 128, t.offsetY + (t.height - 1) * 128],
    }, SUN_CASTER_HEIGHT, SUN_MAP_SIZE);
  }

  /** Draws what casts into the sun's shadow map: depth only, pushed back a little against a surface shadowing itself. */
  private drawSunMap(fit: NonNullable<ReturnType<TerrainRenderer["sunFit"]>>, casting: [ObjectBatch, InstanceRuns][]): SunShadow | null {
    const gl = this.gl;
    this.sunMap ??= new SunShadowMap(gl, SUN_MAP_SIZE);
    if (!this.sunMap.begin()) return null;
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(1.5, 3);
    for (const [b, list] of casting) b.gpu.drawInstances(fit.viewProj, list, { shadowPass: true, heightMap: b.followGround ? this.heightMap : undefined });
    gl.disable(gl.POLYGON_OFFSET_FILL);
    return this.sunMap.end(fit.lookup, fit.texel);
  }

  /**
   * HD water's depth picture: the models in view that stand in the water (underWater), drawn from
   * the camera into a depth texture of the view's size, opaque layers only (as into the sun's map). The water shader
   * reads it to see how much water lies in front of a model under the surface (the World Editor shows a swimming naga's
   * body through the water: we-drive, branch render-fixes-6). Null when there's nothing to draw or no texture.
   */
  private drawWaterDepth(viewProj: Mat4, found: ReadonlyMap<ObjectBatch, readonly ObjectInstance[]>, w: number, h: number): WebGLTexture | null {
    this.waterDepthState.drawn = false;
    this.waterDepthState.models = 0;
    if (!found.size) return null;
    const wet: [ObjectBatch, InstanceRuns][] = [];
    let models = 0;
    for (const [b, from] of found) {
      wet.push([b, this.gatherInstances(b, null, this.wetInstanceBuffers, { from })]);
      models += from.length;
    }
    const gl = this.gl;
    this.waterDepth ??= new ViewDepth(gl);
    if (!this.waterDepth.begin(w, h)) return null;
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.enable(gl.CULL_FACE);
    for (const [b, list] of wet) b.gpu.drawInstances(viewProj, list, { shadowPass: true });
    const tex = this.waterDepth.end();
    this.waterDepthState.drawn = !!tex;
    this.waterDepthState.models = tex ? models : 0;
    return tex;
  }

  /** Grid lines over the ground; the larger the cell, the stronger the line. */
  private drawGrid(viewProj: Mat4) {
    const gl = this.gl, t = this.terrain;
    this.gridProg ??= compile(gl, GRID_VS, GRID_FS);
    this.gridMesh ??= this.overlayMesh(this.gridProg);
    gl.useProgram(this.gridProg);
    setFog(gl, (name) => gl.getUniformLocation(this.gridProg as WebGLProgram, name), null);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.gridProg, "uViewProj"), false, viewProj);
    gl.uniform2f(gl.getUniformLocation(this.gridProg, "uOrigin"), t.offsetX, t.offsetY);
    // As the World Editor's: the medium grid keeps the large one's yellow lines, the small one both (gridLines).
    const lines = gridLines(this.gridStep);
    gl.uniform1i(gl.getUniformLocation(this.gridProg, "uLevels"), lines.length);
    gl.uniform1fv(gl.getUniformLocation(this.gridProg, "uSteps"), new Float32Array([0, 1, 2].map((i) => lines[i]?.step ?? 1)));
    gl.uniform4fv(gl.getUniformLocation(this.gridProg, "uColors"), new Float32Array([0, 1, 2].flatMap((i) => lines[i]?.rgba ?? [0, 0, 0, 0])));
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    gl.bindVertexArray(this.gridMesh.vao);
    gl.drawElements(gl.TRIANGLES, this.gridMesh.count, gl.UNSIGNED_INT, 0);
    gl.depthMask(true);
  }

  dispose() {
    this.sunMap?.dispose();
    this.sunMap = null;
    this.waterDepth?.dispose();
    this.waterDepth = null;
    this.gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}
