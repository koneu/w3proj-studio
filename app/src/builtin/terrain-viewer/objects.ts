// Turns placed doodads/destructables/units/items into model batches for the
// terrain renderer: model paths and replaceable textures come from the game's
// skin tables, models and textures are loaded once and shared.

import type { W3Api } from "../../extensions/api";
import { decodeImage } from "../../lib/image/index.ts";
import { readModel } from "../../lib/model/mdl";
import { parseMdx, type Model } from "../../lib/model/mdx";
import { parseAnimProps } from "../../lib/model/stand";
import { neverStoredLast, textureCandidates } from "../../lib/model/texpath";
import { createTexture, drawnTextures } from "../../lib/model/gltexture";
import { placeholderImage, placeholderModel } from "../../lib/model/placeholder";
import { worldSphere } from "../../lib/model/frustum";
import { skinTextures } from "../../lib/model/replaceable";
import { bounds, hdSlots, mat4, ModelGpu, poseNodes, standClock, type Mat4 } from "../../lib/model/renderer";
import { parseIni, parseSlk } from "../../lib/formats/text";
import { artValue, reforgedArt } from "../../lib/objects/artset";
import { SKIN_KINDS, SkinIds } from "../../lib/objects/skinids";
import type { EffectSource, ObjectBatch, ObjectInstance } from "./renderer";

export interface Placed {
  id: string;
  variation: number;
  position: [number, number, number];
  /** Radians. */
  angle: number;
  scale: [number, number, number];
  /** Units only. */
  player?: number;
  /** Units only: the player field's bits above the owner (lib/terrain/owner.ts), e.g. an Ancient placed uprooted. */
  playerFlags?: number;
}

export interface Skin {
  /** Object data file the type belongs to: w3d, w3b, w3u or w3t. */
  kind: string;
  file: string;
  /** The 3.0 art (DE) only, when the entry names no `file:de` and its HD art (`file:hd`) is another model: that model,
   *  read when `file`'s isn't stored (reforgedArt). */
  reforgedFile?: string;
  numVar: number;
  /** Replaceable texture this type swaps in (trees, cliffs). */
  texId: number;
  texFile: string;
  /** Extra model scale (units). */
  modelScale: number;
  /** Random scale range for new placements (when canPlaceRandScale). */
  minScale: number;
  maxScale: number;
  randScale: boolean;
  /** Fixed facing in degrees, or null for any. */
  fixedRot: number | null;
  /** Ground mark (Splats\UberSplatData.slk name; buildings), "" for none. */
  uberSplat: string;
  /** The look of a model that holds several, as its words (Animprops, see lib/model/stand). */
  animProps?: string[];
  /** Units: movement type (UnitData.slk movetp: foot, horse, fly, hover, float, amph), which decides
   *  how high the game puts them (see unitDrawHeight). */
  moveType?: string;
  /** Units: flying height (UnitData.slk moveHeight, field `umvh`), at which a flying or hovering unit is drawn over the
   *  ground (see unitDrawHeight). */
  moveHeight?: number;
  /** Units: the shadow texture under them (ReplaceableTextures\Shadows\<name>, UnitSkin.txt `unitShadow`, field
   *  `ushu`), and its rectangle: `shadowX`/`shadowY` from its south-west corner to the unit, `shadowW` × `shadowH`. */
  unitShadow?: string;
  shadowX?: number;
  shadowY?: number;
  shadowW?: number;
  shadowH?: number;
  /** Buildings (`buildingShadow`, `ushb`) and destructables (`shadow`, `bshd`): a shadow image of one texel per
   *  32 × 32 cell, put into the ground's shadow map (viewshadows.ts). */
  buildingShadow?: string;
  /** Doodads: false when the World Editor leaves them out of the baked shadow map, war3map.shd (DoodadSkins.txt
   *  `shadow=0`, field `dshd`: corn, flowers, rubble, …); otherwise they cast into it. */
  bakesShadow?: boolean;
  /** Units: a team colour of the type's own (UnitSkin.txt `teamColor`, field `utco`; the tavern and the mercenary
   *  camps), drawn whoever owns it; absent: the owner's. */
  teamColor?: number;
  /** Units: a placed one's own colour (war3mapUnits.doo `color`) is drawn (UnitSkin.txt `customTeamColor`, field `utcc`,
   *  Allow Custom Team Color: the waygate's). */
  customColor?: boolean;
  /** Units: Tinting Color (UnitSkin.txt `red`, `green`, `blue`, fields `uclr`, `uclg`, `uclb`, 0-255; absent: 255). */
  red?: number;
  green?: number;
  blue?: number;
  /** Doodads: the World Editor draws its click helper by the model (Doodads.slk `useClickHelper`, field `duch`: fires,
   *  traps, flies, dust, …, whose models are mostly particles; see CLICK_HELPER). */
  clickHelper?: boolean;
  /** Doodads: stands on the water where there is water (Doodads.slk `floats`, field `dflt`: lily pads, seaweed,
   *  bubbles; lib/terrain/w3e.ts floatingLevelAt). */
  floats?: boolean;
  /** Destructables: Elevation Sample Radius (DestructableData.slk `radius`, field `brad`), by which the World Editor
   *  puts one on the mean of the ground round it (objheights.ts doodadGround); absent for 0. A custom type has none,
   *  whatever its data says (we-compare doodad-open-z, 2026-11-16: custom copies of the stone wall LTw0 with radius
   *  0, 25, 50, 100, 200 and none changed all stood on the point under them). */
  elevRadius?: number;
  /** Units: Art - Elevation - Sample Points (UnitSkin.txt `elevPts`, field `uept`), the points round a unit the World
   *  Editor puts it on the ground by (objheights.ts unitGround); absent for none. */
  elevPts?: number;
  /** Units: Pathing - Collision Size (UnitBalance.slk `collision`, field `ucol`). */
  collision?: number;
  /** Units: Stats - Is a Building (UnitBalance.slk `isbldg`, field `ubdg`). */
  building?: boolean;
}

/**
 * The World Editor's click helper (WorldEditData.txt, [WorldEditArt] ClickHelper, [WorldEditMisc] ClickHelperScale,
 * [WorldEditColors] ClickHelperColor 96,255,255,255): the checkered cube model InvalidObject (128 a side, its texture
 * BTNtempW's white squares coloured magenta by its geoset) at 0.4 of the doodad's size, see-through (alpha 96/255),
 * standing where the doodad stands and turned with it. Only the editor's view shows it, not its game view (we-drive,
 * branch render-fixes-6: a purple cube about 51 a side on every `useClickHelper` doodad, in SD and HD).
 */
export const CLICK_HELPER = { model: "Objects\\InvalidObject\\InvalidObject.mdx", scale: 0.4, tint: [1, 1, 1, 96 / 255] as [number, number, number, number] };

