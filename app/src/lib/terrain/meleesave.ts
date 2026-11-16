// The Melee flag (war3map.w3i) as a save leaves it. Every path that writes placed units, the map's info, its gameplay
// constants or its ground comes through here: the terrain editor's save, the MCP object tools, and the map script's
// run after a save (also with script.generateOnSave off, and on vJASS maps). The rules are owner.ts meleeBlockers;
// this gathers what they need beyond war3map.w3i and the placed units.
//
// The World Editor's save also puts the flag back on a map that meets its rules. Studio does that only when it can
// tell every one of them (meleeSetBlockers): what it can't decide (custom triggers beyond the plain default, start
// locations whose surroundings it can't read: startsPlainlyValid) leaves the flag as it is.

import type { W3Api } from "../../extensions/api";
import { readIni } from "../formats/iniedit";
import { parseSlk } from "../formats/text";
import { hasCustomTriggers, isDefaultTriggers, parseWtgWithoutArgs } from "../triggers/defaults";
import { parseWtgJson, wtgPath } from "../triggers/wtg";
import { meleeBlockers, MELEE_MAP, hasCustomConstants, type MeleeInfo } from "./owner";
import { decodeImage, type Mip } from "../image/index.ts";
import { generatePathing, NO_BUILD, NO_WALK, type PathingStamp, type TileRule } from "./pathing";
import { mapEdgeTiles, parseW3e, parseWaterOffsets, waterSurfaceAt, type Terrain } from "./w3e";
import { ownGroundTiles } from "./tilesets";
import { readTerrainBytes, terrainPath } from "./w3etext";

interface PlacedLike { id: string; player?: number; position?: readonly number[] }

/** The map's gameplay constants. */
export const MISC_TXT = "map/war3mapMisc.txt";

/** Files of the World Editor's other reasons: custom unit, item, destructible, doodad, ability, buff and upgrade data
 *  (WESTRING_NOTMELEE_CUSTOMUNITS … CUSTOMUPGRADEDATA) and a custom game interface (CUSTOMSKINDATA). Only a file that
 *  changes something counts (customDataState): an empty one (no objects, no values) is the default. */
const CUSTOM_DATA = /^map\/(war3map\.(w3u|w3t|w3b|w3d|w3a|w3h|w3q)(\.json)?|war3mapSkin\.txt)$/i;

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
 *  (World Editor 7003's new maps on shallow or deep water, we-drive 2026-11-11). The others (startsPlainlyValid) need
 *  the game's pathing textures, so a save that takes the flag off doesn't look at them. */
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
  const pos = (p: PlacedLike) => (Array.isArray(p.position) && p.position.length >= 2 && Number.isFinite(p.position[0]) && Number.isFinite(p.position[1]) ? p.position : null);
  const starts = placed.filter((p) => p.id === "sloc");
  if (!starts.length || placed.some((p) => !pos(p))) return false;
  const w = (t.width - 1) * 4, h = (t.height - 1) * 4;
  const cells = around.pathing.subarray(16);
  if (cells.length !== w * h) return false;
  const cellOf = (p: PlacedLike) => [Math.round((pos(p)![0] - t.offsetX) / 32), Math.round((pos(p)![1] - t.offsetY) / 32)];
  const mines = placed.filter((p) => MINES.has(p.id));
  const S = START_SQUARE;
  return starts.every((s) => {
    const [cx, cy] = cellOf(s), [sx, sy] = pos(s)!;
    if (starts.some((o) => o !== s && Math.max(Math.abs(cellOf(o)[0] - cx), Math.abs(cellOf(o)[1] - cy)) < 2 * S)) return false;
    if (mines.some((m) => Math.hypot(pos(m)![0] - sx, pos(m)![1] - sy) < MINE_CLEARANCE)) return false;
    if (around.unknown?.some((d) => Math.max(Math.abs(d.x - sx), Math.abs(d.y - sy)) < UNKNOWN_REACH)) return false;
    if (cx - S < 0 || cy - S < 0 || cx + S > w || cy + S > h) return false;
    for (let y = cy - S; y < cy + S; y++) for (let x = cx - S; x < cx + S; x++) if (cells[y * w + x] & NOT_FOR_A_HALL) return false;
    return true;
  });
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
}

/** The project and the game of the app, as the melee rules read them. */
export function meleeFiles(w3: Pick<W3Api, "workspace" | "game">): MeleeFiles {
  return {
    files: () => w3.workspace.files(),
    readText: (p) => w3.workspace.readText(p),
    readBytes: (p) => w3.workspace.readBytes(p),
    gameText: (p) => w3.game.readText(p),
    gameBytes: (p) => w3.game.read(p),
  };
}

