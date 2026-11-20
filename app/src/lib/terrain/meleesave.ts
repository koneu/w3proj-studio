// The Melee flag (war3map.w3i) as a save leaves it. Every path that writes placed units, the map's info, its gameplay
// constants or its ground comes through here: the terrain editor's save, the MCP object tools, and the map script's
// run after a save (also with script.generateOnSave off, and on vJASS maps). The rules are owner.ts meleeBlockers;
// this gathers what they need beyond war3map.w3i and the placed units.
//
// The World Editor's save also puts the flag back on a map that meets its rules. Studio does that only when it can
// tell every one of them (meleeSetBlockers): what it can't decide (custom triggers beyond the plain default, start
// locations whose surroundings it can't read: startsPlainlyValid) leaves the flag as it is. It takes the flag off for a
// start location only when it is surely invalid (startsSurelyInvalid).
//
// The same saves set or clear flag 0x4000, Requires The Frozen Throne data, by the placed units and items (tftflag.ts):
// and flag 0x0008 by the terrain's custom tilesets flag (tilesetflag.ts): the flags these functions give can differ
// from the old ones in those bits alone.

import type { W3Api } from "../../extensions/api";
import { readIni } from "../formats/iniedit";
import { parseSlk } from "../formats/text";
import { hasCustomTriggers, isDefaultTriggers, NotDefaultFunction, parseWtgWithoutArgs } from "../triggers/defaults";
import { parseWtgJson, wtgPath } from "../triggers/wtg";
import { meleeBlockers, MELEE_MAP, hasCustomConstants, type MeleeInfo } from "./owner";
import { decodeImage, type Mip } from "../image/index.ts";
import { generatePathing, NO_BUILD, NO_WALK, type PathingStamp, type TileRule } from "./pathing";
import { mapEdgeTiles, parseW3e, parseWaterOffsets, waterSurfaceAt, type Terrain } from "./w3e";
import { ownGroundTiles } from "./tilesets";
import { readTerrainBytes, terrainPath } from "./w3etext";
import { placedNeedTft, tftFlagsAfter, typeVersions } from "./tftflag";
import { tilesetFlagAfter } from "./tilesetflag";

interface PlacedLike { id: string; player?: number; position?: readonly number[] }

/** The map's gameplay constants. */
export const MISC_TXT = "map/war3mapMisc.txt";

/** Files of the World Editor's other reasons: custom unit, item, destructible, doodad, ability, buff and upgrade data
 *  (WESTRING_NOTMELEE_CUSTOMUNITS … CUSTOMUPGRADEDATA) and a custom game interface (CUSTOMSKINDATA). Only a file that
 *  changes something counts (customDataState): an empty one (no objects, no values) is the default. The object data's
 *  skin files (war3mapSkin.w3u …) count as the object data does: BanewoodBog's war3mapSkin.w3d holds one entry without
 *  values, and the editor's save takes the flag off (we-compare corpus-saves-melee-banewoodbog). */
const CUSTOM_DATA = /^map\/(war3map(Skin)?\.(w3u|w3t|w3b|w3d|w3a|w3h|w3q)(\.json)?|war3mapSkin\.txt)$/i;

/** Whether a custom-data file changes anything: false for no entry (JSON objects: `original` and `custom` empty or
 *  absent; the raw w3u family: the header's two counts 0; war3mapSkin.txt: no value in any section); null when it can't
 *  be told (unreadable, malformed, another layout). */
export function customFileChanges(path: string, content: string | Uint8Array): boolean | null {
  try {
    if (typeof content !== "string") {
      if (/\.json$/i.test(path) || /\.txt$/i.test(path)) return null;
      if (content.length < 12) return null;
      const v = new DataView(content.buffer, content.byteOffset, content.byteLength);
      return content.length === 12 && v.getUint32(4, true) === 0 && v.getUint32(8, true) === 0 ? false : true;
    }
    if (/\.txt$/i.test(path)) return [...readIni(content).values()].some((section) => section.size > 0);
    const doc = JSON.parse(content) as { original?: unknown; custom?: unknown } | null;
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) return null;
    let any = false;
    for (const list of [doc.original, doc.custom]) {
      if (list === undefined) continue;
      if (!Array.isArray(list)) return null;
      if (list.length) any = true;
    }
    return any;
  } catch { return null; }
}

/** Whether the project's custom object data and interface files change anything: true when one does, false when
 *  none is there or all are empty, null when one can't be told and none is known to change something. */
export async function customDataState(ws: MeleeFiles, files: readonly string[]): Promise<boolean | null> {
  let unknown = false;
  for (const path of files.filter((p) => CUSTOM_DATA.test(p))) {
    let r: boolean | null;
    try {
      r = customFileChanges(path, /\.(json|txt)$/i.test(path) ? await ws.readText(path) : await ws.readBytes(path));
    } catch { r = null; }
    if (r) return true;
    if (r === null) unknown = true;
  }
  return unknown ? null : false;
}