/** Puts Doodads.slk's click helpers and floating types on the doodads' skins. */
export function addClickHelpers(skins: Map<string, Skin>, rows: readonly Record<string, string>[]) {
  for (const r of rows) {
    const skin = r.doodID ? skins.get(r.doodID) : undefined;
    if (skin?.kind === "w3d" && r.useClickHelper?.trim() === "1") skin.clickHelper = true;
    if (skin?.kind === "w3d" && r.floats?.trim() === "1") skin.floats = true;
  }
}

/** Puts DestructableData.slk's Elevation Sample Radii on the destructables' skins. */
export function addElevationRadii(skins: Map<string, Skin>, rows: readonly Record<string, string>[]) {
  for (const r of rows) {
    const skin = r.DestructableID ? skins.get(r.DestructableID) : undefined, n = Number(r.radius);
    if (skin?.kind === "w3b" && r.radius?.trim() && Number.isFinite(n) && n > 0) skin.elevRadius = n;
  }
}

/** Player colours a placed object can be drawn in (0 Red … 23 Peanut). */
const PLAYER_COLORS = 24;

/** The team colour a placed object of this type is drawn in: its own colour (`color`, 0–23) where the type allows one
 *  (Skin.customColor: a waygate's Custom Color), else the type's own (Skin.teamColor), else its owner's. As the World
 *  Editor draws them (we-drive, 2026-11-10): a waygate in its colour, one of a type without utcc and a footman with a
 *  stored colour in the owner's. */
export const drawnTeam = (skin: Skin, owner: number, color?: number): number =>
  skin.customColor && color !== undefined && Number.isInteger(color) && color >= 0 && color < PLAYER_COLORS ? color : skin.teamColor ?? owner;

/** The colour a type's model is multiplied by (its Tinting Color as 0-1), absent when it is the model's own (255, 255, 255).
 *  The World Editor draws a footman with 255, 40, 40 all red (we-compare looks, branch we-compare-5). */
export function paintOf(skin: Pick<Skin, "red" | "green" | "blue">): [number, number, number] | undefined {
  const part = (v: number | undefined) => (v === undefined || !Number.isFinite(v) ? 1 : Math.min(255, Math.max(0, v)) / 255);
  const paint: [number, number, number] = [part(skin.red), part(skin.green), part(skin.blue)];
  return paint[0] === 1 && paint[1] === 1 && paint[2] === 1 ? undefined : paint;
}

/** Random unit, building and item (war3mapUnits.doo) and the object kind each is placed as. */
export const RANDOM_KINDS: readonly (readonly [string, string])[] = [["uDNR", "w3u"], ["bDNR", "w3u"], ["iDNR", "w3t"]];
const RANDOM_MODEL = "Objects\\RandomObject\\RandomObject.mdl";

/** The tables with units' Animprops, which the skin table doesn't carry. */
const UNIT_FUNC = ["Human", "Orc", "Undead", "NightElf", "Neutral", "Campaign"].map((r) => `Units\\${r}UnitFunc.txt`);

/** Puts a unit table's Animprops on the skins. */
export function addAnimProps(skins: Map<string, Skin>, text: string) {
  for (const [id, sec] of parseIni(text)) {
    const skin = skins.get(id.trim()), props = parseAnimProps(sec.get("animprops") ?? "");
    if (skin && props.length) skin.animProps = props;
  }
}

/** Puts the unit table's movement types and flying heights on the skins. */
export function addMoveTypes(skins: Map<string, Skin>, rows: readonly Record<string, string>[]) {
  for (const r of rows) {
    const skin = r.unitID ? skins.get(r.unitID) : undefined;
    if (!skin) continue;
    if (r.movetp) skin.moveType = r.movetp;
    const height = Number(r.moveHeight);
    if (r.moveHeight?.trim() && Number.isFinite(height)) skin.moveHeight = height;
  }
}

/** Puts the unit balance table's collision sizes and building marks on the skins. */
export function addUnitBalance(skins: Map<string, Skin>, rows: readonly Record<string, string>[]) {
  for (const r of rows) {
    const skin = r.unitBalanceID ? skins.get(r.unitBalanceID) : undefined;
    if (skin?.kind !== "w3u") continue;
    const collision = Number(r.collision);
    if (r.collision?.trim() && Number.isFinite(collision)) skin.collision = collision;
    if (r.isbldg?.trim() === "1") skin.building = true;
  }
}

/** A type's skin with nothing set but its kind and model: what every other field is when no table gives it. */
export const plainSkin = (kind: string, file: string): Skin =>
  ({ kind, file, numVar: 1, texId: -1, texFile: "", modelScale: 1, minScale: 1, maxScale: 1, randScale: false, fixedRot: null, uberSplat: "" });

/** The kinds drawn, in the order their skin tables are read (a later one's entry wins), with each kind's data
 *  table and its id column: the type ids as placed objects name them, whose skin section may be spelled in another
 *  case (lib/objects/skinids.ts). */
const DRAWN_KINDS: [string, string, string][] = [
  ["w3d", "Doodads\\Doodads.slk", "doodID"], ["w3b", "Units\\DestructableData.slk", "DestructableID"],
  ["w3u", "Units\\UnitData.slk", "unitID"], ["w3t", "Units\\ItemData.slk", "itemID"],
];
const SKIN_FILES: [string, string][] = DRAWN_KINDS.map(([kind]) => [SKIN_KINDS[kind].files[0], kind]);

/** Every game table the skins are made from, in the order they're read. */
const SKIN_TABLES = [...new Set([...SKIN_FILES.map(([f]) => f), ...UNIT_FUNC, ...DRAWN_KINDS.map(([, table]) => table), "Units\\UnitBalance.slk"])];

/** The skins last made, with what they were made from: reading the tables again is cheap (the game's
 *  files are kept, see workbench/game.ts), parsing them isn't (tens of ms, on each reload of the
 *  placed objects). Made again when the install, the graphics mode or any table's text differs, so a
 *  reloaded or patched game (w3.game.reload) is seen too, and a table that couldn't be read (taken as
 *  empty, as without the cache) is parsed again once it can be. */
let skinCache: { install: string; mode: string; texts: string[]; skins: Map<string, Skin> } | null = null;
/** Times the skins were parsed: for the tests. */
export const skinParses = { count: 0 };

/** Model info per object id. Keys with a graphics-mode suffix ("file:hd")
 *  win over plain ones. The game's own: a map's object data goes on top with withObjectArt. The
 *  entries are shared between callers and frozen; the map is the caller's own. */