/** What the rules need besides war3map.w3i and the placed units. The optional part is what putting the flag back
 *  needs (read with readMeleeFacts' `forSet`); absent or null means not known, which leaves the flag as it is. */
export interface MeleeFacts {
  /** war3mapMisc.txt sets a gameplay constant. */
  customConstants: boolean;
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
  /** What stands around the start locations: the pathing their squares are tested against. */
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
 * because not knowing keeps the flag as it is: it never reads as "constants set" or "a start under water", nor, with
 * `forSet`, as "no constants", "default triggers" or "nothing near the starts".
 */
export async function readMeleeFacts(ws: MeleeFiles, terrain?: Terrain | null, forSet = false): Promise<MeleeFacts> {
  const files = ws.files().map((f) => f.path);
  const find = (want: string) => files.find((p) => p.toLowerCase() === want.toLowerCase());
  const miscPath = find(MISC_TXT);
  const misc = miscPath ? await ws.readText(miscPath).catch(() => null) : null;
  let ground = terrain ?? null;
  if (terrain === undefined) {
    const path = terrainPath(files);
    const bytes = path ? await readTerrainBytes(path, { readText: () => ws.readText(path), readBytes: () => ws.readBytes(path) }).catch(() => null) : null;
    try { ground = bytes ? parseW3e(bytes) : null; } catch { ground = null; }
  }
  const facts: MeleeFacts = { customConstants: misc !== null && hasCustomConstants(misc), terrain: ground };
  facts.customData = await customDataState(ws, files);
  const wtg = wtgPath(files.map((path) => ({ path })));
  let triggers: ReturnType<typeof parseWtgJson> | null = null;
  try {
    triggers = !wtg ? null : wtg.toLowerCase().endsWith(".json") ? parseWtgJson(await ws.readText(wtg)) : parseWtgWithoutArgs(await ws.readBytes(wtg));
    if (triggers && hasCustomTriggers(triggers)) facts.customTriggers = true;
  } catch { triggers = null; }
  if (!forSet) return facts;
  facts.constantsKnown = !miscPath || misc !== null;
  // The rest only matters when nothing above already leaves the flag off.
  if (facts.customData || !facts.constantsKnown || facts.customConstants || !ground) return facts;
  facts.defaultTriggers = !!triggers && isDefaultTriggers(triggers);
  if (!facts.defaultTriggers) return facts;
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
  const dooPath = find("map/war3map.doo.json");
  const doodads = tiles.length ? await doodadStamps(dooPath ? await ws.readText(dooPath).catch(() => null) : null, ground, pathTex, texture) : null;
  if (!doodads) { facts.around = null; return facts; }
  const rules = new Map(tiles.map((r) => [r.tileID, { walkable: r.walkable !== "0", buildable: r.buildable !== "0", flyable: r.flyable !== "0" }]));
  const water = parseWaterOffsets(await table("TerrainArt\\Water.slk", "waterID"));
  facts.around = {
    pathing: startPathing(ground, rules, doodads.stamps, { ownTiles: ownGroundTiles(tiles, ground.tileset), waterOffset: water.get(ground.tileset) }),
    unknown: doodads.unknown,
  };
  return facts;
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
 *  meleeBlockers, and back on only when meleeSetBlockers finds nothing; else the flag stays as it is. */
export function meleeAfterSave(info: MeleeInfo, placed: readonly PlacedLike[], facts: MeleeFacts): { flags: number; reasons: string[] } {
  if (!(info.flags & MELEE_MAP)) return { flags: meleeSetBlockers(info, placed, facts).length ? info.flags : info.flags | MELEE_MAP, reasons: [] };
  const reasons = meleeBlockers({ ...info, customConstants: facts.customConstants }, placed, facts.terrain ? startsInvalidPlaces(facts.terrain, placed) : false);
  if (facts.customData === true) reasons.push("Custom object data or game interface");
  if (facts.customTriggers === true) reasons.push("Custom triggers");
  return { flags: reasons.length ? info.flags & ~MELEE_MAP : info.flags, reasons };
}

/** meleeAfterSave with the facts read from the project. A map that isn't melee and has one of the reasons war3map.w3i
 *  and the units tell keeps its flag without anything being read. */
export async function savedMelee(ws: MeleeFiles, info: MeleeInfo, placed: readonly PlacedLike[], terrain?: Terrain | null): Promise<{ flags: number; reasons: string[] }> {
  const off = !(info.flags & MELEE_MAP);
  if (off && meleeBlockers(info, placed).length) return { flags: info.flags, reasons: [] };
  return meleeAfterSave(info, placed, await readMeleeFacts(ws, terrain, off));
}