/** What the object data says about flag 0x4000 (Requires The Frozen Throne data). Measured with we-compare
 *  corpus-saves (2026-11-20, flat.w3x and (12)WormWar with one kind of object data each): ability, buff or upgrade data
 *  (war3map.w3a, .w3h, .w3q), custom or a change to an original, makes the editor's save set the flag, as Reign of
 *  Chaos had none of them; unit, item, destructable and doodad data (custom units based on Ucrl and hfoo included)
 *  and a custom game interface (WormWar's war3mapSkin.txt) let it clear the flag. `need`: true when one of
 *  war3map.w3a/.w3h/.w3q changes something, false when none of those nor their skin files does, null when that can't
 *  be told (a file unreadable, a skin file of those kinds with entries: not measured). `mayClear`: nothing but unit,
 *  item, destructable and doodad data (and their skin files) and war3mapSkin.txt changes something, every file read. */
export async function objectDataTft(ws: MeleeFiles, files: readonly string[]): Promise<{ need: boolean | null; mayClear: boolean }> {
  let need: boolean | null = false, mayClear = true;
  for (const path of files.filter((p) => CUSTOM_DATA.test(p))) {
    let r: boolean | null;
    try {
      r = customFileChanges(path, /\.(json|txt)$/i.test(path) ? await ws.readText(path) : await ws.readBytes(path));
    } catch { r = null; }
    if (r === false) continue;
    const m = /war3map(Skin)?\.(w3[a-z])/i.exec(path);
    const tftKind = !!m && /^w3[ahq]$/i.test(m[2]);
    if (tftKind && r === true && !m![1]) need = true;
    else if (tftKind && need !== true) need = null;
    // Unit, item, destructable and doodad data and war3mapSkin.txt that are read let the flag clear; the rest holds it.
    if (r === null || tftKind) mayClear = false;
  }
  return { need, mayClear };
}

/** Half the side, in pathing cells (32), of the square the World Editor's save fits on each start location (a town
 *  hall's 16 × 16): a start is in an invalid position when a cell of that square isn't buildable (the ground's pathing
 *  with doodads and destructables stamped in), or when it overlaps another start's square. The square stands on the
 *  cell grid, its centre the start rounded to the nearest 32. Measured with we-drive saves of flat 64 × 64 maps
 *  (2026-11-16, tests/we-compare/melee-valid-we.json): a tree (snapped to 64) 256 from the start along an axis or at
 *  (256, 256) made it invalid, 320 or (320, 256) not; Lrok, a cliff or shallow water whose unbuildable cells began 192
 *  or 128 from it invalid, 320 not; another start 488 away invalid, 496, 504, 512 and (512, 480) not. Not reasons:
 *  blight next to it, a tavern or goblin merchant standing on it, an item 64 away. */
export const START_SQUARE = 8;
/** A gold mine whose centre is nearer to a start location than this makes it invalid (we-drive 2026-11-16: 749 and
 *  (528, 528) were, 750 and (530.5, 530.5) not). Haunted and entangled mines count alike (not measured). */
export const MINE_CLEARANCE = 750;
const MINES = new Set(["ngol", "ugol", "egol"]);

/** Whether a start location stands under water: one of the World Editor's "start locations in invalid positions"
 *  (World Editor 7003's new maps on shallow or deep water, we-drive 2026-11-11). The others (startsSurelyInvalid) need
 *  the game's pathing textures: without them only this and startsPastPlayable take the flag off. */
export function startsUnderWater(t: Terrain, placed: readonly PlacedLike[]): boolean {
  return placed.some((p) => p.id === "sloc" && Array.isArray(p.position) && p.position.length >= 2
    && Number.isFinite(p.position[0]) && Number.isFinite(p.position[1]) && waterSurfaceAt(t, p.position[0], p.position[1]) !== null);
}

/** Whether a start location stands on a tile past the playable map (the terrain's map-edge marks, which the saves
 *  write from the w3i's camera complements): one of the World Editor's "start locations in invalid positions" (we-drive
 *  2026-11-14: a 64 × 64 map cut by 32 at the top kept its start 768 past the playable edge and its save took Melee
 *  off). A start on the playable edge itself is inside (as inArea); one off the map is past. */
export function startsPastPlayable(t: Terrain, placed: readonly PlacedLike[]): boolean {
  const edge = mapEdgeTiles(t), tilesX = t.width - 1, tilesY = t.height - 1;
  const marked = (x: number, y: number) => x < 0 || y < 0 || x >= tilesX || y >= tilesY || edge[y * tilesX + x] === 1;
  // The tiles a point touches along one axis: one, or the two it lies between.
  const touching = (f: number) => (Number.isInteger(f) ? [f - 1, f] : [Math.floor(f)]);
  return placed.some((p) => {
    if (p.id !== "sloc" || !Array.isArray(p.position) || p.position.length < 2 || !Number.isFinite(p.position[0]) || !Number.isFinite(p.position[1])) return false;
    const fx = (p.position[0] - t.offsetX) / 128, fy = (p.position[1] - t.offsetY) / 128;
    return touching(fx).every((x) => touching(fy).every((y) => marked(x, y)));
  });
}

