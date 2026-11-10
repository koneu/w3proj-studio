// The files derived from the terrain and its doodads: pathing (war3map.wpm), shadows (war3map.shd), the
// minimap (war3mapMap.blp) and its icons (war3map.mmp). The open terrain editor writes them from what it has
// loaded; with no editor open, a rebuild reads the project's files instead (`deriveFromProject`), so a tab the
// person closed stays closed.

import type { W3Api } from "../../extensions/api";
import type { TerrainToolGroup } from "../../extensions/services";
import { parseW3e, type Terrain } from "../../lib/terrain/w3e";
import { readTerrainBytes } from "../../lib/terrain/w3etext";
import { sameIcons, type MinimapIcon } from "../../lib/terrain/minimapicons";
import { buildMinimap, buildMinimapIcons, graphicsMode, minimapSettings } from "./minimapgen";
import { buildPathingMap, readMapJson } from "./pathmap";
import { predictShadows } from "./shadowmap";
import { updateShadows } from "./shadows";
import { loadPlacedFile } from "./placement";
import type { Placed, loadSkins } from "./objects";

export type Skins = Awaited<ReturnType<typeof loadSkins>>;

/** Edits a JSON-backed map file in either project form; `change` returning false skips the write. */
export async function editMapDoc(w3: W3Api, name: string, change: (d: Record<string, unknown>) => void | boolean) {
  const root = w3.workspace.project()!.root, path = `map/${name}`;
  const json = await w3.workspace.readText(`${path}.json`).catch(() => null);
  const raw = json === null ? await w3.backend.invoke<string>("codec_decode", { root, path }).catch(() => null) : null;
  if (json === null && raw === null) return;
  const d = JSON.parse((json ?? raw)!) as Record<string, unknown>;
  if (change(d) === false) return;
  if (json !== null) await w3.workspace.writeText(`${path}.json`, await w3.backend.invoke<string>("codec_canonicalize", { root, path: `${path}.json`, text: JSON.stringify(d) }));
  else await w3.backend.invoke("codec_write", { root, path, text: JSON.stringify(d) });
}

/** The minimap icons (war3map.mmp) of the placed units on a terrain, written only when they
 *  differ from the stored ones by more than order and rounding. */
export async function updateMinimapIcons(w3: W3Api, t: Terrain, units: Placed[]) {
  try {
    const icons = await buildMinimapIcons(w3, t, units);
    const stored = await readMapJson<{ icons?: MinimapIcon[] }>(w3, "war3map.mmp").catch(() => null);
    if (!stored) {
      const text = JSON.stringify({ format: "w3proj.minimap/1", version: 0, icons });
      const root = w3.workspace.project()!.root;
      await w3.workspace.writeText("map/war3map.mmp.json", await w3.backend.invoke<string>("codec_canonicalize", { root, path: "map/war3map.mmp.json", text }));
    } else if (!sameIcons(icons, stored.icons ?? [])) {
      await editMapDoc(w3, "war3map.mmp", (d) => { d.icons = icons; });
    }
  } catch (e) {
    w3.window.showError(`The minimap icons (war3map.mmp) couldn't be updated: ${(e as Error).message ?? e}`);
  }
}

export interface DeriveSources {
  /** The terrain and doodads to derive from. */
  now: Terrain;
  doodads: Placed[];
  /** What the stored shadow map was made from: only cells whose prediction changed since are updated. */
  baseTerrain: Terrain;
  baseDoodads: Placed[];
  /** The placed units, for the minimap icons; null when the map has no units file (no icons are written). */
  units: Placed[] | null;
  skins: Skins;
  baseOf: (id: string) => string | undefined;
  /** A game file or the map's import of it. */
  read: (path: string) => Promise<Uint8Array>;
  /** The tool groups' changes to the generated pathing map (manual overrides). */
  filterPathing: (wpm: Uint8Array) => void | Promise<void>;
  /** Something changed since the minimap was last drawn. */
  minimapStale: boolean;
  /** The minimap was written. */
  minimapWritten?: () => void;
  /** False once the project the files are for was closed: nothing more is written. */
  stillOpen?: () => boolean;
}

