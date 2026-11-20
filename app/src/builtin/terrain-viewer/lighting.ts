// The map's day/night lighting for the terrain view, as the game picks it: the map's own
// lighting models (war3map.w3l names "<guid>.mdl" files in the map, used when switched on),
// else the game's models for the map's light environment (Map Properties › Environment) or,
// without one, its tileset (WorldEditData [TerrainLights] / [UnitLights]).

import type { W3Api } from "../../extensions/api";
import { parseIni } from "../../lib/formats/text";
import { readLightMdl, readLightMdx, type LightModel } from "../../lib/model/dnclight";
import { hdWaterSettings, type HdWaterSettings } from "./hdwater";

export interface MapLighting {
  terrain: LightModel | null;
  unit: LightModel | null;
  /** Where they come from, for the toolbar's tooltip. */
  source: string;
  /** Whether each is the map's own (war3map.w3l) rather than the game's. */
  own: { terrain: boolean; unit: boolean };
  /** Map flags (war3map.w3i; 0 without) and the water tint as stored (b, g, r, a in 0–255). */
  flags: number;
  waterTint: number[] | null;
  /** The map's HD water settings (war3map.w3i's `water`; the defaults without one). */
  water: HdWaterSettings;
}

/** Map flags for water: tinting, waves (shoreline foam) on cliff shores and on rolling shores. */
export const WATER_TINTING = 0x10000, CLIFF_SHORE_WAVES = 0x0800, ROLLING_SHORE_WAVES = 0x1000;

/** A map file in either project form (JSON, or the raw file decoded by its format definition). */
async function readMapDoc<T>(w3: W3Api, name: string): Promise<T | null> {
  const project = w3.workspace.project();
  if (!project) return null;
  const path = `map/${name}`;
  const json = await w3.workspace.readText(`${path}.json`).catch(() => null);
  if (json !== null) return JSON.parse(json) as T;
  const raw = await w3.backend.invoke<string>("codec_decode", { root: project.root, path }).catch(() => null);
  return raw !== null ? (JSON.parse(raw) as T) : null;
}

interface Lights { terrainModel: string; unitModel: string; terrainEnabled: number; unitEnabled: number }

/** The map's own lighting model file that lights `kind`, or null (that slot off or empty). The codec names war3map.w3l's
 *  slots terrainModel (the first) and unitModel (the second), but the World Editor lights the units by the first and
 *  the ground by the second, as its script hands them to SetDayNightModels (lib/script/setup.ts dayNightModels).
 *  we-drive (branch we-compare-10, 2026-11-19, SD game view, cliff.w3m with the first slot's sun and ambient one colour
 *  and the second's another): the ground took the second's colour, three footmen the first's. On light-slots-*.w3x
 *  (branch we-compare-13, SD and HD, each slot switched off in turn) the same, and the doodads and trees went with the
 *  first, as the units (renderer.ts lightSlotOf; we-compare-10 had read them with the second). */
export function ownLightFile(lights: Partial<Lights> | null | undefined, kind: "terrain" | "unit"): string | null {
  const [file, enabled] = kind === "terrain" ? [lights?.unitModel, lights?.unitEnabled] : [lights?.terrainModel, lights?.terrainEnabled];
  return file && enabled ? file : null;
}

export async function loadMapLighting(w3: W3Api, tileset: string): Promise<MapLighting> {
  const [info, lights, data] = await Promise.all([
    readMapDoc<{ lightEnvironment?: string; flags?: number; waterTint?: number[]; water?: unknown }>(w3, "war3map.w3i"),
    readMapDoc<Lights>(w3, "war3map.w3l"),
    w3.game.readText("UI\\WorldEditData.txt").then(parseIni).catch(() => null),
  ]);
  const env = (info?.lightEnvironment || tileset).toUpperCase();
  const notes: string[] = [];
  const own = { terrain: false, unit: false };
  const pick = async (kind: "terrain" | "unit", section: string): Promise<LightModel | null> => {
    const file = ownLightFile(lights, kind);
    if (file) {
      try {
        const m = readLightMdl(await w3.workspace.readText(`map/${file}`));
        notes.push(`${kind}: the map's own (${m.name})`);
        own[kind] = true;
        return m;
      } catch { /* the game's */ }
    }
    const entries = data?.get(section);
    const path = entries && [...entries].find(([k]) => k.toUpperCase() === env)?.[1];
    if (!path) return null;
    try {
      const m = readLightMdx(await w3.game.read(path.replace(/\.mdl$/i, ".mdx"), { shared: true }));
      notes.push(`${kind}: ${m.name}`);
      return m;
    } catch { return null; }
  };
  const [terrain, unit] = await Promise.all([pick("terrain", "TerrainLights"), pick("unit", "UnitLights")]);
  return {
    terrain, unit, own, source: notes.join(" · ") || "no lighting found (neutral light)",
    // Without map info (a game map viewed alone): the waves a new map has.
    flags: info?.flags ?? CLIFF_SHORE_WAVES | ROLLING_SHORE_WAVES, waterTint: info?.waterTint ?? null,
    water: hdWaterSettings(info?.water),
  };
}