/** Under water or past the playable map: the start-location reasons Studio can tell. */
export const startsInvalidPlaces = (t: Terrain, placed: readonly PlacedLike[]) => startsUnderWater(t, placed) || startsPastPlayable(t, placed);

/** What stands around the start locations, besides the placed units. */
export interface StartSurroundings {
  /** The ground's pathing with every doodad and destructable that has a pathing texture stamped in (startPathing). */
  pathing: Uint8Array;
  /** Where doodads stand whose pathing can't be told (a type the game's tables don't have, a texture that can't be
   *  read: the tables name PathTextures\16x12Default.tga, which the game doesn't have): a start within UNKNOWN_REACH
   *  of one isn't plainly valid. */
  unknown?: readonly { x: number; y: number }[];
}

/** How far (along each axis) a doodad of unknown pathing can be from a start and still touch its square: the square's
 *  half side and half of the largest pathing texture (the game's go up to 24 × 24 cells), 32 cells. */
export const UNKNOWN_REACH = (START_SQUARE + 16) * 32;

/** What makes a pathing cell unfit for the start's square: not buildable, or (not measured alone, so counted) not
 *  walkable. Blight isn't (we-drive 2026-11-16: blight from 192 away kept the flag). */
const NOT_FOR_A_HALL = NO_BUILD | NO_WALK;

/**
 * The pathing the World Editor's save tests the start locations' squares against: the ground's (pathing.ts
 * generatePathing, with the tiles past the playable map blocked by the terrain's map-edge marks) with `stamps` ored in.
 * Unlike war3map.wpm the stamps include destructables (trees count) and doodads whatever their flags. In the layout of
 * war3map.wpm (16 bytes of header, then a byte per 32 × 32 cell from the bottom left).
 */
export function startPathing(t: Terrain, tileRules: Map<string, TileRule>, stamps: PathingStamp[] = [], opts: { ownTiles?: readonly string[]; waterOffset?: number } = {}): Uint8Array {
  const wpm = generatePathing({ terrain: t, margins: [0, 0, 0, 0], tileRules, stamps, ownTiles: opts.ownTiles, waterOffset: opts.waterOffset });
  const edge = mapEdgeTiles(t), tilesX = t.width - 1, w = tilesX * 4, h = (t.height - 1) * 4, cells = wpm.subarray(16);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (edge[(y >> 2) * tilesX + (x >> 2)]) cells[y * w + x] |= NO_BUILD | NO_WALK;
  return wpm;
}

/**
 * Whether every start location stands where the World Editor's save takes it as valid (START_SQUARE, MINE_CLEARANCE):
 * its square on the map, every cell of it fit for a town hall in `around.pathing`, no other start's square overlapping
 * it, and no gold mine nearer than MINE_CLEARANCE. Other units (buildings, creeps) and items don't count. False for
 * anything less, including a map without starts or a placed object without a position: then Studio can't tell, which
 * is not the same as invalid.
 */
export function startsPlainlyValid(t: Terrain, placed: readonly PlacedLike[], around: StartSurroundings): boolean {
  return startsJudged(t, placed, around) === "valid";
}

/**
 * Whether a start location is surely in an invalid position by what the World Editor's save measured: another start's
 * square overlapping its own, a gold mine nearer than MINE_CLEARANCE, its square past the map, or a cell of it not
 * buildable in `around.pathing`. What can't be told (a doodad of unknown pathing near it, a cell only unwalkable, a
 * placed object without a position, a pathing map of another size) is not a reason: then it is false, which is not
 * the same as valid. Measured with we-drive 2026-11-17 (melee-valid-melee-tree-256): a tree 256 from the start of a
 * melee map takes the flag off at the save.
 */
export function startsSurelyInvalid(t: Terrain, placed: readonly PlacedLike[], around: StartSurroundings): boolean {
  return startsJudged(t, placed, around) === "invalid";
}

const placedPos = (p: PlacedLike) => (Array.isArray(p.position) && p.position.length >= 2 && Number.isFinite(p.position[0]) && Number.isFinite(p.position[1]) ? p.position : null);

/** startsPlainlyValid and startsSurelyInvalid: "invalid" when a start surely is, "valid" when every start surely
 *  isn't, else "unknown". */