/** Writes pathing, shadows and the minimap as the settings ask; each failure is shown and the others go on. */
export async function writeDerived(w3: W3Api, s: DeriveSources) {
  const cfg = <T,>(key: string) => w3.settings.get<T>(`terrain.${key}`);
  const gone = () => s.stillOpen?.() === false;
  if (cfg<boolean>("pathing.regenerate")) try {
    const { wpm, missing } = await buildPathingMap(w3, s.now, s.doodads, s.read, cfg<number>("pathing.deepWater"));
    await s.filterPathing(wpm);
    if (gone()) return;
    await w3.workspace.writeBytes("map/war3map.wpm", wpm);
    if (missing.length) w3.window.showWarning(`Pathing map: no pathing texture for ${missing.join(", ")}; those doodads don't block.`);
  } catch (e) {
    w3.window.showError(`The pathing map (war3map.wpm) couldn't be regenerated: ${(e as Error).message ?? e}`);
  }
  // Shadows: only cells whose prediction changed since the last save.
  if (cfg<boolean>("shadows.update")) try {
    const sun = { azimuth: cfg<number>("shadows.sunAzimuth"), elevation: cfg<number>("shadows.sunElevation") };
    const before = await predictShadows(s.baseTerrain, s.baseDoodads, s.skins, s.baseOf, s.read, sun, undefined, () => graphicsMode(w3));
    const after = await predictShadows(s.now, s.doodads, s.skins, s.baseOf, s.read, sun, undefined, () => graphicsMode(w3));
    const stored = await w3.workspace.readBytes("map/war3map.shd").catch(() => null);
    const shd = updateShadows(stored, before, after);
    if (gone()) return;
    if (!stored || shd.some((v, i) => v !== stored[i])) await w3.workspace.writeBytes("map/war3map.shd", shd);
  } catch (e) {
    w3.window.showError(`The shadow map (war3map.shd) couldn't be updated: ${(e as Error).message ?? e}`);
  }
  // The minimap is redrawn when something changed since the last save (by default).
  const minimapMode = cfg<string>("minimap.regenerate");
  if (minimapMode === "always" || (minimapMode !== "never" && s.minimapStale)) {
    try {
      const blp = await buildMinimap(w3, s.now, s.doodads, s.read, minimapSettings(w3), cfg<number>("minimap.jpegQuality"));
      if (gone()) return;
      await w3.workspace.writeBytes("map/war3mapMap.blp", blp);
      s.minimapWritten?.();
    } catch (e) {
      w3.window.showError(`The minimap (war3mapMap.blp) couldn't be regenerated: ${(e as Error).message ?? e}`);
    }
  }
  // Its icons (gold mines, neutral buildings, start locations) follow the placed units;
  // written only when they differ from the stored ones by more than order and rounding.
  if (minimapMode !== "never" && s.units && !gone()) await updateMinimapIcons(w3, s.now, s.units);
}

/** Calculate Shadows (the World Editor's Calculate Shadows and Save Map): war3map.shd made again in whole from the
 *  project's saved terrain and doodads, not only where edits changed it, with the sun of the settings. `stored` is the
 *  file as it is (null when absent; unreadable is an error: the caller decides about writing over it). */
export async function fullShadows(w3: W3Api, opts: {
  terrainPath: string;
  objects: () => Promise<{ skins: Skins; baseOf: (id: string) => string | undefined }>;
  read: (path: string) => Promise<Uint8Array>;
}): Promise<{ shd: Uint8Array; stored: Uint8Array | null }> {
  const path = opts.terrainPath;
  const now = parseW3e(await readTerrainBytes(path, { readText: () => w3.workspace.readText(path), readBytes: () => w3.workspace.readBytes(path) }));
  // A doodads file that's there but can't be read stops it: shadows without its trees would be written over good ones.
  const [dooFile, objects] = await Promise.all([loadPlacedFile(w3, "war3map.doo", "doodads"), opts.objects()]);
  const cfg = <T,>(key: string) => w3.settings.get<T>(`terrain.${key}`);
  const sun = { azimuth: cfg<number>("shadows.sunAzimuth"), elevation: cfg<number>("shadows.sunElevation") };
  const shd = await predictShadows(now, dooFile?.list ?? [], objects.skins, objects.baseOf, opts.read, sun, undefined, () => graphicsMode(w3));
  const listed = w3.workspace.files().some((f) => f.path.toLowerCase() === "map/war3map.shd");
  const stored = listed ? await w3.workspace.readBytes("map/war3map.shd") : null;
  return { shd, stored };
}

/** The derived files of a project with no terrain editor open, from its saved files: what a tool's edit
 *  changed is there already. `from` is the state before the edits (shadows are updated from there).
 *  Nothing is opened. Throws when the terrain can't be read; the parts' own failures are shown. */
export async function deriveFromProject(w3: W3Api, opts: {
  terrainPath: string;
  from: { terrain?: Terrain; doodads: Placed[] };
  objects: () => Promise<{ skins: Skins; baseOf: (id: string) => string | undefined }>;
  read: (path: string) => Promise<Uint8Array>;
  groups: TerrainToolGroup[];
  stillOpen: () => boolean;
}) {
  const path = opts.terrainPath;
  const now = parseW3e(await readTerrainBytes(path, { readText: () => w3.workspace.readText(path), readBytes: () => w3.workspace.readBytes(path) }));
  const [dooFile, unitsFile, objects] = await Promise.all([
    // Absent is null; a file that's there but can't be read fails the rebuild, rather than writing a pathing map
    // without its doodads (or icons without its units) over a good one.
    loadPlacedFile(w3, "war3map.doo", "doodads"),
    loadPlacedFile(w3, "war3mapUnits.doo", "units"),
    opts.objects(),
  ]);
  const doodads = dooFile?.list ?? [];
  await writeDerived(w3, {
    now, doodads,
    baseTerrain: opts.from.terrain ?? now,
    baseDoodads: opts.from.doodads,
    units: unitsFile?.list ?? null,
    ...objects,
    read: opts.read,
    filterPathing: async (wpm) => {
      const v = new DataView(wpm.buffer, wpm.byteOffset);
      const w = v.getUint32(8, true), h = v.getUint32(12, true);
      for (const g of opts.groups) await g.filterSavedPathing?.(wpm.subarray(16), w, h);
    },
    // A rebuild follows an edit.
    minimapStale: true,
    stillOpen: opts.stillOpen,
  });
}
