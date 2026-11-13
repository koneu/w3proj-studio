// The Melee flag (war3map.w3i) as a save leaves it. Every path that writes placed units, the map's info, its gameplay
// constants or its ground comes through here: the terrain editor's save, the MCP object tools, and the map script's
// run after a save (also with script.generateOnSave off, and on vJASS maps). The rules are owner.ts meleeBlockers;
// this gathers what they need beyond war3map.w3i and the placed units.
//
// The World Editor's save also puts the flag back on a map that meets its rules. Studio does that only when it can
// tell every one of them (meleeSetBlockers): its reasons it can't decide reliably (custom triggers beyond the plain
// default, start locations in invalid positions beyond the plain case) leave the flag as it is.

import type { W3Api } from "../../extensions/api";
import { parseSlk } from "../formats/text";
import { isDefaultTriggers, parseWtgWithoutArgs } from "../triggers/defaults";
import { parseWtgJson, wtgPath } from "../triggers/wtg";
import { meleeBlockers, MELEE_MAP, hasCustomConstants, type MeleeInfo } from "./owner";
import { parseW3e, waterSurfaceAt, type Terrain } from "./w3e";
import { readTerrainBytes, terrainPath } from "./w3etext";

interface PlacedLike { id: string; player?: number; position?: readonly number[] }

/** The map's gameplay constants. */
export const MISC_TXT = "map/war3mapMisc.txt";

/** Files of the World Editor's other reasons: custom unit, item, destructible, doodad, ability, buff and upgrade data
 *  (WESTRING_NOTMELEE_CUSTOMUNITS … CUSTOMUPGRADEDATA) and a custom game interface (CUSTOMSKINDATA). A file being there
 *  is enough to leave the flag off: one with no change in it isn't told apart. */
const CUSTOM_DATA = /^map\/(war3map\.(w3u|w3t|w3b|w3d|w3a|w3h|w3q)(\.json)?|war3mapSkin\.txt)$/i;

/** How far around a start location Studio looks before it calls its position plainly valid. The World Editor's save
 *  found starts invalid with trees about 200 away, a tavern 250 away (we-drive 2026-11-09) and close to cliffs; the
 *  ladder maps' nearest trees are 547 to 692 from a start and their gold mines 700 to 850 (meleecheck.ts). */
export const CLEAR_AROUND_START = 512;
/** A special doodad (cave, collapsed cliff) is placed by its tile's corner and reaches up to this much further. */
const SPECIAL_REACH = 256;

/** Whether a start location stands under water: one of the World Editor's "start locations in invalid positions"
 *  (World Editor 7003's new maps on shallow or deep water, we-drive 2026-11-11). Its other invalid positions (trees
 *  about 200 away, a tavern at 250) Studio can't tell (see meleeBlockers). */
export function startsUnderWater(t: Terrain, placed: readonly PlacedLike[]): boolean {
  return placed.some((p) => p.id === "sloc" && Array.isArray(p.position) && p.position.length >= 2
    && Number.isFinite(p.position[0]) && Number.isFinite(p.position[1]) && waterSurfaceAt(t, p.position[0], p.position[1]) !== null);
}

/** A doodad's place: `reach` how far it may stand from it. */
export interface DoodadSpot { x: number; y: number; reach: number }

/** What stands around the start locations, besides the placed units and the ground. */
export interface StartSurroundings {
  doodads: readonly DoodadSpot[];
  /** Ground tiles the game's Terrain.slk calls buildable. */
  buildable: ReadonlySet<string>;
  /** Unit types the game's UnitData.slk gives no pathing texture (creeps, critters): they don't block a building. */
  unpathed: ReadonlySet<string>;
}

/**
 * Whether every start location stands where the World Editor plainly takes it as valid: inside the map, with nothing
 * placed (doodad, building, item, another start; a unit type without pathing, such as a creep, doesn't count: the
 * game's melee maps have them as close as 12) within CLEAR_AROUND_START, and the ground there all on the start's cliff
 * level, without ramps, water, blight, boundary or a tile the game's Terrain.slk doesn't call buildable. False for
 * anything less, including a map without starts: then Studio can't tell, which is not the same as invalid.
 */