function startsJudged(t: Terrain, placed: readonly PlacedLike[], around: StartSurroundings): "valid" | "invalid" | "unknown" {
  const starts = placed.filter((p) => p.id === "sloc" && placedPos(p));
  const unplaced = placed.some((p) => !placedPos(p));
  const w = (t.width - 1) * 4, h = (t.height - 1) * 4;
  const cells = around.pathing.subarray(16);
  const sized = cells.length === w * h;
  const cellOf = (p: PlacedLike) => [Math.round((placedPos(p)![0] - t.offsetX) / 32), Math.round((placedPos(p)![1] - t.offsetY) / 32)];
  const mines = placed.filter((p) => MINES.has(p.id) && placedPos(p));
  const S = START_SQUARE;
  let unknown = unplaced || !starts.length || !sized;
  for (const s of starts) {
    const [cx, cy] = cellOf(s), [sx, sy] = placedPos(s)!;
    if (starts.some((o) => o !== s && Math.max(Math.abs(cellOf(o)[0] - cx), Math.abs(cellOf(o)[1] - cy)) < 2 * S)) return "invalid";
    if (mines.some((m) => Math.hypot(placedPos(m)![0] - sx, placedPos(m)![1] - sy) < MINE_CLEARANCE)) return "invalid";
    if (cx - S < 0 || cy - S < 0 || cx + S > w || cy + S > h) return "invalid";
    if (around.unknown?.some((d) => Math.max(Math.abs(d.x - sx), Math.abs(d.y - sy)) < UNKNOWN_REACH)) unknown = true;
    if (!sized) continue;
    for (let y = cy - S; y < cy + S; y++) for (let x = cx - S; x < cx + S; x++) {
      const c = cells[y * w + x];
      if (c & NO_BUILD) return "invalid";
      if (c & NOT_FOR_A_HALL) unknown = true;
    }
  }
  return unknown ? "unknown" : "valid";
}

/**
 * Where a start location goes that Map Size took off the map: the place on the 64 grid nearest to `from` where it is
 * plainly valid by startsPlainlyValid's rules (its square inside the map and every cell of it fit for a town hall in
 * `around.pathing`, which blocks the tiles past the playable map, no start of `others` overlapping it, no gold mine of
 * `others` nearer than MINE_CLEARANCE, no doodad of unknown pathing within reach). The World Editor's save makes the
 * new one at a random place among such (we-drive 2026-11-19, branch we-compare-18: twelve saves of a 64 x 64 map cut
 * by 8 on the right, all on the 64 grid; with all but a 12 x 12 tile patch under shallow water all four landed on it,
 * with all but a strip along the west edge all four in the strip, one 64 outside the camera bounds, none with its
 * square past the playable edge). Null when there is none, or `around` doesn't fit the terrain.
 */
export function validStartPlace(t: Terrain, from: readonly [number, number], others: readonly PlacedLike[], around: StartSurroundings): [number, number] | null {
  const w = (t.width - 1) * 4, h = (t.height - 1) * 4, cells = around.pathing.subarray(16);
  if (cells.length !== w * h || !Number.isFinite(from[0]) || !Number.isFinite(from[1])) return null;
  // Cells unfit for a hall, summed: a square's count in four lookups.
  const sum = new Int32Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      if (cells[y * w + x] & NOT_FOR_A_HALL) row++;
      sum[(y + 1) * (w + 1) + x + 1] = sum[y * (w + 1) + x + 1] + row;
    }
  }
  const S = START_SQUARE;
  const cellAt = (x: number, y: number) => [Math.round((x - t.offsetX) / 32), Math.round((y - t.offsetY) / 32)];
  const starts = others.filter((p) => p.id === "sloc" && placedPos(p)).map((p) => cellAt(placedPos(p)![0], placedPos(p)![1]));
  const mines = others.filter((p) => MINES.has(p.id) && placedPos(p)).map((p) => placedPos(p)!);
  let best: [number, number] | null = null, bestD = Infinity;
  const x0 = Math.ceil(t.offsetX / 64), x1 = Math.floor((t.offsetX + (t.width - 1) * 128) / 64);
  const y0 = Math.ceil(t.offsetY / 64), y1 = Math.floor((t.offsetY + (t.height - 1) * 128) / 64);
  for (let gy = y0; gy <= y1; gy++) for (let gx = x0; gx <= x1; gx++) {
    const x = gx * 64, y = gy * 64, d = Math.hypot(x - from[0], y - from[1]);
    if (d >= bestD) continue;
    const [cx, cy] = cellAt(x, y);
    if (cx - S < 0 || cy - S < 0 || cx + S > w || cy + S > h) continue;
    const bad = sum[(cy + S) * (w + 1) + cx + S] - sum[(cy - S) * (w + 1) + cx + S] - sum[(cy + S) * (w + 1) + cx - S] + sum[(cy - S) * (w + 1) + cx - S];
    if (bad) continue;
    if (starts.some(([ox, oy]) => Math.max(Math.abs(ox - cx), Math.abs(oy - cy)) < 2 * S)) continue;
    if (mines.some(([mx, my]) => Math.hypot(mx - x, my - y) < MINE_CLEARANCE)) continue;
    if (around.unknown?.some((u) => Math.max(Math.abs(u.x - x), Math.abs(u.y - y)) < UNKNOWN_REACH)) continue;
    best = [x, y]; bestD = d;
  }
  return best;
}