export async function loadSkins(w3: W3Api): Promise<Map<string, Skin>> {
  const install = w3.settings.get<string>("game.installDir") ?? "";
  const mode = w3.settings.get<string>("game.graphicsMode") ?? "hd";
  const texts = await Promise.all(SKIN_TABLES.map((f) => w3.game.readText(f).catch(() => "")));
  const kept = skinCache;
  if (kept && kept.install === install && kept.mode === mode && kept.texts.every((t, i) => t === texts[i])) return new Map(kept.skins);
  const skins = parseSkins(mode, texts);
  for (const s of skins.values()) { if (s.animProps) Object.freeze(s.animProps); Object.freeze(s); }
  // The install or mode changed during the reads: they may be of either, so they aren't kept.
  const settled = install === (w3.settings.get<string>("game.installDir") ?? "") && mode === (w3.settings.get<string>("game.graphicsMode") ?? "hd");
  skinCache = settled ? { install, mode, texts, skins } : null;
  return new Map(skins);
}

/** A shadow image's name as the tables give it: "", "_" and "none" are none. */
export function shadowName(v: string | undefined): string | undefined {
  const s = v?.trim();
  return s && s !== "_" && s.toLowerCase() !== "none" ? s : undefined;
}

/** The shadow fields of a skin table entry (units and destructables; doodads' `shadow` is whether the World
 *  Editor bakes them into war3map.shd). */
function shadowFields(get: (k: string) => string | undefined, kind: string): Partial<Skin> {
  if (kind === "w3d") return get("shadow")?.trim() === "0" ? { bakesShadow: false } : {};
  if (kind === "w3b") {
    const building = shadowName(get("shadow"));
    return building ? { buildingShadow: building } : {};
  }
  if (kind !== "w3u") return {};
  const out: Partial<Skin> = {};
  const unit = shadowName(get("unitshadow")), building = shadowName(get("buildingshadow"));
  if (unit) {
    out.unitShadow = unit;
    for (const [k, f] of [["shadowX", "shadowx"], ["shadowY", "shadowy"], ["shadowW", "shadoww"], ["shadowH", "shadowh"]] as const) {
      const n = Number(get(f));
      if (Number.isFinite(n)) out[k] = n;
    }
  }
  if (building) out.buildingShadow = building;
  const team = Number(get("teamcolor"));
  if (get("teamcolor")?.trim() && Number.isInteger(team) && team >= 0) out.teamColor = team;
  if (get("customteamcolor")?.trim() === "1") out.customColor = true;
  for (const k of ["red", "green", "blue"] as const) {
    const v = get(k)?.trim(), n = Number(v);
    if (v && Number.isFinite(n) && n !== 255) out[k] = n;
  }
  return out;
}

/** A doodad's model scale on top of its placed one: its DoodadSkins.txt `defScale`, in HD `defScale:hd` where the type
 *  has one; 1 without either. The World Editor draws a placed doodad that much larger or smaller, and bakes its
 *  Calculate Shadows at that size. HD (we-drive, branch we-compare-8, 2026-11-18, doodads placed at scale 1 against
 *  Studio's picture): RuinFountain ZOfo, defScale 0.9 and defScale:hd 1.45, came out 1.42 to 1.5 times as large;
 *  RibBones LOrb, 1 and 1.75, 1.77 to 1.8, also at scale 2; Corn LPcr 1.1 about 1.07; AshenShrooms APms 0.65 smaller.
 *  The plain defScale in both modes (branch we-compare-11, 2026-11-19, shadow-defscale-sd.w3x from
 *  make-shadow-probes.mjs, placed at scale 1, the save keeping 1): the Barrens spires BRsp (0.36, no defScale:hd) are
 *  drawn about a third of Studio's size in SD and in HD, ZOfo 0.87 of it in SD; Calculate Shadows shades BRsp 26 cells
 *  against Studio's 200 in SD (200 x 0.36 squared), 8 against 76 in HD, ZOfo 84 against 99 (0.9 squared: 80), BOth
 *  (0.95) 201 against 224, the cauldron LOca (1.2) 9 against 7, the tavern sign YOta (1.4) 4 against 1 in SD and 13
 *  against 7 in HD; LRrk, LOce and NSct (1) the same in both. */
export function doodadModelScale(get: (key: string) => string | undefined, mode: string): number {
  const own = (key: string) => { const v = Number(get(key)); return Number.isFinite(v) && v > 0 ? v : null; };
  return (mode === "hd" ? own("defscale:hd") : null) ?? own("defscale") ?? 1;
}

/** The skins from the tables' texts, in SKIN_TABLES' order. */
function parseSkins(mode: string, texts: string[]): Map<string, Skin> {
  skinParses.count++;
  const out = new Map<string, Skin>();
  const tables = new Map(SKIN_TABLES.map((f, i) => [f, texts[i]]));
  const rowsOf = new Map<string, Record<string, string>[]>();
  const rows = (table: string) => rowsOf.get(table) ?? rowsOf.set(table, parseSlk(tables.get(table) ?? "")).get(table)!;
  for (const [f, kind] of SKIN_FILES) {
    // In the doodad and destructable tables a key given twice keeps its first value, as the World Editor reads them:
    // the tree bridges' minScale and maxScale (0.8 and 1, then 1 and 0.8) are 0.8 to 1 (doodadrules.ts). Their only
    // other twice-given key is DoodadSkins.txt's defScale, unused here. UnitSkin.txt's twice-given modelScales weren't
    // compared with the editor: they keep the last.
    const sections = parseIni(tables.get(f) ?? "", { firstWins: kind === "w3d" || kind === "w3b" });
    const own = new Map<string, Skin>();
    for (const [id, sec] of sections) {
      const get = (k: string) => artValue((key) => sec.get(key), k, mode);
      const file = get("file");
      if (!file) continue;
      const reforged = reforgedArt((key) => sec.get(key), "file", mode);
      own.set(id, {
        kind,
        file,
        ...(reforged && reforged.toLowerCase() !== file.toLowerCase() ? { reforgedFile: reforged } : {}),
        numVar: Number(get("numvar") ?? 1) || 1,
        texId: Number(get("texid") ?? -1),
        texFile: get("texfile") ?? "",
        modelScale: kind === "w3d" ? doodadModelScale((key) => sec.get(key), mode) : Number(get("modelscale") ?? 1) || 1,
        minScale: Number(get("minscale") ?? 1) || 1,
        maxScale: Number(get("maxscale") ?? 1) || 1,
        randScale: get("canplacerandscale") === "1",
        fixedRot: Number(get("fixedrot") ?? -1) >= 0 ? Number(get("fixedrot")) : null,
        uberSplat: get("ubersplat") ?? "",
        ...shadowFields(get, kind),
        ...(kind === "w3u" && Number(get("elevpts")) > 0 ? { elevPts: Number(get("elevpts")) } : {}),
      });
    }
    // Types whose section is spelled in another case (doodad Yosh: [YOsh]) under their own id too.
    const [, table, key] = DRAWN_KINDS.find(([k]) => k === kind)!;
    const skinIds = new SkinIds(kind, [...sections].map(([id, sec]) => [id, sec.get("skintype")]));
    for (const r of rows(table)) {
      const id = r[key], section = id ? skinIds.section(id) : undefined;
      const skin = section !== undefined && section !== id ? own.get(section) : undefined;
      if (id && skin && !own.has(id)) own.set(id, { ...skin });
    }
    for (const [id, skin] of own) out.set(id, skin);
  }
  for (const f of UNIT_FUNC) addAnimProps(out, tables.get(f) ?? "");
  addMoveTypes(out, rows("Units\\UnitData.slk"));
  addUnitBalance(out, rows("Units\\UnitBalance.slk"));
  addClickHelpers(out, rows("Doodads\\Doodads.slk"));
  addElevationRadii(out, rows("Units\\DestructableData.slk"));
  // Start locations have no skin entry; the World Editor draws them with this model
  // (WorldEditData.txt, StartLocation), which also makes them selectable here.
  if (!out.has("sloc")) {
    out.set("sloc", plainSkin("w3u", "Objects\\StartLocation\\StartLocation.mdl"));
  }
  // Random units, buildings and items (chosen when the game starts) have no type either: the World Editor draws
  // them with its question mark (WorldEditData.txt, RandomUnitModel).
  for (const [id, kind] of RANDOM_KINDS) {
    if (!out.has(id)) out.set(id, plainSkin(kind, RANDOM_MODEL));
  }
  return out;
}

