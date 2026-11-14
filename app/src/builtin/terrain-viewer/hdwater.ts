// HD water as the World Editor draws it (we-drive, HD, branch water-render-we, 2026-11-14; TESTING.md "HD water"):
// in linear light, the bed seen through the water, the water's own colour by its depth, and a reflection of the sky
// that depends on where the view looks (the editor's water is lighter towards the west and the south: its environment
// map is bright there), scaled by the map's water settings (war3map.w3i: reflectivity, environment map reflectivity).
//
//   out = enc(through(d) · dec(bed) + own(d) · dec(deep) + reflect(d) · (k · sky(R) − dim · (through · bed + own · deep)))
//
// d the depth (world units, ground to surface), deep the tileset's deep colour (hdWaterColor), R the view reflected on
// a flat surface, k = reflectivity / 10 · environment map reflectivity / 100, dim = HD_REFLECT_DIM · reflectivity / 10.
// The water shader (renderer.ts WATER_FS) does the same through HD_WATER_GLSL; hdWaterPixel is the same in TypeScript.

/** Depths (world units) of the tables below: the eight bands of the measuring maps, 0 and the depth where all is water. */
export const HD_WATER_DEPTHS = [0, 4, 12, 24, 38.4, 64, 96, 200] as const;
/**
 * How much of the bed shows through (linear light) and how much of the tileset's deep colour is added, by depth: fitted
 * (0.3 levels mean, 2 at most) over flat maps of eight depths on Lordaeron Summer, Ashenvale (its water 12.8 higher:
 * Water.slk's height), Barrens and Northrend with the reflection off (w3i reflectivity 0), each band's colour against
 * the same map with Water off. 200 and 800
 * deep look alike: all water from 200 on (between 96 and 200 unmeasured, taken linear).
 */
export const HD_WATER_THROUGH = [1, 0.925, 0.809, 0.66, 0.489, 0.251, 0.049, 0] as const;
export const HD_WATER_OWN = [0, 0.026, 0.079, 0.152, 0.258, 0.415, 0.721, 1] as const;
/**
 * How much of the reflection water of a depth shows (the same maps, reflectivity 10, over Water off, through
 * hdWaterPixel; 1.4 levels mean, 6 at most over all bands, five columns and the four tilesets). Water 30 to 60 deep
 * shows a little more of it than deep water.
 */
export const HD_REFLECT_DEPTH = [0, 0.09, 0.365, 0.925, 1.155, 1.025, 1.005, 1] as const;
/**
 * How much darker the reflection-less colour gets per 10 of the w3i's reflectivity (environment map reflectivity 0
 * against reflectivity 0: deep Lordaeron water 0, 45, 65 against 0, 48, 69, 0.887 of it in linear light).
 */
export const HD_REFLECT_DIM = 0.113;
/**
 * The sky the water reflects (linear light, at the w3i's default reflectivity 10 and environment map reflectivity 100),
 * by the reflected view R (unit, z up): a second-order spherical-harmonic fit per channel (constant, x, y, z, xy, yz,
 * xz, x² − y², 3z² − 1) over 37,000 blocks of 16 × 16 pixels of deep water seen through ten cameras (eight turns of the
 * editor's opening camera at 3000, two at 1500) and View Entire Map: 3.1 levels mean per block, under 2 per picture
 * (the ripples are most of the rest). Brightest where R points west, south and up; reflectivity 20 and 40 gave twice
 * and four times it, environment map reflectivity 50 half (the same pictures). R is taken no flatter than
 * HD_SKY_LOWEST above the horizon, the flattest the cameras saw.
 */
export const HD_SKY: readonly (readonly number[])[] = [
  [-0.03199, 0.0499, 0.00366, 0.1136, 0.03531, -0.05683, -0.12811, 0.00374, -0.01953],
  [-0.01279, 0.04512, -0.00611, 0.08642, 0.0296, -0.04034, -0.12253, 0.00487, -0.01268],
  [-0.01282, 0.03061, -0.02115, 0.0862, 0.02473, -0.01201, -0.09247, 0.0027, -0.01523],
];
export const HD_SKY_LOWEST = 0.54;

/** The map's HD water settings that the picture depends on (war3map.w3i's `water`: 0–100 each); the defaults a new
 *  map has (10, 100) when the file has none. */
export interface HdWaterSettings { reflectivity: number; environment: number }
export const HD_WATER_DEFAULTS: HdWaterSettings = { reflectivity: 10, environment: 100 };

/** The w3i's `water` block as HdWaterSettings: the defaults for what's missing or not a number. */
export function hdWaterSettings(water: unknown): HdWaterSettings {
  const w = (water && typeof water === "object" ? water : {}) as Record<string, unknown>;
  const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, v) : d);
  return { reflectivity: num(w.reflectivity, HD_WATER_DEFAULTS.reflectivity), environment: num(w.environmentMapReflectivity, HD_WATER_DEFAULTS.environment) };
}

/** The reflection's scale (k) and the dimming of the rest (dim) for these settings: the shader's uReflect. */
export function hdReflectScale(s: HdWaterSettings): [number, number] {
  return [(s.reflectivity / 10) * (s.environment / 100), HD_REFLECT_DIM * (s.reflectivity / 10)];
}