/** What of a project the melee rules read. `gameText`: the game's tables (Terrain.slk, Water.slk, Doodads.slk,
 *  DestructableData.slk); `gameBytes`: its files (the doodads' pathing textures). Without them the flag is never put
 *  back. */
export interface MeleeFiles {
  files(): readonly { path: string }[];
  readText(path: string): Promise<string>;
  readBytes(path: string): Promise<Uint8Array>;
  gameText?(path: string): Promise<string>;
  gameBytes?(path: string): Promise<Uint8Array>;
  /** readTypeVersions of gameText, kept between calls (meleeFiles keeps it per game). */
  typeVersions?(): Promise<Map<string, number> | null>;
}

/** readTypeVersions per game: UnitData.slk is parsed once, not on every save (a campaign's import saves each chapter).
 *  A result that isn't known (null) isn't kept, so the next call reads again. */
const versionsByGame = new WeakMap<object, Promise<Map<string, number> | null>>();

/** The project and the game of the app, as the melee rules read them. */
export function meleeFiles(w3: Pick<W3Api, "workspace" | "game">): MeleeFiles {
  return {
    files: () => w3.workspace.files(),
    readText: (p) => w3.workspace.readText(p),
    readBytes: (p) => w3.workspace.readBytes(p),
    gameText: (p) => w3.game.readText(p),
    gameBytes: (p) => w3.game.read(p, { shared: true }),
    typeVersions: () => {
      let got = versionsByGame.get(w3.game);
      if (!got) {
        got = readTypeVersions({ gameText: (p) => w3.game.readText(p) });
        versionsByGame.set(w3.game, got);
        void got.then((v) => { if (!v && versionsByGame.get(w3.game) === got) versionsByGame.delete(w3.game); });
      }
      return got;
    },
  };
}

/** What the rules need besides war3map.w3i and the placed units. The optional part is what putting the flag back
 *  needs (read with readMeleeFacts' `forSet`); absent or null means not known, which leaves the flag as it is. */
export interface MeleeFacts {
  /** war3mapMisc.txt sets a gameplay constant. */
  customConstants: boolean;
  /** The game's unit and item types → their table version (tftflag.ts), for flag 0x4000; absent or null: not known,
   *  which leaves that flag as it is. */
  typeVersions?: ReadonlyMap<string, number> | null;
  /** There is no trigger file, or it was read (customTriggers then tells). Unset: unreadable. */
  triggersKnown?: boolean;
  /** The ground the start locations stand on; null when unknown. */
  terrain: Terrain | null;
  /** war3mapMisc.txt is missing or was read (not there but unreadable). */
  constantsKnown?: boolean;
  /** The trigger file is there, readable, and only the default (isDefaultTriggers). */
  defaultTriggers?: boolean;
  /** The trigger file is there and parsed, and the World Editor counts it as custom triggers (hasCustomTriggers). Not
   *  read, missing or unreadable: not set, which keeps the flag. */
  customTriggers?: boolean;
  /** A file of custom object data or game interface changes something (customDataState); null: not known. */
  customData?: boolean | null;
  /** What the object data says about flag 0x4000 (objectDataTft); absent: not read, which leaves the flag as it is. */
  tftData?: { need: boolean | null; mayClear: boolean };
  /** war3map.doo's entries, whose drop sets count for flag 0x4000 (readDoodadEntries): [] without a doodad file; null
   *  when it can't be read; absent: not read. Either of the last two leaves the flag as it is unless something sets it. */
  doodads?: readonly PlacedLike[] | null;
  /** What stands around the start locations: the pathing their squares are tested against. Not read (absent) when
   *  another reason decides; null when it can't be read. */
  around?: StartSurroundings | null;
}

const noTexture = (tex: string | undefined) => tex === undefined || tex === "" || tex === "_" || tex === "-" || tex.toLowerCase() === "none";

/**
 * The pathing stamps of war3map.doo.json's doodads, destructables and special doodads (caves, collapsed cliffs), as
 * buildPathingMap places them, and where doodads stand whose pathing can't be told (a type the game's tables, `pathTex`:
 * id → its pathing texture, "" for none, don't have; a texture that can't be read). Null for what leaves the whole file
 * unknown: not a doodad file (raw, unreadable, malformed), a doodad without a position, a special doodad of unknown
 * pathing.
 */
