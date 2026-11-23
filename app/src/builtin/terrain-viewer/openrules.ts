// Snap and Fix Doodads on Load (doodadedit.ts snapAsOpened, fixAsOpened, unitAnglesAsOpened) for a project the terrain
// view never opened. The World Editor applies them whenever it opens a map, and its next save writes them; in Studio the
// map's save is packing it, so the pack applies them to the placement files as stored (map-project prepare, command
// w3.terrain.openRulesForPack), as opening the terrain view would have. Not an edit: no undo step, nothing marked as
// changed. Applied to their own result the rules change nothing, so a file a terrain view already saved stays as it is.

import type { W3Api } from "../../extensions/api";
import { readMapDoc } from "../../lib/formats/mapdoc";
import { isNotFoundError } from "../../lib/oserror";
import { inArea, playableArea, type Area } from "../../lib/terrain/area";
import { heightAt, parseW3e, type Terrain } from "../../lib/terrain/w3e";
import { readTerrainBytes, terrainPath } from "../../lib/terrain/w3etext";
import { fixAsOpened, snapAsOpened, unitAnglesAsOpened, type OpenRuleSource } from "./doodadedit";
import { snapSize, type PathSize } from "./doodadgrid";
import { savedFlags } from "./doodadrules";
import { doodadGround, ELEVATION_RADIUS_UNKNOWN } from "./objheights";
import { loadSkins, savedScaleRange, withObjectArt, type Placed, type Skin } from "./objects";
import { loadPathingData, type PathingData } from "./pathmap";
import { loadPlacedFile, savePlacedFile, type PlacedFile } from "./placement";
import { mapObjectData, readFile } from "./projectfiles";
import { borderFlags } from "./selectionkeys";

/** What the rules on opening go by, as the terrain view or a pack has it. */
export interface OpenRuleFacts {
  terrain: Terrain;
  /** The types (the game's with the map's object data); undefined while they aren't loaded. */
  skins: ReadonlyMap<string, Skin> | undefined;
  /** A custom type's base type. */
  bases: ReadonlyMap<string, string> | undefined;
  /** A type's pathing texture size (null: none, or not read). */
  sizeOf(id: string): PathSize | null;
  /** The map's own doodad and destructable data could be read: fixed rotations are known. */
  fixedRotKnown: boolean;
  /** Scale ranges (and heights) are known: false while that data can't be read. */
  scales: boolean;
  /** The playable area; null when the w3i can't be read (flags stay). */
  edge: Area | null;
}

/** The OpenRuleSource of the facts: what Snap and Fix Doodads on Load go by (doodadedit.ts). A fixed rotation the map's
 *  own data may change isn't known while that data can't be read: angles only come into 0..360 then. */
export function openRuleSourceOf(f: OpenRuleFacts): OpenRuleSource {
  const { terrain, skins, bases, edge, scales } = f;
  const skinById = (id: string) => skins?.get(id) ?? skins?.get(bases?.get(id) ?? "");
  const elevRadiusOf = (id: string) => { const s = skins?.get(id); return s?.kind === "w3b" ? s.elevRadius ?? 0 : 0; };
  return {
    sizeOf: f.sizeOf,
    fixedRot: (id) => { if (!f.fixedRotKnown) return null; const s = skinById(id); return s?.kind === "w3b" ? s.fixedRot : null; },
    scaleRule: (id) => {
      const skin = scales ? skins?.get(id) : undefined, range = skin ? savedScaleRange(skin) : undefined;
      return skin && range ? { kind: skin.kind, min: range[0], max: range[1] } : null;
    },
    outside: edge ? (x, y) => !inArea(x, y, edge) : null,
    kindOf: (id) => skins?.get(id)?.kind,
    ground: (x, y) => heightAt(terrain, x, y),
    // A map's own doodad data that can't be read may make a type float: heights stay then. Whether one floats
    // goes by the skin it is drawn as (LWw0 drawn as the lily pad NWfp floats: SnowareBay, doodad-open-z), its
    // sample radius by its type; one whose radius samples wider than known keeps its height.
    restingZ: scales && skins ? (id, x, y, skinId) => {
      const radius = elevRadiusOf(id);
      if (radius >= ELEVATION_RADIUS_UNKNOWN) return Number.NaN;
      const s = (skinId !== undefined ? skins.get(skinId) : undefined) ?? skinById(id);
      return doodadGround(terrain, x, y, s?.kind === "w3d" && !!s.floats, radius);
    } : undefined,
  };
}

