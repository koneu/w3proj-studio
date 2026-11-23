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

/** What the World Editor does with a typed value of some fields (measured: verify round 3, ya.md 2026-11-22): `abs`
 *  drops a minus sign, `round2` rounds to two decimals (of the float32, so 0.005 is 0.00), then the value is pulled
 *  into `min`..`max`. Only on a typed edit: a value already in a map loads and saves as it is. */
interface Clamp { readonly abs?: boolean; readonly round2?: boolean; readonly min?: number; readonly max?: number }
const WATER_CLAMP: Clamp = { min: 0, max: 100 };
const FOG_CLAMP: Clamp = { round2: true, min: 0, max: 100000 };
const ZOOM_CLAMP: Clamp = { min: 1250, max: 3000 };
export const INFO_CLAMPS: { readonly [K in InfoNumberKey]?: Clamp } = {
  waterMinOpacity: { abs: true, ...WATER_CLAMP },
  waterMaxOpacity: WATER_CLAMP,
  waterEmissivity: WATER_CLAMP,
  waterReflectivity: WATER_CLAMP,
  waterEdgeSoftness: WATER_CLAMP,
  waterEnvironmentMapReflectivity: WATER_CLAMP,
  waterWavesVertexDisplacement: WATER_CLAMP,
  waterWavesNormalMapStrength: WATER_CLAMP,
  terrainFogMaxOpacity: { min: 0, max: 1 },
  terrainFogLinearStart: FOG_CLAMP,
  terrainFogLinearEnd: FOG_CLAMP,
  terrainFogHeight: { round2: true, min: -100000, max: 100000 },
  fogStart: FOG_CLAMP,
  fogEnd: FOG_CLAMP,
  fogDensity: { round2: true, min: 0, max: 100 },
  zoomMin: ZOOM_CLAMP,
  zoomMax: ZOOM_CLAMP,
  zoomDefault: ZOOM_CLAMP,
};

/** The value the World Editor keeps when `v` is typed into field `key` (before the pair rules of `ORDERED`). */
export function clampInfoNumber(key: InfoNumberKey, v: number): number {
  const c = INFO_CLAMPS[key];
  if (!c) return v;
  if (c.abs) v = Math.abs(v);
  if (c.round2) v = Number(Math.fround(v).toFixed(2));
  if (c.min !== undefined && v < c.min) v = c.min;
  if (c.max !== undefined && v > c.max) v = c.max;
  return v;
}

/** The text a field's box lets through as it is typed: some boxes drop "-" and "." and hold only so many characters. */
const TYPING: { readonly [K in InfoNumberKey]?: { readonly drop?: string; readonly maxLength?: number } } = {
  ...Object.fromEntries(WATER_NUMBERS.filter((k) => INFO_CLAMPS[k]).map((k) => [k, { drop: "-." }])),
  zoomMin: { drop: "-.", maxLength: 4 },
  zoomMax: { drop: "-.", maxLength: 4 },
  zoomDefault: { drop: "-.", maxLength: 4 },
};

/** What field `key`'s box holds after `text` was typed into it ("-5" is "5" in a water field, 12345 is 1234 in a zoom
 *  field). Fields with no rule give `text` back. */
export function filterInfoTyping(key: InfoNumberKey, text: string): string {
  const t = TYPING[key];
  if (!t) return text;
  let out = t.drop ? [...text].filter((c) => !t.drop!.includes(c)).join("") : text;
  if (t.maxLength !== undefined) out = out.slice(0, t.maxLength);
  return out;
}

/** The text field `key`'s box takes at most (for its maxlength), if limited. */
export const infoTypingLimit = (key: InfoNumberKey): number | undefined => TYPING[key]?.maxLength;
/** Whether field `key`'s box is a plain text one (its filter drops characters a number box would keep). */
export const infoTypingFiltered = (key: InfoNumberKey): boolean => TYPING[key] !== undefined;

/** Fields the editor keeps in order after an edit: each group lists its fields lowest first; the edited field keeps
 *  its value (within the limits of its neighbours when it is a middle one) and the others are pushed. */
const ORDERED: readonly (readonly InfoNumberKey[])[] = [
  ["zoomMin", "zoomDefault", "zoomMax"],
  ["waterMinOpacity", "waterMaxOpacity"],
  ["fogStart", "fogEnd"],
  ["terrainFogLinearStart", "terrainFogLinearEnd"],
];

type Obj = Record<string | number, unknown>;
const step = (k: string | number, player: number | undefined) => (k === "*" ? player ?? -1 : k);
const place = (info: object, key: InfoNumberKey): [Obj, string | number] | undefined => {
  const path = INFO_NUMBERS[key].path;
  let o: unknown = info;
  for (const k of path.slice(0, -1)) o = o && typeof o === "object" ? (o as Obj)[k] : undefined;
  return o && typeof o === "object" ? [o as Obj, path.at(-1)!] : undefined;
};

/** After `key` got a value: pulls the other fields of its group into order. A zoom default above the maximum is the
 *  maximum (the typed one gives way); every other edit pushes the others. The water pair only pulls Min down. */
function keepOrder(info: object, key: InfoNumberKey): void {
  const group = ORDERED.find((g) => g.includes(key));
  if (!group) return;
  const cells = group.map((k) => place(info, k));
  if (cells.some((c) => !c || typeof c[0][c[1]] !== "number")) return;
  const val = (i: number) => cells[i]![0][cells[i]![1]] as number;
  const put = (i: number, v: number) => { cells[i]![0][cells[i]![1]] = v; };
  const at = group.indexOf(key);
  if (group[0] === "waterMinOpacity") { if (at === 1 && val(0) > val(1)) put(0, val(1)); return; }
  if (key === "zoomDefault") { if (val(1) > val(2)) put(1, val(2)); if (val(1) < val(0)) put(0, val(1)); return; }
  for (let i = at + 1; i < group.length; i++) if (val(i) < val(i - 1)) put(i, val(i - 1));
  for (let i = at - 1; i >= 0; i--) if (val(i) > val(i + 1)) put(i, val(i + 1));
}

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
  keepOrder(info, key);
  return t;
}