async function doodadStamps(text: string | null, t: Terrain, pathTex: ReadonlyMap<string, string>, texture: (path: string) => Promise<Mip | null>): Promise<{ stamps: PathingStamp[]; unknown: { x: number; y: number }[] } | null> {
  if (text === null) return null;
  let doc: { doodads?: unknown; specials?: unknown };
  try { doc = JSON.parse(text) as typeof doc; } catch { return null; }
  if (!doc || !Array.isArray(doc.doodads) || (doc.specials !== undefined && !Array.isArray(doc.specials))) return null;
  const out: PathingStamp[] = [], unknown: { x: number; y: number }[] = [];
  for (const d of doc.doodads as { id?: unknown; position?: unknown; angle?: unknown }[]) {
    const p = d?.position, tex = typeof d?.id === "string" ? pathTex.get(d.id) : undefined;
    if (!Array.isArray(p) || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) return null;
    if (tex === "") continue;
    const image = tex === undefined ? null : await texture(tex);
    if (!image) { unknown.push({ x: p[0], y: p[1] }); continue; }
    out.push({ x: p[0], y: p[1], angle: Number.isFinite(d.angle) ? (d.angle as number) : 0, width: image.width, height: image.height, rgba: image.rgba });
  }
  for (const s of (doc.specials ?? []) as { id?: unknown; x?: unknown; y?: unknown }[]) {
    const tex = typeof s?.id === "string" ? pathTex.get(s.id) : undefined;
    if (!Number.isFinite(s?.x) || !Number.isFinite(s?.y) || tex === undefined) return null;
    if (tex === "") continue;
    const image = await texture(tex);
    if (!image) return null;
    // Placed by tile: the texture's bottom left on that tile's, unturned (buildPathingMap).
    out.push({ x: t.offsetX + (s.x as number) * 128 + image.width * 16, y: t.offsetY + (s.y as number) * 128 + image.height * 16,
      angle: -Math.PI / 2, width: image.width, height: image.height, rgba: image.rgba, cliffDoodad: true });
  }
  return { stamps: out, unknown };
}

/**
 * Reads the facts from the project. `terrain`: the ground being saved (else the project's saved one is read).
 * Missing files set nothing. A file that is there but can't be read or parsed sets nothing either, and that is safe
 * because not knowing keeps the flag as it is: it never reads as "constants set", "a start under water" or "something
 * near the starts", nor, with `forSet`, as "no constants", "default triggers" or "nothing near the starts". The starts'
 * surroundings (the game's tables, the doodads, their pathing textures) are read unless another reason decides.
 */
export async function readMeleeFacts(ws: MeleeFiles, terrain?: Terrain | null, forSet = false): Promise<MeleeFacts> {
  const files = ws.files().map((f) => f.path);
  const find = (want: string) => files.find((p) => p.toLowerCase() === want.toLowerCase());
  const miscPath = find(MISC_TXT);
  const misc = miscPath ? await ws.readText(miscPath).catch(() => null) : null;
  const ground = terrain !== undefined ? terrain : await readGround(ws, files);
  const facts: MeleeFacts = { customConstants: misc !== null && hasCustomConstants(misc), terrain: ground };
  const versions = await readTypeVersions(ws);
  if (versions) facts.typeVersions = versions;
  facts.customData = await customDataState(ws, files);
  facts.tftData = await objectDataTft(ws, files);
  const dooText = await readDooText(ws, files);
  facts.doodads = doodadEntries(dooText);
  const { triggers, known, custom } = await readTriggers(ws, files);
  if (custom) facts.customTriggers = true;
  if (known) facts.triggersKnown = true;
  if (forSet) {
    facts.constantsKnown = !miscPath || misc !== null;
    facts.defaultTriggers = !!triggers && isDefaultTriggers(triggers);
  }
  // The start locations' surroundings only matter when nothing above already decides: a reason that takes the flag off
  // (or keeps it off) makes them moot. `forSet` callers may hold a melee map too (the terrain editor's save), so
  // triggers that aren't the default but aren't custom don't skip them.
  const decided = facts.customData === true || facts.customConstants || facts.customTriggers === true
    || (forSet && (facts.customData !== false || !facts.constantsKnown));
  if (!decided && ground) facts.around = await readSurroundings(ws, dooText, ground);
  return facts;
}

/** war3map.doo.json's text: undefined when the map has no doodad file, null when it can't be read or is kept raw (a
 *  project not unpacked to JSON). */
async function readDooText(ws: Pick<MeleeFiles, "readText">, files: readonly string[]): Promise<string | null | undefined> {
  const json = files.find((p) => p.toLowerCase() === "map/war3map.doo.json");
  if (!json) return files.some((p) => p.toLowerCase() === "map/war3map.doo") ? null : undefined;
  return ws.readText(json).catch(() => null);
}

/** war3map.doo's entries (doodads and destructables) from readDooText's answer, for their drop sets: [] when the map
 *  has no doodad file; null when it is there but can't be told: raw, unreadable, or not a doodad file. */
export function doodadEntries(text: string | null | undefined): PlacedLike[] | null {
  if (text === undefined) return [];
  if (text === null) return null;
  try {
    const doc = JSON.parse(text) as { doodads?: unknown };
    return doc && Array.isArray(doc.doodads) ? doc.doodads as PlacedLike[] : null;
  } catch { return null; }
}

/** The project's saved terrain; null when there is none or it can't be read or parsed. */
async function readGround(ws: MeleeFiles, files: readonly string[]): Promise<Terrain | null> {
  const path = terrainPath(files);
  const bytes = path ? await readTerrainBytes(path, { readText: () => ws.readText(path), readBytes: () => ws.readBytes(path) }).catch(() => null) : null;
  try { return bytes ? parseW3e(bytes) : null; } catch { return null; }
}

