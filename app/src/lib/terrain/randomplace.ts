// What the Object Placer varies per placed object, as the World Editor's palettes do: Place Random Variation (or a
// chosen variation), Random Rotation, and Random Scale (Tools › Random Doodad Scaling: symmetric, asymmetric,
// asymmetric along Z only or XY only), within the scale range the type allows. And the random objects: Random
// Unit, Random Building and Random Item (ids uDNR, bDNR, iDNR), chosen when the game starts, either by level (an
// item also by class) or from a random group of Map Properties (a group and its position).

/** What a type allows (the terrain editor's TerrainObjectType). */
export interface LookType { numVar: number; randScale: boolean; minScale: number; maxScale: number; fixedRot: number | null }

export type RandomScale = "off" | "symmetric" | "asymmetric" | "z" | "xy";
export const RANDOM_SCALES: [RandomScale, string][] = [
  ["off", "Off"], ["symmetric", "Symmetric"], ["asymmetric", "Asymmetric"], ["z", "Z only"], ["xy", "XY only"],
];

export interface LookOptions {
  /** A chosen variation; null: random with `randomVariation`, else the first. */
  variation: number | null;
  randomVariation: boolean;
  randomRotation: boolean;
  randomScale: RandomScale;
}

export interface Look { variation: number; angle: number; scale: [number, number, number] }

/** Placed objects face 270° unless told otherwise (the game's maps, the World Editor's palettes). */
export const DEFAULT_FACING = 270;
const rad = (d: number) => (d * Math.PI) / 180;

/** How the next object of a type is placed. A fixed rotation always wins; scale changes only for types that
 *  may be placed scaled (canPlaceRandScale) with a range (minScale below maxScale). */
export function rollLook(type: LookType | null, o: LookOptions,
  random: () => number = Math.random): Look {
  const variations = Math.max(1, type?.numVar ?? 1);
  const variation = o.variation !== null ? Math.max(0, Math.min(variations - 1, Math.round(o.variation)))
    : o.randomVariation && variations > 1 ? Math.min(variations - 1, Math.floor(random() * variations)) : 0;
  const angle = type?.fixedRot != null ? rad(type.fixedRot) : o.randomRotation ? random() * Math.PI * 2 : rad(DEFAULT_FACING);
  let scale: [number, number, number] = [1, 1, 1];
  if (type?.randScale && type.maxScale > type.minScale && o.randomScale !== "off") {
    const k = () => type.minScale + random() * (type.maxScale - type.minScale);
    if (o.randomScale === "symmetric") { const s = k(); scale = [s, s, s]; }
    else if (o.randomScale === "asymmetric") scale = [k(), k(), k()];
    else if (o.randomScale === "z") scale = [1, 1, k()];
    else scale = [k(), k(), 1];
  }
  return { variation, angle, scale };
}

// ---- random units, buildings and items -------------------------------------------------------------------

export type RandomWhat = "unit" | "building" | "item";
export const RANDOM_IDS: Record<RandomWhat, string> = { unit: "uDNR", building: "bDNR", item: "iDNR" };
/** Position types of a random group (war3map.w3i), by what they hold. */
export const POSITION_OF: Record<RandomWhat, number> = { unit: 0, building: 1, item: 2 };

/** Item classes of a random item by level (randomClass): 0 any, then the game's classes. */
export const ITEM_CLASSES = ["Any Class", "Permanent", "Charged", "Power Up", "Artifact", "Purchasable", "Campaign", "Miscellaneous"];

export type RandomSpec =
  /** Any of a level (-1: any level); an item also of a class (0: any). A building is any neutral passive one. */
  | { what: RandomWhat; by: "level"; level: number; itemClass?: number }
  /** A random group's position: the object its chosen line has there. */
  | { what: RandomWhat; by: "group"; group: number; position: number };

export interface RandomGroup { number: number; name: string; positions: number[]; lines?: { chance: number; ids: string[] }[] }

/** The 3 bytes of a random level as the placement file's JSON holds them (hex, little-endian; -1 is ffffff). */
export function levelBytes(level: number): string {
  const v = level < 0 ? 0xffffff : Math.min(0xffffff, Math.round(level));
  return [v & 255, (v >> 8) & 255, (v >> 16) & 255].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The random fields of a placed unit or item (war3mapUnits.doo, formats/units.json): only those its randomType
 *  stores, so fields of another kind of random object don't stay behind. */
export function applyRandom(e: Record<string, unknown>, spec: RandomSpec): void {
  for (const k of ["randomLevel", "randomClass", "randomGroup", "randomPosition", "randomUnits"]) delete e[k];
  if (spec.by === "level") {
    Object.assign(e, { randomType: 0, randomLevel: levelBytes(spec.what === "building" ? -1 : spec.level), randomClass: spec.what === "item" ? Math.max(0, Math.min(7, spec.itemClass ?? 0)) : 0 });
  } else {
    Object.assign(e, { randomType: 1, randomGroup: spec.group, randomPosition: spec.position });
  }
}

/** The name a random placement shows (the World Editor's WESTRING_ANYCREEP and friends). */
export function randomName(spec: RandomSpec, groups: readonly RandomGroup[] = []): string {
  const title = { unit: "Random Unit", building: "Random Building", item: "Random Item" }[spec.what];
  if (spec.by === "group") {
    const g = groups.find((x) => x.number === spec.group);
    return `${title} (group ${g ? `“${g.name}”` : spec.group}, position ${spec.position + 1})`;
  }
  const level = spec.level < 0 ? "Any" : `Level ${spec.level}`;
  if (spec.what === "building") return "Random Neutral Passive Building";
  if (spec.what === "unit") return `Random ${level} Neutral Hostile Unit`;
  const cls = spec.itemClass ? `${ITEM_CLASSES[spec.itemClass] ?? "?"} ` : "";
  return `Random ${level} ${cls}Item`;
}

/** The positions of a group that hold this kind of object. */
export const positionsFor = (g: RandomGroup, what: RandomWhat) => g.positions.flatMap((t, i) => (t === POSITION_OF[what] ? [i] : []));

/** For Cycle Random Groups: what a placed object from a random group is drawn as, with its group's `cycle`th line
 *  (wrapping; `cycle` may be negative). Undefined for other objects, an unknown group or an empty slot. */
export function cycledId(e: { id: string; randomType?: number; randomGroup?: number; randomPosition?: number }, groups: readonly RandomGroup[], cycle: number): string | undefined {
  if (!/^[uib]DNR$/.test(e.id) || e.randomType !== 1) return undefined;
  const g = groups.find((x) => x.number === e.randomGroup);
  const lines = g?.lines ?? [];
  if (!lines.length) return undefined;
  const line = lines[((cycle % lines.length) + lines.length) % lines.length];
  const id = line.ids[e.randomPosition ?? 0];
  return id && id !== "0x00000000" && !/^\0+$/.test(id) ? id : undefined;
}
