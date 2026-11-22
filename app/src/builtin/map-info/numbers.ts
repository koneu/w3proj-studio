// The number fields Map Properties types into war3map.w3i, with the type each has there (crates/w3proj/formats/w3i.json).
// A typed value that type can't hold is refused and the map info stays as it was (user decision 2026-11-15).

import { typedNumber, type StoredNumber } from "../../lib/formats/numbers";

/** A number field of the map info: its label, its stored type, and where it is ("*" stands for the player's place in
 *  `players`). */
export interface InfoNumber {
  readonly label: string;
  readonly kind: StoredNumber;
  readonly path: readonly (string | number)[];
}

const water = (key: string, label: string): InfoNumber => ({ label: `Water ${label}`, kind: "i32", path: ["water", key] });

export const INFO_NUMBERS = {
  loadingScreen: { label: "Loading screen", kind: "i32", path: ["loadingScreen", "number"] },
  crestRace: { label: "Crest race", kind: "u32", path: ["loadingScreen", "crestRace"] },
  gameDataSet: { label: "Game data set", kind: "u32", path: ["gameDataSet"] },
  gameDataVersion: { label: "Game data version", kind: "u32", path: ["gameDataVersion"] },
  zoomDefault: { label: "Camera zoom default", kind: "i32", path: ["cameraZoom", "default"] },
  zoomMax: { label: "Camera zoom maximum", kind: "i32", path: ["cameraZoom", "max"] },
  zoomMin: { label: "Camera zoom minimum", kind: "i32", path: ["cameraZoom", "min"] },
  fogStart: { label: "Fog start Z", kind: "f32", path: ["fog", "start"] },
  fogEnd: { label: "Fog end Z", kind: "f32", path: ["fog", "end"] },
  fogDensity: { label: "Fog density", kind: "f32", path: ["fog", "density"] },
  fogAlpha: { label: "Fog colour alpha", kind: "u8", path: ["fog", "color", 3] },
  waterTintAlpha: { label: "Water tint alpha", kind: "u8", path: ["waterTint", 3] },
  terrainFogStyle: { label: "Terrain fog style", kind: "i32", path: ["terrainFog", "style"] },
  terrainFogOverSky: { label: "Terrain fog draw over sky", kind: "i32", path: ["terrainFog", "overSky"] },
  terrainFogLinearStart: { label: "Terrain fog linear start", kind: "f32", path: ["terrainFog", "linearStart"] },
  terrainFogLinearEnd: { label: "Terrain fog linear end", kind: "f32", path: ["terrainFog", "linearEnd"] },
  terrainFogMaxOpacity: { label: "Terrain fog max opacity", kind: "f32", path: ["terrainFog", "maxOpacity"] },
  terrainFogHeight: { label: "Terrain fog height", kind: "f32", path: ["terrainFog", "height"] },
  waterMinOpacity: water("minOpacity", "min opacity"),
  waterMaxOpacity: water("maxOpacity", "max opacity"),
  waterReflectivity: water("reflectivity", "reflectivity"),
  waterEmissivity: water("emissivity", "emissivity"),
  waterEdgeSoftness: water("edgeSoftness", "edge softness"),
  waterWavesVertexDisplacement: water("wavesVertexDisplacement", "waves vertex displacement"),
  waterWavesNormalMapStrength: water("wavesNormalMapStrength", "waves normal map strength"),
  waterOverrideColor: water("overrideColor", "override color"),
  waterEnvironmentMapReflectivity: water("environmentMapReflectivity", "environment map reflectivity"),
  waterUnknown: water("unknown", "unknown"),
  playerStartX: { label: "Start X", kind: "f32", path: ["players", "*", "start", 0] },
  playerStartY: { label: "Start Y", kind: "f32", path: ["players", "*", "start", 1] },
} as const satisfies Record<string, InfoNumber>;

export type InfoNumberKey = keyof typeof INFO_NUMBERS;

/** The `water` struct's fields, in the file's order, by their key there. */
export const WATER_NUMBERS: readonly InfoNumberKey[] = (Object.keys(INFO_NUMBERS) as InfoNumberKey[]).filter((k) => INFO_NUMBERS[k].path[0] === "water");

/** What the World Editor does with a typed value of some fields (measured, verify round 3): `abs` drops a minus sign,
 *  then the value is pulled into `min`..`max`. Only on a typed edit: a value already in a map loads and saves as it is. */
interface Clamp { readonly abs?: boolean; readonly min?: number; readonly max?: number }
export const INFO_CLAMPS: { readonly [K in InfoNumberKey]?: Clamp } = {
  waterMinOpacity: { abs: true, max: 100 },
  waterWavesVertexDisplacement: { max: 100 },
  terrainFogMaxOpacity: { min: 0, max: 1 },
  terrainFogLinearStart: { min: 0 },
  zoomMin: { max: 3000 },
  zoomMax: { max: 3000 },
};

/** The value the World Editor keeps when `v` is typed into field `key`. */
export function clampInfoNumber(key: InfoNumberKey, v: number): number {
  const c = INFO_CLAMPS[key];
  if (!c) return v;
  if (c.abs) v = Math.abs(v);
  if (c.min !== undefined && v < c.min) v = c.min;
  if (c.max !== undefined && v > c.max) v = c.max;
  return v;
}

type Obj = Record<string | number, unknown>;
const step = (k: string | number, player: number | undefined) => (k === "*" ? player ?? -1 : k);

/** The field's value in `info` (undefined when the file has none). */
export function infoNumber(info: object, key: InfoNumberKey, player?: number): number | undefined {
  let o: unknown = info;
  for (const k of INFO_NUMBERS[key].path) o = o && typeof o === "object" ? (o as Obj)[step(k, player)] : undefined;
  return typeof o === "number" ? o : undefined;
}

/** Sets a typed value into `info`; a value the field's stored type can't hold is refused and `info` stays as it was. */
export function setInfoNumber(info: object, key: InfoNumberKey, typed: string, player?: number): { value: number } | { refused: string } {
  const field = INFO_NUMBERS[key];
  const t0 = typedNumber(field.kind, typed, field.label);
  if ("refused" in t0) return t0;
  const t = { value: clampInfoNumber(key, t0.value) };
  const path = field.path.map((k) => step(k, player));
  let o = info as Obj;
  for (const k of path.slice(0, -1)) {
    const next = o[k];
    if (!next || typeof next !== "object") return { refused: `${field.label} isn't in this map's file.` };
    o = next as Obj;
  }
  o[path.at(-1)!] = t.value;
  return t;
}