/** The project's trigger file, parsed (null when there is none or it can't be read), whether that is known: no file,
 *  or one that was read, and whether it holds custom triggers (hasCustomTriggers; also a raw war3map.wtg read up to a
 *  function the default trigger doesn't use, which can't be parsed further without the game's TriggerData). */
async function readTriggers(ws: MeleeFiles, files: readonly string[]): Promise<{ triggers: ReturnType<typeof parseWtgJson> | null; known: boolean; custom: boolean }> {
  const wtg = wtgPath(files.map((path) => ({ path })));
  if (!wtg) return { triggers: null, known: true, custom: false };
  try {
    const triggers = wtg.toLowerCase().endsWith(".json") ? parseWtgJson(await ws.readText(wtg)) : parseWtgWithoutArgs(await ws.readBytes(wtg));
    return { triggers, known: true, custom: hasCustomTriggers(triggers) };
  } catch (e) {
    if (e instanceof NotDefaultFunction) return { triggers: null, known: true, custom: true };
    return { triggers: null, known: false, custom: false };
  }
}

/** Whether flag 0x4000 may be cleared (tftFlagsAfter's `mayClear`): no object data but what lets it clear
 *  (objectDataTft) and no custom triggers, both known. */
const tftMayClear = (facts: Pick<MeleeFacts, "tftData" | "customTriggers" | "triggersKnown">) =>
  facts.tftData?.mayClear === true && facts.triggersKnown === true && facts.customTriggers !== true;

/** Flag 0x4000's need from the placed objects (placedNeedTft) and the object data (objectDataTft): true when either
 *  needs it, false when both are known not to, else null (left as it is). */
const tftNeed = (placed: boolean | null, data: boolean | null | undefined): boolean | null =>
  placed === true || data === true ? true : placed === false && data === false ? false : null;

/** The game's unit and item types → their version (Units\UnitData.slk, Units\ItemData.slk: tftflag.ts typeVersions);
 *  null when there's no game or a table can't be read or has no versions. */
export async function readTypeVersions(ws: Pick<MeleeFiles, "gameText" | "typeVersions">): Promise<Map<string, number> | null> {
  if (ws.typeVersions) return ws.typeVersions();
  if (!ws.gameText) return null;
  try {
    const units = typeVersions(parseSlk(await ws.gameText("Units\\UnitData.slk")), "unitID");
    if (!units.size) return null;
    const both = typeVersions(parseSlk(await ws.gameText("Units\\ItemData.slk")), "itemID", new Map(units));
    return both.size > units.size ? both : null;
  } catch { return null; }
}

/** What stands around the start locations (StartSurroundings) on `ground`: null when the game's tables or the doodads
 *  can't be read. */
async function readSurroundings(ws: MeleeFiles, dooText: string | null | undefined, ground: Terrain): Promise<StartSurroundings | null> {
  return startSurroundings(ws, ground, dooText ?? null);
}

/** The start locations' surroundings (readSurroundings) of `ground` with the doodads of `dooText` (war3map.doo.json's
 *  text: null when there is none or it can't be read): for ground and doodads not saved yet, as Map Size's. Null when
 *  they can't be told (no game tables, a doodad file that can't be read). */
export async function startSurroundings(ws: Pick<MeleeFiles, "gameText" | "gameBytes">, ground: Terrain, dooText: string | null): Promise<StartSurroundings | null> {
  /** A game table's rows that have `key`; empty when it can't be read. */
  const table = async (path: string, key: string) => {
    const text = ws.gameText ? await ws.gameText(path).catch(() => null) : null;
    return typeof text !== "string" ? [] : parseSlk(text).filter((r) => r[key]);
  };
  const tiles = await table("TerrainArt\\Terrain.slk", "tileID");
  // Doodads and destructables without a pathing texture (flowers, mushrooms, lily pads) don't block a start. A type the
  // tables don't have (or that can't be read) can't be told. The map's own changes to them (war3map.w3d / w3b) never
  // get here: their file alone leaves the flag off (customData).
  const pathTex = new Map<string, string>();
  for (const r of await table("Doodads\\Doodads.slk", "doodID")) pathTex.set(r.doodID, noTexture(r.pathTex) ? "" : r.pathTex);
  for (const r of await table("Units\\DestructableData.slk", "DestructableID")) pathTex.set(r.DestructableID, noTexture(r.pathTex) ? "" : r.pathTex);
  const textures = new Map<string, Promise<Mip | null>>();
  const texture = (path: string) => {
    // The tables write some paths with doubled backslashes.
    const p = path.replace(/\\+/g, "\\");
    let m = textures.get(p.toLowerCase());
    if (!m) {
      m = ws.gameBytes ? ws.gameBytes(p).then((b) => decodeImage(b, p).mip(0)).catch(() => null) : Promise.resolve(null);
      textures.set(p.toLowerCase(), m);
    }
    return m;
  };
  const doodads = tiles.length ? await doodadStamps(dooText, ground, pathTex, texture) : null;
  if (!doodads) return null;
  const rules = new Map(tiles.map((r) => [r.tileID, { walkable: r.walkable !== "0", buildable: r.buildable !== "0", flyable: r.flyable !== "0" }]));
  const water = parseWaterOffsets(await table("TerrainArt\\Water.slk", "waterID"));
  return {
    pathing: startPathing(ground, rules, doodads.stamps, { ownTiles: ownGroundTiles(tiles, ground.tileset), waterOffset: water.get(ground.tileset) }),
    unknown: doodads.unknown,
  };
}