/** Object data fields that change a skin entry, per kind (UnitMetaData & co., "Profile" fields;
 *  units' alternate models umd1/umd2 and selection scale aren't drawn). */
const ART_FIELDS: Record<string, Partial<Record<keyof Skin, string>>> = {
  w3u: {
    file: "umdl", modelScale: "usca", uberSplat: "uubs", animProps: "uani", moveType: "umvt", moveHeight: "umvh",
    unitShadow: "ushu", shadowX: "ushx", shadowY: "ushy", shadowW: "ushw", shadowH: "ushh", buildingShadow: "ushb", teamColor: "utco",
    customColor: "utcc", red: "uclr", green: "uclg", blue: "uclb", elevPts: "uept", collision: "ucol", building: "ubdg",
  },
  w3t: { file: "ifil", modelScale: "isca" },
  w3d: { file: "dfil", numVar: "dvar", minScale: "dmis", maxScale: "dmas", randScale: "dcpr", fixedRot: "dfxr", bakesShadow: "dshd", clickHelper: "duch", floats: "dflt" },
  w3b: { file: "bfil", numVar: "bvar", texId: "btxi", texFile: "btxf", minScale: "bmis", maxScale: "bmas", randScale: "bcpr", fixedRot: "bfxr", buildingShadow: "bshd", elevRadius: "brad" },
};

interface ArtMod { field: string; value: number | string }
interface ArtObject { base: string; id?: string; mods?: ArtMod[]; sets?: { mods: ArtMod[] }[] }
/** A map's (or campaign's) object data file of one kind, as its project JSON. */
export interface ObjectArt { kind: string; original?: ArtObject[]; custom?: ArtObject[] }

/** The skins with the map's object data applied: custom objects get their base's entry with
 *  the fields the map sets (model, scale, variations, texture, …), modified standard objects
 *  their own. Later files win (campaign, then map, then the map's Skin files). */
export function withObjectArt(skins: Map<string, Skin>, files: ObjectArt[]): Map<string, Skin> {
  const out = new Map(skins);
  for (const f of files) {
    const fields = ART_FIELDS[f.kind];
    if (!fields) continue;
    const custom = new Set(f.custom ?? []);
    for (const o of [...(f.original ?? []), ...(f.custom ?? [])]) {
      const id = o.id ?? o.base;
      const mods = [...(o.mods ?? []), ...(o.sets ?? []).flatMap((x) => x.mods)];
      const art = mods.filter((m) => Object.values(fields).includes(m.field));
      if (!art.length && o.id === undefined) continue;
      const base = out.get(id) ?? out.get(o.base);
      const skin: Skin = base ? { ...base } : plainSkin(f.kind, "");
      for (const [key, field] of Object.entries(fields) as [keyof Skin, string][]) {
        const m = art.find((x) => x.field === field);
        if (!m) continue;
        const n = Number(m.value);
        if (key === "file") { skin.file = String(m.value); delete skin.reforgedFile; }
        else if (key === "texFile" || key === "uberSplat" || key === "moveType") skin[key] = String(m.value);
        else if (key === "unitShadow" || key === "buildingShadow") skin[key] = shadowName(String(m.value));
        else if (key === "animProps") skin.animProps = parseAnimProps(String(m.value));
        else if (key === "randScale") skin.randScale = n === 1;
        else if (key === "bakesShadow") skin.bakesShadow = n !== 0;
        else if (key === "clickHelper") { if (n === 1) skin.clickHelper = true; else delete skin.clickHelper; }
        else if (key === "floats") { if (n === 1) skin.floats = true; else delete skin.floats; }
        else if (key === "customColor") { if (n === 1) skin.customColor = true; else delete skin.customColor; }
        else if (key === "fixedRot") skin.fixedRot = n >= 0 ? n : null;
        else if (key === "teamColor") { if (Number.isInteger(n) && n >= 0) skin.teamColor = n; else delete skin.teamColor; }
        else if (key === "elevRadius") { if (Number.isFinite(n) && n > 0) skin.elevRadius = n; else delete skin.elevRadius; }
        else if (key === "elevPts") { if (Number.isInteger(n) && n > 0) skin.elevPts = n; else delete skin.elevPts; }
        else if (key === "building") { if (n === 1) skin.building = true; else delete skin.building; }
        else if (key === "collision") { if (Number.isFinite(n)) skin.collision = n; }
        else if ((key === "numVar" || key === "texId" || key === "modelScale" || key === "minScale" || key === "maxScale"
          || key === "red" || key === "green" || key === "blue" || key === "shadowX" || key === "shadowY" || key === "shadowW" || key === "shadowH" || key === "moveHeight") && Number.isFinite(n)) skin[key] = n;
      }
      // A custom type stands on the point under it, whatever its Elevation Sample Radius (Skin.elevRadius).
      if (custom.has(o)) delete skin.elevRadius;
      if (skin.file) out.set(id, skin);
    }
  }
  return out;
}

/** Model path of one placed object: variations are numbered files. */
export function modelPath(skin: Pick<Skin, "file" | "numVar">, variation: number): string {
  const base = skin.file.replace(/\.(mdl|mdx)$/i, "");
  return `${base}${skin.numVar > 1 ? variation : ""}.mdx`;
}