export function startsPlainlyValid(t: Terrain, placed: readonly PlacedLike[], around: StartSurroundings): boolean {
  const { doodads, buildable, unpathed } = around;
  const pos = (p: PlacedLike) => (Array.isArray(p.position) && p.position.length >= 2 && Number.isFinite(p.position[0]) && Number.isFinite(p.position[1]) ? p.position : null);
  const starts = placed.filter((p) => p.id === "sloc");
  if (!starts.length || placed.some((p) => !pos(p))) return false;
  const R = CLEAR_AROUND_START;
  const blocking = placed.filter((p) => !unpathed.has(p.id));
  return starts.every((s) => {
    const [sx, sy] = pos(s)!;
    if (blocking.some((p) => p !== s && Math.hypot(pos(p)![0] - sx, pos(p)![1] - sy) <= R)) return false;
    if (doodads.some((d) => Math.hypot(d.x - sx, d.y - sy) <= R + d.reach)) return false;
    const fx = (sx - t.offsetX) / 128, fy = (sy - t.offsetY) / 128;
    if (!(fx >= 0 && fy >= 0 && fx <= t.width - 1 && fy <= t.height - 1)) return false;
    const level = t.corners[Math.round(fy) * t.width + Math.round(fx)]?.layer;
    const span = Math.ceil(R / 128) + 1;
    for (let y = Math.floor(fy) - span; y <= Math.ceil(fy) + span; y++) {
      for (let x = Math.floor(fx) - span; x <= Math.ceil(fx) + span; x++) {
        if (Math.hypot(x - fx, y - fy) * 128 > R + 128) continue;
        // Close to the map's edge: not plainly valid.
        if (x < 0 || y < 0 || x >= t.width || y >= t.height) return false;
        const c = t.corners[y * t.width + x];
        // Water counts where its surface is above the ground: the game's maps flag dry corners too.
        if (!c || c.layer !== level || c.ramp || (c.hasWater && c.water > c.height) || c.blight || c.boundary || !buildable.has(t.groundTiles[c.texture])) return false;
      }
    }
    return true;
  });
}

/** What of a project the melee rules read. `gameText`: the game's files (Terrain.slk, UnitData.slk: which tiles are buildable, which units block);
 *  without it the flag is never put back. */
export interface MeleeFiles {
  files(): readonly { path: string }[];
  readText(path: string): Promise<string>;
  readBytes(path: string): Promise<Uint8Array>;
  gameText?(path: string): Promise<string>;
}

