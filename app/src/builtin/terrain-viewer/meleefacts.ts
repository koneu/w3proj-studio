// What check_melee and check_path go by, from a map's ground and placed objects: the open terrain editor's (the MCP
// tools, index.ts) or the saved project files' (`w3proj check` without the app, src/headless/check.ts). One body for
// both, so the command line answers what the app's tools answer for the same saved map.

import type { W3Api } from "../../extensions/api";
import type { TerrainToolGroup } from "../../extensions/services";
import { parseSlk } from "../../lib/formats/text";
import { NO_WALK } from "../../lib/terrain/pathing";
import { onBoundary, parseW3e, type Terrain } from "../../lib/terrain/w3e";
import { readTerrainBytes, terrainPath } from "../../lib/terrain/w3etext";
import { checkMelee, unitLevels } from "./meleecheck";
import type { Placed } from "./objects";
import { Occupancy } from "./occupancy";
import { checkPath, nearestObject, narrowStrips, widestFrom, widthOf, type Grid, type PathReport } from "./pathcheck";
import { buildPathingMap, loadPathingData, objectMods, specialsOf, type PathingData } from "./pathmap";
import { loadPlacedFile } from "./placement";
import { applyTilesetWater } from "./wateroffset";

/** A map's ground and what stands on it. */
export interface WalkSource {
  terrain: Terrain;
  /** The pathing map as made from terrain and doodads, the Pathing tool's overrides applied. */
  pathing(): Promise<{ cells: Uint8Array; width: number; height: number }>;
  /** Cells where doodads, destructables and buildings stand in the way (the pathing map leaves them out). */
  blockers(): Promise<Uint8Array>;
  /** The placed units, items, doodads and destructables. */
  list(): readonly Placed[];
  /** A custom object's base id. */
  baseOf(id: string): string | undefined;
}

/** The saved project's ground and objects, as the terrain editor would hold them right after opening it (the live
 *  source in index.ts): the terrain with its tileset's water, the placement files, the pathing map made from them
 *  with the Pathing tool's saved overrides (`groups`' filterSavedPathing), and what stands in the way.
 *  `read`: an imported file, else the game's (projectfiles.ts readFile); `baseOf`: custom ids' bases.
 *  Throws when the project has no terrain, or when a file that is there can't be read: a placement file that can't be
 *  read isn't taken as empty (that would call a blocked map open). */
export async function projectWalkSource(w3: W3Api, opts: {
  read: (path: string) => Promise<Uint8Array>;
  baseOf: (id: string) => string | undefined;
  groups: readonly Pick<TerrainToolGroup, "filterSavedPathing">[];
}): Promise<WalkSource> {
  const path = terrainPath(w3.workspace.files().map((f) => f.path));
  if (!path) throw new Error("the project has no terrain (map/war3map.w3e or war3map.w3e.txt)");
  const terrain = await applyTilesetWater(w3, parseW3e(await readTerrainBytes(path, { readText: () => w3.workspace.readText(path), readBytes: () => w3.workspace.readBytes(path) })));
  const [dooFile, unitsFile] = await Promise.all([loadPlacedFile(w3, "war3map.doo", "doodads"), loadPlacedFile(w3, "war3mapUnits.doo", "units")]);
  let data: Promise<PathingData> | null = null;
  return {
    terrain,
    pathing: async () => {
      const doodads = dooFile?.list ?? [];
      const { wpm } = await buildPathingMap(w3, terrain, doodads, opts.read, w3.settings.get<number>("terrain.pathing.deepWater"), specialsOf(dooFile?.doc));
      const v = new DataView(wpm.buffer, wpm.byteOffset);
      const width = v.getUint32(8, true), height = v.getUint32(12, true);
      for (const g of opts.groups) await g.filterSavedPathing?.(wpm.subarray(16), width, height);
      return { cells: wpm.slice(16), width, height };
    },
    blockers: async () => {
      const d = await (data ??= loadPathingData(w3, opts.read, opts.baseOf));
      // Units walk off and items are walked over: of those, only buildings stay in the way (as the open editor's).
      const buildings = (unitsFile?.list ?? []).filter((e) => d.unitShape(e.id)?.path).map((entry) => ({ entry, kind: "w3u" }));
      const placed = [...(dooFile?.list ?? []).map((entry) => ({ entry, kind: "w3d" })), ...buildings];
      return (await Occupancy.build(terrain, d, placed)).blocked;
    },
    list: () => [...(unitsFile?.list ?? []), ...(dooFile?.list ?? [])],
    baseOf: opts.baseOf,
  };
}