/** Whether a model's own particle effects show anything. Some Reforged models keep their classic emitters as empty
 *  placeholders (the Lordaeron brazier LObr: colours and alphas all 0) next to their PopcornFX fire: those count as
 *  none, so the classic model's emitters stand in as for the others. */
export function drawsParticles(m: Pick<Model, "particleEmitters2" | "ribbons">): boolean {
  return m.ribbons.length > 0 || m.particleEmitters2.some((e) => e.segmentAlpha.some((a) => a > 0));
}

/** The 3.0 art's (DE) other model of a placed object (Skin.reforgedFile), read when its own isn't stored. */
export function reforgedModelPath(skin: Pick<Skin, "reforgedFile" | "numVar">, variation: number): string | undefined {
  return skin.reforgedFile ? modelPath({ file: skin.reforgedFile, numVar: skin.numVar }, variation) : undefined;
}

const reforgedRequest = (skin: Skin, variation: number): { reforged?: string } => {
  const reforged = reforgedModelPath(skin, variation);
  return reforged ? { reforged } : {};
};

/** The model to read when a variation's file isn't stored: the type's file without a number. The classic game
 *  keeps some types of several variations in one file (the City wall endcap YSw5: numVar 2, but only
 *  CityWallEndcap.mdx in War3.w3mod; the numbered files are Reforged's), which the World Editor's SD view shows. */
export function plainModelPath(skin: Pick<Skin, "file" | "numVar">): string | undefined {
  return skin.numVar > 1 ? `${skin.file.replace(/\.(mdl|mdx)$/i, "")}.mdx` : undefined;
}

/** The scales a placed object of this type is drawn within, [least, most], or undefined for any: a doodad's or
 *  destructable's type's minScale and maxScale. The World Editor draws one stored outside them at the nearest end
 *  (ZZdt, 1 to 1, placed at 4 shows at 1; the armor rack LOam, 0.8 to 2, placed at 3 shows at 2; the hay cart LOch,
 *  0.8 to 1.2, placed at 2, 1, 1 is longer than one at 0.3; Lordaeron's tree LTlt, 0.8 to 1.2, placed at 0.4 and 3
 *  about as big as one at 1: we-drive, SD and HD, branch render-fixes-6), each axis on its own; the stored scale
 *  stays as it is. Units and items have no such range. */
export function scaleRange(skin: Pick<Skin, "kind" | "minScale" | "maxScale">): readonly [number, number] | undefined {
  if (skin.kind !== "w3d" && skin.kind !== "w3b") return undefined;
  const { minScale: lo, maxScale: hi } = skin;
  return Number.isFinite(lo) && Number.isFinite(hi) && lo > 0 && hi >= lo ? [lo, hi] : undefined;
}

/** The range a doodad's or destructable's scale is saved within (doodadrules.ts ScaleRule), its type's minScale and
 *  maxScale, also the wrong way round (then the least wins); undefined for units, items and ranges that aren't two
 *  positive numbers. */
export function savedScaleRange(skin: Pick<Skin, "kind" | "minScale" | "maxScale">): readonly [number, number] | undefined {
  if (skin.kind !== "w3d" && skin.kind !== "w3b") return undefined;
  const { minScale: lo, maxScale: hi } = skin;
  return Number.isFinite(lo) && Number.isFinite(hi) && lo > 0 && hi > 0 ? [lo, hi] : undefined;
}

/** World matrix: translate · rotate about z · scale (column-major). `z`: drawn at another height than
 *  the stored one (a ship on the water, see unitDrawHeight). `range`: the scales it's drawn within (scaleRange). */
export function placement(p: Placed, extraScale: number, z = p.position[2], range?: readonly [number, number]): Mat4 {
  const c = Math.cos(p.angle), s = Math.sin(p.angle);
  // A mirrored axis (a negative scale) stays mirrored.
  const [sx, sy, sz] = p.scale.map((v) => (range ? Math.sign(v || 1) * Math.min(range[1], Math.max(range[0], Math.abs(v))) : v) * extraScale);
  const [x, y] = p.position;
  return new Float32Array([c * sx, s * sx, 0, 0, -s * sy, c * sy, 0, 0, 0, 0, sz, 0, x, y, z, 1]);
}

/** One model to draw at the given places. */
export interface ModelRequest {
  path: string;
  /** Read instead when `path` isn't stored (plainModelPath). */
  plain?: string;
  /** Read when neither `path` nor `plain` is stored: the type's HD art in the 3.0 art set (reforgedModelPath). */
  reforged?: string;
  /** Replaceable texture id → path (e.g. a tree type's own texture). */
  replaceable: Record<number, string>;
  instances: ObjectInstance[];
  /** The look to stand in (Animprops). */
  props?: readonly string[];
  /** Swaps texture paths the game substitutes at runtime (HD cliff placeholders); `slot`: the texture's place in the
   *  model's HD layers (hdSlots), when it has one. */
  retexture?: (path: string, slot?: string) => string;
  /** What tells this request's `retexture` from another's of the same model (a cliff type's id): loaded models are
   *  shared by path, replaceable textures, look and this. */
  retextureKey?: string;
  /** Drawn in this colour (paintOf). */
  paint?: [number, number, number];
}

/** A read that failed because the file isn't there (the game's words, see workbench/game.ts): for good. Any other
 *  failure (the storage busy, a file of the map that couldn't be read just now) may pass. */
const isMissing = (e: unknown) => /^not found: /.test(typeof e === "string" ? e : String((e as Error)?.message ?? e));

/** The centre and radius of a model-space box: the sphere an instance is picked and culled by. */
export function boxSphere(box: { min: readonly number[]; max: readonly number[] }): [number, number, number, number] {
  return [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2,
    Math.hypot(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]) / 2];
}

/** Textures a placed object takes instead of its type's: replaceable id → path, and the swap of an HD model's
 *  placeholder paths (a special doodad's cliff texture). `key` tells such looks of one model apart. */
export interface PlacedTextures {
  key: string;
  replaceable: Record<number, string>;
  retexture?: (path: string, slot?: string) => string;
}

/** `ObjectLoader.load`'s optional parts; each is described at `load`. */
export interface LoadOptions {
  baseOf?: (id: string) => string | undefined;
  heightOf?: (p: Placed, skin: Skin) => number;
  placeholders?: boolean;
  shownAs?: (p: Placed) => string | undefined;
  looksOf?: (p: Placed, skin: Skin) => readonly string[];
  texturesOf?: (p: Placed, skin: Skin) => PlacedTextures | undefined;
}