/** What the rules changed in lists as stored: doodads put on their grid and facing, doodads given the World Editor's
 *  scale, flags, life or height, units given its facings. */
export interface OpenRulesCount { snapped: number; fixed: number; units: number }

/** Applies the rules on opening to the doodads and units as stored, in place: Snap Doodads on Load (`snap`: grids,
 *  facings, the units' facings), then Fix Doodads on Load (`fix`). A doodad the snap moved gets the outside flag from
 *  the playable area (with the fix the solid flag too), as the terrain view's save gives it (settleMoved). */
export function rulesAsOpened(doodads: Placed[], units: Placed[], src: OpenRuleSource, rules: { snap: boolean; fix: boolean }, random?: () => number): OpenRulesCount {
  const moved = new Set<Placed>();
  const snapped = rules.snap ? snapAsOpened(doodads, src, (e) => moved.add(e)) : 0;
  const outside = src.outside;
  if (outside) {
    const flagsFor = rules.fix ? savedFlags : borderFlags;
    for (const p of moved) {
      const e = p as Placed & { flags?: number };
      if (typeof e.flags === "number") e.flags = flagsFor(e.flags, outside(p.position[0], p.position[1]));
    }
  }
  const fixed = rules.fix ? fixAsOpened(doodads, src, random) : 0;
  const unitCount = rules.snap ? unitAnglesAsOpened(units) : 0;
  return { snapped, fixed, units: unitCount };
}

/** The text of a placement file as stored (its JSON, or the raw file decoded); null when there is none. One that is
 *  there but can't be read throws. */
async function storedText(w3: W3Api, root: string, name: string): Promise<string | null> {
  const lower = `map/${name}`.toLowerCase();
  const find = (p: string) => w3.workspace.files().find((f) => f.path.toLowerCase() === p)?.path ?? null;
  const json = find(`${lower}.json`), raw = find(lower);
  try {
    if (json) return `json:${await w3.workspace.readText(json)}`;
    if (raw) return `raw:${await w3.backend.invoke<string>("codec_decode", { root, path: raw })}`;
  } catch (e) {
    if (isNotFoundError(e)) return null;
    throw e;
  }
  return null;
}

/** What applying the rules to a project's files did. `doodadsBefore`: the doodads as stored before (for the shadows'
 *  update), when war3map.doo was written. `notes`: what was left alone and why. */
export interface ProjectOpenRules extends OpenRulesCount { doodadsBefore: Placed[] | null; unitsWritten: boolean; notes: string[] }

/** The parts of the app the rules read through; tests give their own. */
export interface OpenRulesIo {
  /** The types and the map's object data (projectfiles.ts mapObjectData: `unread` are its files that can't be read). */
  objects(): Promise<{ skins: Map<string, Skin>; bases: Map<string, string>; unread: string[] }>;
  pathing(bases: ReadonlyMap<string, string>): Promise<PathingData>;
}

const appIo = (w3: W3Api): OpenRulesIo => ({
  objects: async () => {
    const [skins, { bases, art, unread }] = await Promise.all([loadSkins(w3), mapObjectData(w3)]);
    return { skins: withObjectArt(skins, art), bases, unread };
  },
  // A project's file (an import) before the game's, as the terrain view reads them.
  pathing: (bases) => loadPathingData(w3, (p) => readFile(w3, { path: "map/war3map.w3e" }, p), (id) => bases.get(id)),
});

/** Snap and Fix Doodads on Load (as `rules` has them) on the placement files of the open project as stored, written
 *  back where they change, only over the file they were read from (one written meanwhile is left: whoever wrote it
 *  goes by the rules too) and only while project `root` is open. A file that is there but can't be read is left as it
 *  is (said in `notes`); so is everything when the terrain or the types can't be read. */