const table = (t: readonly number[], d: number): number => {
  const D = HD_WATER_DEPTHS;
  if (!(d > 0)) return t[0];
  for (let i = 1; i < D.length; i++) if (d <= D[i]) return t[i - 1] + ((t[i] - t[i - 1]) * (d - D[i - 1])) / (D[i] - D[i - 1]);
  return t[D.length - 1];
};

/** HD water at a depth (world units): the bed's share, the deep colour's, the reflection's. */
export function hdWaterAt(depth: number): { through: number; own: number; reflect: number } {
  return { through: table(HD_WATER_THROUGH, depth), own: table(HD_WATER_OWN, depth), reflect: table(HD_REFLECT_DEPTH, depth) };
}

/** The reflected view as the sky is looked up with: unit, at least HD_SKY_LOWEST up. */
function skyDir(r: readonly number[]): [number, number, number] {
  const len = Math.hypot(r[0], r[1], r[2]) || 1;
  let [x, y, z] = [r[0] / len, r[1] / len, r[2] / len];
  if (z < HD_SKY_LOWEST) {
    const flat = Math.hypot(x, y) || 1, side = Math.sqrt(1 - HD_SKY_LOWEST ** 2);
    [x, y, z] = [(x / flat) * side, (y / flat) * side, HD_SKY_LOWEST];
  }
  return [x, y, z];
}

/** The sky the water reflects along R (linear light, at the default settings; never below 0). */
export function hdSky(r: readonly number[]): [number, number, number] {
  const [x, y, z] = skyDir(r);
  const f = [1, x, y, z, x * y, y * z, x * z, x * x - y * y, 3 * z * z - 1];
  return HD_SKY.map((c) => Math.max(0, c.reduce((a, v, i) => a + v * f[i], 0))) as [number, number, number];
}

export const decode = (v: number): number => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
export const encode = (l: number): number => { const c = Math.min(1, Math.max(0, l)); return 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055); };

/**
 * One pixel of HD water (sRGB 0–255): over a bed of colour `bed` (sRGB 0–255), `depth` deep, the tileset's deep colour
 * `deep` (sRGB 0–1, hdWaterColor), seen along the view `view` (from the eye to the point; any length), with the map's
 * water settings. What the water shader draws, without its ripples, shadows, edge and fog.
 */
export function hdWaterPixel(bed: readonly number[], depth: number, deep: readonly number[], view: readonly number[], settings: HdWaterSettings = HD_WATER_DEFAULTS): [number, number, number] {
  const { through, own, reflect } = hdWaterAt(depth);
  const [k, dim] = hdReflectScale(settings);
  const sky = hdSky([view[0], view[1], -view[2]]);
  return [0, 1, 2].map((i) => {
    const under = through * decode(bed[i]) + own * decode(deep[i] * 255);
    return encode(under + reflect * (k * sky[i] - dim * under));
  }) as [number, number, number];
}

const f = (v: number) => (Number.isInteger(v) ? v.toFixed(1) : String(v));
const arr = (t: readonly number[]) => `float[${t.length}](${t.map(f).join(", ")})`;
const sky = (k: number) => `vec3(${HD_SKY.map((c) => f(c[k])).join(", ")})`;

/** GLSL of the above: hdWaterAt (as vec3 through, own, reflect), hdSky, srgbDec, srgbEnc. */
export const HD_WATER_GLSL = `
const float HD_DEPTHS[8] = ${arr(HD_WATER_DEPTHS)};
float hdTable(float t[8], float d) {
  if (d <= 0.0) return t[0];
  for (int i = 1; i < 8; i++) if (d <= HD_DEPTHS[i]) return mix(t[i - 1], t[i], (d - HD_DEPTHS[i - 1]) / (HD_DEPTHS[i] - HD_DEPTHS[i - 1]));
  return t[7];
}
vec3 hdWaterAt(float d) {
  return vec3(hdTable(${arr(HD_WATER_THROUGH)}, d), hdTable(${arr(HD_WATER_OWN)}, d), hdTable(${arr(HD_REFLECT_DEPTH)}, d));
}
// r: unit (normalised in high precision by the caller).
vec3 hdSky(vec3 r) {
  if (r.z < ${f(HD_SKY_LOWEST)}) r = vec3(normalize(r.xy + vec2(1e-6, 0.0)) * ${f(Math.sqrt(1 - HD_SKY_LOWEST ** 2))}, ${f(HD_SKY_LOWEST)});
  vec3 c = ${sky(0)} + ${sky(1)} * r.x + ${sky(2)} * r.y + ${sky(3)} * r.z + ${sky(4)} * (r.x * r.y) + ${sky(5)} * (r.y * r.z)
    + ${sky(6)} * (r.x * r.z) + ${sky(7)} * (r.x * r.x - r.y * r.y) + ${sky(8)} * (3.0 * r.z * r.z - 1.0);
  return max(c, vec3(0.0));
}
vec3 srgbDec(vec3 s) { return mix(pow((s + 0.055) / 1.055, vec3(2.4)), s / 12.92, vec3(lessThanEqual(s, vec3(0.04045)))); }
vec3 srgbEnc(vec3 l) { l = clamp(l, 0.0, 1.0); return mix(1.055 * pow(l, vec3(1.0 / 2.4)) - 0.055, l * 12.92, vec3(lessThanEqual(l, vec3(0.0031308)))); }
`;