export interface LoadResult {
  batches: ObjectBatch[];
  /** Objects without a drawable model (start locations, unknown ids, load errors). */
  unresolved: Placed[];
  /** Selection stand-ins for the unresolved objects (not start locations). */
  strays: Stray[];
  /** Models that didn't load and ids without a model, with the placements concerned. */
  problems: LoadProblem[];
}

export interface LoadProblem { message: string; items: Placed[] }

/** Loads models for the terrain view. `readFile` reads map-imported files
 *  first; textures are shared between models. */
export class ObjectLoader {
  private textures = new Map<string, Promise<WebGLTexture | null>>();
  /** Textures that couldn't be read or decoded, with the reason. */
  readonly missing = new Map<string, string>();
  /** Counts the changes of `missing`: a list made from it is made again only when this moved on. */
  missingVersion = 0;
  /** Texture path (lower case) → model paths (lower case) that use it. */
  private textureUsers = new Map<string, Set<string>>();
  /** Models, textures and effects still loading. */
  private running = 0;

  /** Whether anything asked for is still loading: the view then draws less often (see the terrain viewer's tick). */
  get busy(): boolean { return this.running > 0; }

  private track<T>(load: Promise<T>): Promise<T> {
    this.running++;
    const done = () => { this.running--; };
    load.then(done, done);
    return load;
  }

  /** Forgets every loaded model and texture (and what was missing): files the map imports
   *  changed, so they're read again on the next load. */
  reset() {
    this.textures.clear();
    if (this.missing.size) this.missingVersion++;
    this.missing.clear();
    this.textureUsers.clear();
    this.models.clear();
    this.effectSources.clear();
  }

  /** Resolves when everything asked for so far has loaded. Models draw before their textures
   *  are there (white), and a model can ask for more while loading. */
  async settled() {
    let seen = -1;
    while (seen !== this.textures.size + this.models.size) {
      seen = this.textures.size + this.models.size;
      await Promise.allSettled([...this.textures.values(), ...this.models.values()]);
    }
    // Whoever waits for a texture takes it in a callback of its own.
    await new Promise((done) => setTimeout(done));
  }

  /** Model paths (lower case) that use a texture (as listed in `missing`). */
  modelsUsing(texture: string): Set<string> {
    return this.textureUsers.get(texture.toLowerCase()) ?? new Set();
  }

  constructor(private gl: WebGL2RenderingContext,
    private readFile: (path: string) => Promise<Uint8Array>, private onTexture: () => void) {}

  private texture(path: string, flags: number): Promise<WebGLTexture | null> {
    const key = `${path.toLowerCase()}|${flags}`;
    let t = this.textures.get(key);
    if (!t) {
      // Reforged models name .tif/.blp sources the game ships as .dds, and some (even the game's own DE
      // Goldmine) name an absolute path on the artist's machine: one rule for all views (texpath.ts).
      const variants = neverStoredLast(textureCandidates(path));
      let load!: Promise<WebGLTexture | null>;
      load = t = this.track((async () => {
        let error = "", again = false;
        for (const v of variants) {
          try {
            const bytes = await this.readFile(v).catch((e: unknown) => { again ||= !isMissing(e); throw e; });
            const tex = createTexture(this.gl, decodeImage(bytes, v), { repeat: [(flags & 1) !== 0, (flags & 2) !== 0] });
            if (this.missing.delete(path)) this.missingVersion++;
            this.onTexture();
            return tex;
          } catch (e) { error += `${error ? " | " : ""}${v}: ${(e as Error).message ?? e}`; }
        }
        this.missing.set(path, error);
        this.missingVersion++;
        // A read that failed for another reason than the file not being there is tried again by the next load.
        if (again && this.textures.get(key) === load) this.textures.delete(key);
        this.onTexture();
        return null;
      })());
      this.textures.set(key, t);
    }
    return t;
  }

  /** GPU models by path + replaceable textures, so re-planning (e.g. cliffs
   *  after an edit) doesn't load them again. */
  private models = new Map<string, Promise<ModelGpu>>();

  private effectSources = new Map<string, Promise<EffectSource | null>>();

  /** Particle effects of a model: its own emitters (PRE2), or for a Reforged model whose effects
   *  are PopcornFX (CORN, not drawn here) the emitters of the game's classic model of the same
   *  path, which keeps the classic models' scale and layout. */
  private effects(req: ModelRequest, gpu: ModelGpu): Promise<EffectSource | null> {
    const m = gpu.model;
    if (drawsParticles(m)) return Promise.resolve({ model: m, textures: gpu.textures, nodeWorld: gpu.nodeWorld, clock: gpu.poseClock, classic: false });
    if (!m.skipped.includes("CORN")) return Promise.resolve(null);
    const key = `${req.path.toLowerCase()}|${req.props ?? ""}`;
    let e = this.effectSources.get(key);
    if (!e) {
      e = this.track((async () => {
        let sd;
        try { sd = parseMdx(await this.readFile(`War3.w3mod:${req.path.replace(/\\/g, "/")}`)); } catch { return null; }
        if (!sd.particleEmitters2.length && !sd.ribbons.length) return null;
        const clock = standClock(sd, req.props);
        const textures: (WebGLTexture | null)[] = sd.textures.map(() => null);
        sd.textures.forEach((t, i) => {
          if (t.replaceableId === 0 && t.path) void this.texture(t.path, t.flags).then((tex) => { textures[i] = tex; });
        });
        return { model: sd, textures, nodeWorld: poseNodes(sd, clock), clock, classic: true };
      })());
      this.effectSources.set(key, e);
    }
    return e;
  }

  private model(req: ModelRequest): Promise<ModelGpu> {
    // The 3.0 art's stand-in (`reforged`) counts: EW00 and ET00 name one plain file and have different HD models.
    const key = `${req.path.toLowerCase()}|${req.reforged?.toLowerCase() ?? ""}|${JSON.stringify(req.replaceable)}|${req.props ?? ""}|${req.retextureKey ?? ""}`;
    let m = this.models.get(key);
    if (!m) {
      // A model that can't be read or parsed stays so (asked for again, it fails at once), except when a read failed
      // for another reason than the file not being there: that one is read again by the next load.
      let again = false;
      const read = (p: string) => this.readFile(p).catch((e: unknown) => { again ||= !isMissing(e); throw e; });
      const load = m = this.track((async () => {
        // The .mdx names first, then a model the map only has as MDL text (imported next to its object data).
        const model = await readModel([req.path, req.plain, req.reforged], read);
        const gpu = new ModelGpu(this.gl, model);
        // Stand still at the start of its "Stand" animation.
        gpu.props = req.props ?? [];
        gpu.pose(standClock(model, gpu.props));
        const drawn = drawnTextures(model);
        const slots = req.retexture ? hdSlots(model) : undefined;
        gpu.texturePaths(req.replaceable).forEach((p, i) => {
          if (!p || !drawn.has(i)) return;
          const tex = req.retexture?.(p, slots?.get(i)) ?? p;
          let users = this.textureUsers.get(tex.toLowerCase());
          if (!users) this.textureUsers.set(tex.toLowerCase(), (users = new Set()));
          users.add(req.path.toLowerCase());
          this.texture(tex, model.textures[i].flags).then((t) => { gpu.textures[i] = t; if (!t) gpu.unavailable.add(i); });
        });
        return gpu;
      })());
      this.models.set(key, m);
      load.catch(() => { if (again && this.models.get(key) === load) this.models.delete(key); });
    }
    return m;
  }