/** Why Studio leaves the Melee flag off on a save (empty: it puts it back): the World Editor's reasons that apply, and
 *  those Studio can't rule out for sure. */
export function meleeSetBlockers(info: MeleeInfo, placed: readonly PlacedLike[], facts: MeleeFacts): string[] {
  const t = facts.terrain;
  const out = meleeBlockers({ ...info, customConstants: facts.customConstants }, placed, t ? startsInvalidPlaces(t, placed) : false);
  if (facts.constantsKnown !== true) out.push("Gameplay constants not known");
  if (facts.customData !== false) out.push(facts.customData ? "Custom object data or game interface" : "Custom object data or game interface not known");
  if (facts.defaultTriggers !== true) out.push("Triggers other than the default Melee Initialization, or not known");
  if (!t || !facts.around) out.push("Start locations' surroundings not known");
  else if (!startsPlainlyValid(t, placed, facts.around)) out.push("Start locations not plainly valid");
  return out;
}

/** The map's flags after a save, and why Melee went off (empty when it didn't). Melee goes off by owner.ts
 *  meleeBlockers, and back on only when meleeSetBlockers finds nothing; else the flag stays as it is. Flag 0x4000
 *  follows the placed units and items (tftflag.ts), when `facts.typeVersions` tells, and the object data
 *  (`facts.tftData`). */
export function meleeAfterSave(info: MeleeInfo, placed: readonly PlacedLike[], facts: MeleeFacts): { flags: number; reasons: string[] } {
  // Requires The Frozen Throne data follows the placed units and items and the ability, buff and upgrade data, whatever
  // the Melee flag does; 0x0008 the terrain's custom tilesets flag.
  const need = tftNeed(placedNeedTft(placed, facts.typeVersions, info.itemTables, facts.doodads ?? null), facts.tftData ? facts.tftData.need : null);
  const tft = (flags: number) => tilesetFlagAfter(tftFlagsAfter(flags, need, tftMayClear(facts)), facts.terrain);
  if (!(info.flags & MELEE_MAP)) return { flags: tft(meleeSetBlockers(info, placed, facts).length ? info.flags : info.flags | MELEE_MAP), reasons: [] };
  const t = facts.terrain;
  const reasons = meleeBlockers({ ...info, customConstants: facts.customConstants }, placed,
    !!t && (startsInvalidPlaces(t, placed) || (!!facts.around && startsSurelyInvalid(t, placed, facts.around))));
  if (facts.customData === true) reasons.push("Custom object data or game interface");
  if (facts.customTriggers === true) reasons.push("Custom triggers");
  return { flags: tft(reasons.length ? info.flags & ~MELEE_MAP : info.flags), reasons };
}

/** meleeAfterSave with the facts read from the project. A map that isn't melee and has one of the reasons war3map.w3i
 *  and the units tell keeps its Melee flag without the rest of the project being read (only the game's unit and item
 *  tables, for flag 0x4000, and the terrain, for flag 0x0008, unless `terrain` is given). */
export async function savedMelee(ws: MeleeFiles, info: MeleeInfo, placed: readonly PlacedLike[], terrain?: Terrain | null): Promise<{ flags: number; reasons: string[] }> {
  const off = !(info.flags & MELEE_MAP);
  if (off && meleeBlockers(info, placed).length) {
    const files = ws.files().map((f) => f.path);
    let need = placedNeedTft(placed, await readTypeVersions(ws), info.itemTables, doodadEntries(await readDooText(ws, files)));
    // Clearing needs to know there is no object data that holds the flag and no custom triggers; setting doesn't.
    let mayClear = false;
    if (need !== true) {
      // The object data first: it is small, and decides most custom maps without parsing their triggers.
      const tftData = await objectDataTft(ws, files);
      need = tftNeed(need, tftData.need);
      if (need === false && tftData.mayClear) {
        const { known, custom } = await readTriggers(ws, files);
        mayClear = tftMayClear({ tftData, triggersKnown: known, customTriggers: custom });
      }
    }
    const ground = terrain !== undefined ? terrain : await readGround(ws, ws.files().map((f) => f.path));
    return { flags: tilesetFlagAfter(tftFlagsAfter(info.flags, need, mayClear), ground), reasons: [] };
  }
  return meleeAfterSave(info, placed, await readMeleeFacts(ws, terrain, off));
}