/** The project and the game of the app, as the melee rules read them. */
export function meleeFiles(w3: Pick<W3Api, "workspace" | "game">): MeleeFiles {
  return {
    files: () => w3.workspace.files(),
    readText: (p) => w3.workspace.readText(p),
    readBytes: (p) => w3.workspace.readBytes(p),
    gameText: (p) => w3.game.readText(p),
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
  /** A file of custom object data or game interface is there. */
  customData?: boolean;
  /** What stands around the start locations: the doodads, which tiles are buildable and which units have no pathing. */
  around?: StartSurroundings | null;
}

/** The doodads of war3map.doo.json; null for anything that isn't one (a raw file, unreadable, malformed). */
function doodadSpots(text: string | null, t: Terrain | null): DoodadSpot[] | null {
  if (text === null || !t) return null;
  let doc: { doodads?: unknown; specials?: unknown };
  try { doc = JSON.parse(text) as typeof doc; } catch { return null; }
  if (!doc || !Array.isArray(doc.doodads)) return null;
  const out: DoodadSpot[] = [];
  for (const d of doc.doodads as { position?: unknown }[]) {
    const p = d?.position;
    if (!Array.isArray(p) || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) return null;
    out.push({ x: p[0], y: p[1], reach: 0 });
  }
  if (doc.specials !== undefined && !Array.isArray(doc.specials)) return null;
  for (const s of (doc.specials ?? []) as { x?: unknown; y?: unknown }[]) {
    if (!Number.isFinite(s?.x) || !Number.isFinite(s?.y)) return null;
    out.push({ x: t.offsetX + (s.x as number) * 128, y: t.offsetY + (s.y as number) * 128, reach: SPECIAL_REACH });
  }
  return out;
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
  if (!forSet) return facts;
  facts.constantsKnown = !miscPath || misc !== null;
  facts.customData = files.some((p) => CUSTOM_DATA.test(p));
  // The rest only matters when nothing above already leaves the flag off.
  if (facts.customData || !facts.constantsKnown || facts.customConstants || !ground) return facts;
  const wtg = wtgPath(files.map((path) => ({ path })));
  try {
    const file = !wtg ? null : wtg.toLowerCase().endsWith(".json") ? parseWtgJson(await ws.readText(wtg)) : parseWtgWithoutArgs(await ws.readBytes(wtg));
    facts.defaultTriggers = !!file && isDefaultTriggers(file);
  } catch { facts.defaultTriggers = false; }
  if (!facts.defaultTriggers) return facts;
  const dooPath = find("map/war3map.doo.json");
  const doodads = doodadSpots(dooPath ? await ws.readText(dooPath).catch(() => null) : null, ground);
  /** A game table's rows that have `key`; empty when it can't be read. */
  const table = async (path: string, key: string) => {
    const text = ws.gameText ? await ws.gameText(path).catch(() => null) : null;
    return text === null ? [] : parseSlk(text).filter((r) => r[key]);
  };
  const tiles = await table("TerrainArt\\Terrain.slk", "tileID"), units = await table("Units\\UnitData.slk", "unitID");
  const none = (tex: string | undefined) => tex === undefined || tex === "" || tex === "_" || tex === "-" || tex.toLowerCase() === "none";
  facts.around = doodads && tiles.length && units.length ? {
    doodads,
    buildable: new Set(tiles.filter((r) => r.buildable !== "0").map((r) => r.tileID)),
    unpathed: new Set(units.filter((r) => none(r.pathTex)).map((r) => r.unitID)),
  } : null;
  return facts;
}

/** Why Studio leaves the Melee flag off on a save (empty: it puts it back): the World Editor's reasons that apply, and
 *  those Studio can't rule out for sure. */
export function meleeSetBlockers(info: MeleeInfo, placed: readonly PlacedLike[], facts: MeleeFacts): string[] {
  const t = facts.terrain;
  const out = meleeBlockers({ ...info, customConstants: facts.customConstants }, placed, t ? startsUnderWater(t, placed) : false);
  if (facts.constantsKnown !== true) out.push("Gameplay constants not known");
  if (facts.customData !== false) out.push("Custom object data or game interface");
  if (facts.defaultTriggers !== true) out.push("Triggers other than the default Melee Initialization, or not known");
  if (!t || !facts.around) out.push("Start locations' surroundings not known");
  else if (!startsPlainlyValid(t, placed, facts.around)) out.push("Start locations not plainly valid");
  return out;
}

/** The map's flags after a save, and why Melee went off (empty when it didn't). Melee goes off by owner.ts
 *  meleeBlockers, and back on only when meleeSetBlockers finds nothing; else the flag stays as it is. */
export function meleeAfterSave(info: MeleeInfo, placed: readonly PlacedLike[], facts: MeleeFacts): { flags: number; reasons: string[] } {
  if (!(info.flags & MELEE_MAP)) return { flags: meleeSetBlockers(info, placed, facts).length ? info.flags : info.flags | MELEE_MAP, reasons: [] };
  const reasons = meleeBlockers({ ...info, customConstants: facts.customConstants }, placed, facts.terrain ? startsUnderWater(facts.terrain, placed) : false);
  return { flags: reasons.length ? info.flags & ~MELEE_MAP : info.flags, reasons };
}

/** meleeAfterSave with the facts read from the project. A map that isn't melee and has one of the reasons war3map.w3i
 *  and the units tell keeps its flag without anything being read. */
export async function savedMelee(ws: MeleeFiles, info: MeleeInfo, placed: readonly PlacedLike[], terrain?: Terrain | null): Promise<{ flags: number; reasons: string[] }> {
  const off = !(info.flags & MELEE_MAP);
  if (off && meleeBlockers(info, placed).length) return { flags: info.flags, reasons: [] };
  return meleeAfterSave(info, placed, await readMeleeFacts(ws, terrain, off));
}