  /** The GPU model for a placed type (shared with the batches; for previews). */
  modelFor(skin: Skin, variation: number): Promise<ModelGpu> {
    const replaceable = skinTextures(skin);
    return this.model({ path: modelPath(skin, variation), plain: plainModelPath(skin), ...reforgedRequest(skin, variation), replaceable, props: skin.animProps, instances: [] });
  }

  /** Loads each requested model; failed ones are reported by index. The batches keep the order of
   *  the requests, whichever model loads first: see-through layers blend in drawing order. */
  async loadModels(group: string, requests: ModelRequest[]): Promise<{ batches: ObjectBatch[]; failed: { index: number; error: string }[] }> {
    const loaded: (ObjectBatch | undefined)[] = [], failed: { index: number; error: string }[] = [];
    await Promise.all(requests.map(async (req, index) => {
      try {
        const gpu = await this.model(req);
        const model = gpu.model;
        // Bounding sphere per instance, for picking and culling; the model's own is kept for when the object turns.
        const local = boxSphere(bounds(model));
        for (const inst of req.instances) {
          inst.bounds = local;
          inst.sphere = worldSphere(inst.world, local);
        }
        loaded[index] = { group, gpu, instances: req.instances, effects: await this.effects(req, gpu) ?? undefined, ...(req.paint ? { paint: req.paint } : {}) };
      } catch (e) {
        failed.push({ index, error: `${req.path}: ${(e as Error).message ?? e}` });
      }
    }));
    failed.sort((a, b) => a.index - b.index);
    return { batches: loaded.filter((b): b is ObjectBatch => b !== undefined), failed };
  }

  private placeholderGpu: ModelGpu | null = null;

  /** The World Editor's checkered cube (placeholder.ts), made once. */
  private placeholder(): ModelGpu {
    if (!this.placeholderGpu) {
      // Kept only once whole: a context lost on the way throws, and the next load tries again.
      const gpu = new ModelGpu(this.gl, placeholderModel());
      gpu.pose(standClock(gpu.model));
      gpu.textures[0] = createTexture(this.gl, placeholderImage(), { repeat: [false, false] });
      this.placeholderGpu = gpu;
    }
    return this.placeholderGpu;
  }

  /** Placed doodads/units: models from the skin tables. Custom object ids
   *  use their base object's model (`baseOf`, from the map's object data). An object whose model doesn't load
   *  (or whose id is unknown) is drawn as the World Editor's checkered cube, a batch of its own in the group, and
   *  selected like any other; without `placeholders` (the start buildings' previews) it's only a stray.
   *  `looksOf`: looks a placed object stands in besides its type's Animprops (a swimming unit's "swim").
   *  `texturesOf`: textures a placed object takes instead of its type's (a special doodad's cliff texture). */
  async load(group: string, placed: Placed[], skins: Map<string, Skin>, teamOf: (p: Placed) => number,
    { baseOf = () => undefined, heightOf, placeholders = true, shownAs, looksOf, texturesOf }: LoadOptions = {}): Promise<LoadResult> {
    const byModel = new Map<string, { req: ModelRequest; items: Placed[] }>();
    const unresolved: Placed[] = [];
    // Ids without a model (start locations have none on purpose).
    const unknown = new Map<string, Placed[]>();
    // `shownAs`: drawn as another type (Cycle Random Groups shows a group's unit), its own when that has no model.
    const skinFor = (id: string) => skins.get(id) ?? skins.get(baseOf(id) ?? "");
    for (const [index, p] of placed.entries()) {
      const other = shownAs?.(p);
      const skin = (other !== undefined ? skinFor(other) : undefined) ?? skinFor(p.id);
      if (!skin) {
        unresolved.push(p);
        if (p.id !== "sloc") { const same = unknown.get(p.id); if (same) same.push(p); else unknown.set(p.id, [p]); }
        continue;
      }
      const path = modelPath(skin, p.variation);
      const more = looksOf?.(p, skin).filter((l) => !skin.animProps?.includes(l)) ?? [];
      const props = more.length ? [...(skin.animProps ?? []), ...more] : skin.animProps;
      const own = texturesOf?.(p, skin);
      const paint = paintOf(skin);
      const key = `${path}|${reforgedModelPath(skin, p.variation) ?? ""}|${own ? `=${own.key}` : skin.texFile}|${props ?? ""}|${paint ?? ""}`;
      let entry = byModel.get(key);
      if (!entry) {
        const replaceable = own?.replaceable ?? skinTextures(skin);
        entry = { req: { path, plain: plainModelPath(skin), ...reforgedRequest(skin, p.variation), replaceable, props, instances: [], ...(paint ? { paint } : {}), ...(own?.retexture ? { retexture: own.retexture, retextureKey: own.key } : {}) }, items: [] };
        byModel.set(key, entry);
      }
      entry.items.push(p);
      const range = scaleRange(skin);
      entry.req.instances.push({
        world: placement(p, skin.modelScale, heightOf?.(p, skin), range), team: drawnTeam(skin, teamOf(p), (p as Placed & { color?: number }).color),
        pick: { kind: skin.kind, id: p.id, base: skins.has(p.id) ? undefined : baseOf(p.id), index, placed: p, model: path, extraScale: skin.modelScale, ...(range ? { scaleRange: range } : {}) },
      });
    }
    const entries = [...byModel.values()];
    const { batches, failed } = await this.loadModels(group, entries.map((e) => e.req));
    for (const f of failed) unresolved.push(...entries[f.index].items);
    const problems: LoadProblem[] = [
      ...failed.map((f) => ({ message: f.error, items: entries[f.index].items })),
      ...[...unknown].map(([id, items]) => ({ message: `${id}: unknown object (no model; not in the game's or the map's object data)`, items })),
    ];
    const helpers = await this.clickHelpers(group, batches, (inst) => !!inst.pick && !!skinFor(inst.pick.id)?.clickHelper);
    if (helpers) batches.push(helpers);
    const strays = strayInstances(group, placed, unresolved, skins, teamOf, baseOf, heightOf);
    // A start location stays a marker and a stray (the game view leaves it out): no cube for it.
    const starts = strays.filter((s) => s.inst.pick?.id === "sloc"), cubed = strays.filter((s) => s.inst.pick?.id !== "sloc");
    if (!placeholders || !cubed.length) return { batches, unresolved, strays, problems };
    let gpu: ModelGpu;
    // A lost context can't compile the model shader: the objects stay markers (the view is reopened anyway).
    try { gpu = this.placeholder(); } catch { return { batches, unresolved, strays, problems }; }
    const instances = placeholderInstances(cubed, bounds(gpu.model));
    const cubes = new Set(instances.map((inst) => inst.pick?.placed));
    return { batches: [...batches, { group, gpu, instances }], unresolved: unresolved.filter((p) => !cubes.has(p)), strays: starts, problems };
  }