/** What a unit can't walk on: the pathing map, and what stands there, which it leaves out. */
export async function walkGrid(src: WalkSource): Promise<Grid> {
  const [pathing, blockers] = await Promise.all([src.pathing(), src.blockers()]);
  const t = src.terrain;
  const painted = (i: number) => onBoundary(t, t.offsetX + ((i % pathing.width) + 0.5) * 32, t.offsetY + (Math.floor(i / pathing.width) + 0.5) * 32);
  return { blocked: pathing.cells.map((c, i) => (c & NO_WALK || blockers[i] || painted(i) ? 1 : 0)), width: pathing.width, height: pathing.height, offsetX: t.offsetX, offsetY: t.offsetY };
}

/** What stands by the tight or stuck place of a report: usually the reason. */
export function withNeighbour<T extends { narrowest?: { at: [number, number] }; stuckAt?: [number, number] }>(src: Pick<WalkSource, "list">, report: T) {
  const place = report.stuckAt ?? report.narrowest?.at;
  const near = place ? nearestObject(src.list(), place) : null;
  return near ? { ...report, standingNearby: { id: near.id, position: near.position } } : report;
}

/** check_path: whether a unit of `unitSize` gets from `from` to `to`, and what stands by where it gets stuck. */
export async function pathReport(src: WalkSource, from: [number, number], to: [number, number], unitSize = 32): Promise<PathReport & { standingNearby?: { id: string; position: number[] } }> {
  return withNeighbour(src, checkPath(await walkGrid(src), from, to, unitSize));
}

