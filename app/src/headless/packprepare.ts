// What `w3proj pack` does to a project's placed objects before it packs, by the app's own code, as the app's Pack Map
// does (map-project prepare): Snap and Fix Doodads on Load on the placement files as stored (terrain-viewer
// openrules.ts, the units' facings among them), pathing, shadows and the minimap after doodads that moved, and the
// destructables' flag "placed by the game" as the map's script has it (map-script followFlags). The CLI (crates/cli
// rebuild.rs prepare_for_pack) records what the derived files follow afterwards.

import { headless, type Message } from "./host";
import type { ExtensionManifest } from "../extensions/api";
import { TERRAIN_SERVICE, type TerrainToolGroup } from "../extensions/services";
import { terrainPath } from "../lib/terrain/w3etext";
import { deriveFromProject } from "../builtin/terrain-viewer/derive";
import { applyOpenRulesToProject } from "../builtin/terrain-viewer/openrules";
import { readFile, savedObjects } from "../builtin/terrain-viewer/projectfiles";
import { SWITCH_DEFAULTS, switchedOn } from "../builtin/terrain-viewer/switches";
import * as pathingExtension from "../builtin/terrain-pathing/index";
import * as scriptExtension from "../builtin/map-script/index";
import terrainManifest from "../builtin/terrain-viewer/extension.json";
import pathingManifest from "../builtin/terrain-pathing/extension.json";
import scriptManifest from "../builtin/map-script/extension.json";

export interface PackPrepareJob {
  root: string;
  settings: Record<string, unknown>;
}

export interface PackPrepareReport {
  /** Doodads put on their grid and facing, doodads given the World Editor's scale, flags, life or height, units given
   *  its facings. */
  snapped: number;
  fixed: number;
  units: number;
  /** The project files of the placed objects that changed (the rules, or the flags that follow the script). */
  changed: string[];
  /** What was left alone and why. */
  notes: string[];
  /** Why pathing, shadows or the minimap couldn't be made again after doodads that moved; absent when they were, or
   *  nothing moved. */
  derivedFailed?: string;
  messages: Message[];
}

const PLACED = ["map/war3map.doo.json", "map/war3map.doo", "map/war3mapUnits.doo.json", "map/war3mapUnits.doo"];
const text = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function packPrepare(job: PackPrepareJob): Promise<PackPrepareReport> {
  const h = headless([terrainManifest, pathingManifest, scriptManifest] as ExtensionManifest[], { ...job.settings, "script.generateOnSave": true });
  const { w3, workspace, messages } = h;
  await workspace.open(job.root);
  const listed = (p: string) => w3.workspace.files().find((f) => f.path.toLowerCase() === p.toLowerCase())?.path;
  const placed = async () => new Map(await Promise.all(PLACED.map(async (p) => {
    const at = listed(p);
    return [p, at ? await w3.workspace.readBytes(at) : null] as const;
  })));
  const before = await placed();
  const rules = {
    snap: switchedOn(w3, "terrain.doodads.snapOnLoad", SWITCH_DEFAULTS["terrain.doodads.snapOnLoad"]),
    fix: switchedOn(w3, "terrain.doodads.fixOnLoad", SWITCH_DEFAULTS["terrain.doodads.fixOnLoad"]),
  };
  const done = await applyOpenRulesToProject(w3, w3.workspace.project()!.root, rules);
  let derivedFailed: string | undefined;
  const terrain = terrainPath(w3.workspace.files().map((f) => f.path));
  if (done.doodadsBefore && terrain) {
    const groups: TerrainToolGroup[] = [];
    w3.services.provide(TERRAIN_SERVICE, { registerToolGroup: (g: TerrainToolGroup) => { groups.push(g); return { dispose() {} }; } });
    await h.activate(pathingManifest.id, pathingExtension);
    await Promise.resolve();
    const from = messages.length;
    try {
      await deriveFromProject(w3, { terrainPath: terrain, from: { doodads: done.doodadsBefore }, objects: () => savedObjects(w3), read: (p) => readFile(w3, { path: terrain }, p), groups, stillOpen: () => true });
    } catch (e) {
      derivedFailed = text(e);
    }
    derivedFailed ??= messages.slice(from).filter((m) => m.severity === "error").map((m) => m.text).join(" ") || undefined;
  }
  // The destructables' flags follow the script on disk, when it is the one the map's data makes.
  try {
    await h.activate(scriptManifest.id, scriptExtension);
    await w3.commands.execute("w3.script.followFlags");
  } catch (e) {
    done.notes.push(`the destructables' flags weren't looked at: ${text(e)}`);
  }
  await workspace.refresh();
  const after = await placed();
  const differs = (a: Uint8Array | null, b: Uint8Array | null) => !(a === b || (!!a && !!b && a.length === b.length && a.every((v, i) => v === b[i])));
  return {
    snapped: done.snapped, fixed: done.fixed, units: done.units, notes: done.notes, derivedFailed, messages,
    changed: PLACED.filter((p) => differs(before.get(p) ?? null, after.get(p) ?? null)),
  };
}