  /** The click helpers (CLICK_HELPER) of the batches' instances that `wanted` says have one: a batch of their own,
   *  see-through and only in the editor's view, each following its doodad. Null when there are none, or the cube's
   *  model doesn't load (then the doodads are drawn without; it isn't one of theirs that failed). */
  private async clickHelpers(group: string, batches: readonly ObjectBatch[], wanted: (inst: ObjectInstance) => boolean): Promise<ObjectBatch | null> {
    const owners = batches.flatMap((b) => b.instances.filter(wanted));
    if (!owners.length) return null;
    let gpu: ModelGpu;
    try { gpu = await this.model({ path: CLICK_HELPER.model, replaceable: {}, instances: [] }); } catch { return null; }
    const local = boxSphere(bounds(gpu.model));
    const instances = owners.map((owner): ObjectInstance => {
      const follows = { owner, local: clickHelperLocal(owner) };
      const world = mat4.mul(owner.world, follows.local);
      return { world, team: owner.team, bounds: local, sphere: worldSphere(world, local), follows };
    });
    return { group, gpu, instances, tint: [...CLICK_HELPER.tint], editorOnly: true };
  }
}

/** Where a doodad's click helper stands in the doodad's own space (its world matrix times this): CLICK_HELPER.scale. */
export function clickHelperLocal(_owner: ObjectInstance): Mat4 {
  const s = CLICK_HELPER.scale;
  return new Float32Array([s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, 0, 0, 0, 1]);
}

/** The strays as instances of the placeholder cube: picked and culled by the cube's bounds (`box`, model space). */
export function placeholderInstances(strays: readonly Stray[], box: { min: readonly number[]; max: readonly number[] }): ObjectInstance[] {
  const local = boxSphere(box);
  return strays.map(({ inst }) => ({ ...inst, bounds: local, sphere: worldSphere(inst.world, local) }));
}

/** A placed object without a model (an unknown id, a model that didn't load). Only a marker
 *  shows it, so selection works on this stand-in instance: its position and a small sphere. */
export interface Stray { group: string; inst: ObjectInstance }

/** Stand-ins for the unresolved objects of one group, start locations too: a click, a box and Select All take them
 *  (the game view leaves them out, see shownInstances in index.ts). */
/**
 * The kind of a war3mapUnits.doo entry: its type's when known (`known`: "w3t" an item, any other a unit), else what the
 * record tells. The World Editor writes an item with hero level 0 and target acquisition 0, a unit with level 1 or more
 * and target acquisition -1 (normal), -2 (camp) or its own range: so in all 281 placed items and 9,506 units of 58 maps
 * (the game's campaigns and scenarios, melee maps; 2026-11-12), custom items of the map (I000, I003) too. A record with other
 * values (Studio's own placing of a known type, a hand-made file) stays a unit, as before.
 */
export function unitsEntryKind(p: Placed & { level?: unknown; targetAcquisition?: unknown }, known?: string): "w3u" | "w3t" {
  if (known !== undefined) return known === "w3t" ? "w3t" : "w3u";
  return p.id !== "sloc" && p.level === 0 && p.targetAcquisition === 0 ? "w3t" : "w3u";
}

export function strayInstances(group: string, placed: readonly Placed[], unresolved: readonly Placed[], skins: Map<string, Skin>,
  teamOf: (p: Placed) => number, baseOf: (id: string) => string | undefined = () => undefined, heightOf?: (p: Placed, skin: Skin) => number): Stray[] {
  const index = new Map(placed.map((p, i) => [p, i]));
  return unresolved.map((p) => {
    const skin = skins.get(p.id) ?? skins.get(baseOf(p.id) ?? "");
    // A known type whose model didn't load stands where its model would (a ship on the water).
    const [x, y] = p.position, z = skin && heightOf ? heightOf(p, skin) : p.position[2];
    return {
      group,
      inst: {
        world: placement(p, 1, z), team: teamOf(p), sphere: [x, y, z, 32] as [number, number, number, number],
        pick: { kind: skin?.kind ?? (group === "doodads" ? "w3d" : unitsEntryKind(p)), id: p.id, base: skins.has(p.id) ? undefined : baseOf(p.id), index: index.get(p) ?? -1, placed: p, model: "", extraScale: 1 },
      },
    };
  });
}

/** Every doodad and unit of the groups not hidden, start locations among them: what Select All takes. */
export function selectableObjects(sources: Iterable<Stray>, hidden: ReadonlySet<string>): { p: Placed; kind: string; id: string }[] {
  const out: { p: Placed; kind: string; id: string }[] = [];
  for (const { group, inst } of sources) {
    if ((group !== "doodads" && group !== "units") || hidden.has(group)) continue;
    if (inst.pick) out.push({ p: inst.pick.placed, kind: inst.pick.kind, id: inst.pick.id });
  }
  return out;
}

/** The placed objects whose position projects into a rectangle of the canvas (CSS pixels), among
 *  the doodads and units not hidden, of the kinds wanted. */
export function objectsInRect(sources: Iterable<Stray>, project: (position: [number, number, number]) => [number, number] | null | undefined,
  hidden: ReadonlySet<string>, kinds: ReadonlySet<string>, x0: number, y0: number, x1: number, y1: number): Placed[] {
  const [ax, bx] = [Math.min(x0, x1), Math.max(x0, x1)], [ay, by] = [Math.min(y0, y1), Math.max(y0, y1)];
  const out: Placed[] = [];
  for (const { group, inst } of sources) {
    if ((group !== "doodads" && group !== "units") || hidden.has(group)) continue;
    if (!inst.pick || !kinds.has(inst.pick.kind)) continue;
    // Where it's drawn: a ship sits on the water, above its stored height.
    const s = project([inst.world[12], inst.world[13], inst.world[14]]);
    if (s && s[0] >= ax && s[0] <= bx && s[1] >= ay && s[1] <= by) out.push(inst.pick.placed);
  }
  return out;
}