export async function applyOpenRulesToProject(w3: W3Api, root: string, rules: { snap: boolean; fix: boolean },
  io: OpenRulesIo = appIo(w3)): Promise<ProjectOpenRules> {
  const done: ProjectOpenRules = { snapped: 0, fixed: 0, units: 0, doodadsBefore: null, unitsWritten: false, notes: [] };
  const still = () => w3.workspace.project()?.root === root;
  if (!rules.snap && !rules.fix) return done;
  const path = terrainPath(w3.workspace.files().map((f) => f.path));
  if (!path) return done;
  const [dooText, unitsText] = await Promise.all([
    storedText(w3, root, "war3map.doo").catch((e) => { done.notes.push(`war3map.doo can't be read (${errText(e)}): its doodads are left as they are`); return undefined; }),
    rules.snap ? storedText(w3, root, "war3mapUnits.doo").catch((e) => { done.notes.push(`war3mapUnits.doo can't be read (${errText(e)}): its facings are left as they are`); return undefined; }) : null,
  ]);
  if (!dooText && !unitsText) return done;
  const load = async (name: string, key: "doodads" | "units", text: string | null | undefined): Promise<PlacedFile | null> => {
    if (!text) return null;
    try { return await loadPlacedFile(w3, name, key); } catch (e) { done.notes.push(`${name} can't be read (${errText(e)}): left as it is`); return null; }
  };
  let terrain: Terrain;
  try {
    terrain = parseW3e(await readTerrainBytes(path, { readText: () => w3.workspace.readText(path), readBytes: () => w3.workspace.readBytes(path) }));
  } catch (e) {
    done.notes.push(`the terrain can't be read (${errText(e)}): the doodads are left as they are`);
    return done;
  }
  const [df, uf] = await Promise.all([load("war3map.doo", "doodads", dooText), load("war3mapUnits.doo", "units", unitsText)]);
  if (!still() || (!df && !uf)) return done;
  const doodads = df?.list ?? [];
  const before = structuredClone(doodads);
  let objects: Awaited<ReturnType<OpenRulesIo["objects"]>>;
  try {
    objects = await io.objects();
  } catch (e) {
    done.notes.push(`the object types can't be read (${errText(e)}): the doodads are left as they are`);
    return done;
  }
  const scales = !objects.unread.some((p) => /\.w3[bd]\.json$/i.test(p));
  // Each doodad type's pathing texture (doodadgrid.ts snapSize); a type whose texture can't be read has none here.
  const sizes = new Map<string, PathSize | null>();
  if (rules.snap && doodads.length) {
    try {
      const data = await io.pathing(objects.bases);
      await Promise.all([...new Set(doodads.map((p) => p.id))].map(async (id) => {
        const info = data.placedTex(id);
        sizes.set(id, info?.path ? snapSize(await data.placedImage(info)) : null);
      }));
    } catch (e) {
      done.notes.push(`the pathing data can't be read (${errText(e)}): the doodads aren't put on their grids`);
      return done;
    }
  }
  const info = await readMapDoc<{ cameraComplements?: number[] }>(w3, "map/war3map.w3i.json").catch(() => null);
  if (!info && rules.fix) done.notes.push("the map's w3i can't be read: the doodads' flags are kept");
  if (!scales && rules.fix) done.notes.push("the map's doodad or destructable data can't be read: the doodads' scales are kept");
  if (!still()) return done;
  const src = openRuleSourceOf({ terrain, skins: objects.skins, bases: objects.bases, sizeOf: (id) => sizes.get(id) ?? null, fixedRotKnown: scales, scales, edge: info ? playableArea(info, terrain) : null });
  const count = rulesAsOpened(doodads, uf?.list ?? [], src, rules);
  // Written only over the file the rules were applied to, and only into this project.
  const write = async (f: PlacedFile | null, was: string | null | undefined, changed: boolean): Promise<boolean> => {
    if (!f || !changed || !still()) return false;
    const now = await storedText(w3, root, f.name).catch(() => undefined);
    if (now !== was || !still()) { done.notes.push(`${f.name} was written meanwhile: left as that write has it`); return false; }
    await savePlacedFile(w3, f);
    return true;
  };
  if (await write(df, dooText, count.snapped + count.fixed > 0)) {
    done.snapped = count.snapped;
    done.fixed = count.fixed;
    done.doodadsBefore = before;
  }
  if (await write(uf, unitsText, count.units > 0)) {
    done.units = count.units;
    done.unitsWritten = true;
  }
  return done;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