/** What the melee tools go by: units, trees, routes, and how wide things are. */
export async function meleeFacts(w3: W3Api, src: WalkSource, size: number) {
  const [balance, weapons, destructables, game, data, grid, unitMods] = await Promise.all([
    w3.game.readText("Units\\UnitBalance.slk"), w3.game.readText("Units\\UnitWeapons.slk"), w3.game.readText("Units\\DestructableData.slk"),
    w3.game.readText("Units\\MiscGame.txt"), w3.game.readText("Units\\MiscData.txt"), walkGrid(src), objectMods(w3, "war3map.w3u"),
  ]);
  // The map's own levels (ulev in its unit object data) over the game's.
  const level = unitLevels(parseSlk(balance), unitMods, (id) => src.baseOf(id));
  const sights = new Map(parseSlk(weapons).map((r) => [r.unitWeaponID, Number(r.acquire)]));
  const isTree = new Set(parseSlk(destructables).filter((r) => r.targType === "tree").map((r) => r.DestructableID));
  const lookup = <T,>(map: Map<string, T>, id: string) => map.get(id) ?? map.get(src.baseOf(id) ?? "");
  const placed = src.list() as unknown as (Placed & { player?: number; targetAcquisition?: number; itemTable?: number; itemSets?: unknown[]; randomLevel?: string })[];
  const units = placed.filter((e) => e.player !== undefined).map((e) => ({
    id: e.id, x: e.position[0], y: e.position[1], player: e.player as number, acquisition: e.targetAcquisition ?? -1,
    drops: (e.itemTable ?? -1) >= 0 || (e.itemSets ?? []).length > 0,
    ...(e.id.startsWith("Y") ? { randomLevel: parseInt((e.randomLevel ?? "").slice(0, 2), 16) || 0 } : {}),
  }));
  const trees = placed.filter((e) => e.player === undefined && (isTree.has(e.id) || isTree.has(src.baseOf(e.id) ?? ""))).map((e) => [e.position[0], e.position[1]] as [number, number]);
  const at = (u: { x: number; y: number }): [number, number] => [u.x, u.y];
  const starts = units.filter((u) => u.id === "sloc"), mines = units.filter((u) => u.id === "ngol"), taverns = units.filter((u) => u.id === "ntav");
  const routes: { name: string; to?: [number, number]; points?: [number, number][]; problem?: string }[] = [];
  const way = (name: string, from: [number, number], to: [number, number], target?: [number, number], owner?: number) => {
    let report = checkPath(grid, from, to, size, 200);
    // A mine or a building at the end stands in its own way.
    if (!report.walkable && report.nearestFree) report = checkPath(grid, from, report.nearestFree, size, 200);
    routes.push(report.route ? { name, ...(target ? { to: target } : {}), points: report.route, ...(owner === undefined ? {} : { from: owner, length: report.length }) } : { name, problem: report.problem ?? "no way through" });
  };
  for (let i = 0; i < starts.length; i++) for (let j = i + 1; j < starts.length; j++) way(`Start ${i + 1} to start ${j + 1}`, at(starts[i]), at(starts[j]));
  for (const [i, s] of starts.entries()) {
    const gap = (m: typeof s) => Math.hypot(m.x - s.x, m.y - s.y);
    for (const m of mines.filter((x) => gap(x) > 1150).sort((a, b) => gap(a) - gap(b)).slice(0, 3)) way(`Start ${i + 1} to the mine at ${Math.round(m.x)}, ${Math.round(m.y)}`, at(s), at(m), at(m), i);
    for (const t of taverns.slice(0, 1)) way(`Start ${i + 1} to the tavern`, at(s), at(t), at(t));
  }
  const number = (text: string, key: string, fallback: number) => Number(new RegExp(`^${key}=(\\d+)`, "m").exec(text)?.[1] ?? fallback);
  const widest = starts.map((s) => widestFrom(grid, at(s)));
  const t = src.terrain, counts = new Map<number, number>();
  for (const c of t.corners) if (!c.boundary) counts.set(c.layer, (counts.get(c.layer) ?? 0) + 1);
  const commonLevel = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
  const levelAt = (x: number, y: number) => t.corners[Math.round((y - t.offsetY) / 128) * t.width + Math.round((x - t.offsetX) / 128)]?.layer ?? 0;
  return { grid, widest, units, trees, routes, levelAt, commonLevel, levels: level, sights: (id: string) => lookup(sights, id), number, game, data };
}

/** check_melee: the map against what ladder maps do. */
export async function meleeReport(w3: W3Api, src: WalkSource, unitSize = 32): Promise<ReturnType<typeof checkMelee>> {
  const f = await meleeFacts(w3, src, unitSize);
  return checkMelee({
    units: f.units, trees: f.trees, routes: f.routes, level: f.levels, sight: f.sights,
    callForHelp: f.number(f.game, "CreepCallForHelp", 600), shopNotify: f.number(f.data, "NeutralUseNotifyRadius", 900),
    narrow: narrowStrips(f.grid), levelAt: f.levelAt, commonLevel: f.commonLevel,
    widestTo: (x, y) => {
      // Creeps and what stands by a camp fill its middle: the way to the place beside it counts.
      let best = 0;
      const { width: w, height: h, offsetX, offsetY } = f.grid;
      const cx = Math.floor((x - offsetX) / 32), cy = Math.floor((y - offsetY) / 32);
      for (let b = -3; b <= 3; b++) for (let a = -3; a <= 3; a++) {
        if (cx + a < 0 || cy + b < 0 || cx + a >= w || cy + b >= h) continue;
        for (const field of f.widest) best = Math.max(best, field[(cy + b) * w + cx + a]);
      }
      return widthOf(best);
    },
  });
}
