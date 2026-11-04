// The map's day/night lighting for the terrain view, as the game picks it: the map's own
// lighting models (war3map.w3l names "<guid>.mdl" files in the map, used when switched on),
// else the game's models for the map's light environment (Map Properties › Environment) or,
// without one, its tileset (WorldEditData [TerrainLights] / [UnitLights]).

import type { W3Api } from "../../extensions/api";
import { parseIni } from "../../lib/formats/text";
import { readLightMdl, readLightMdx, type LightModel } from "../../lib/model/dnclight";

export interface MapLighting {
  terrain: LightModel | null;
  unit: LightModel | null;
  /** Where they come from, for the toolbar's tooltip. */
  source: string;
  /** Map flags (war3map.w3i; 0 without) and the water tint (r, g, b, a in 0–255). */
  flags: number;
  waterTint: number[] | null;
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

export async function loadMapLighting(w3: W3Api, tileset: string): Promise<MapLighting> {
  const [info, lights, data] = await Promise.all([
    readMapDoc<{ lightEnvironment?: string; flags?: number; waterTint?: number[] }>(w3, "war3map.w3i"),
    readMapDoc<Lights>(w3, "war3map.w3l"),
    w3.game.readText("UI\\WorldEditData.txt").then(parseIni).catch(() => null),
  ]);
  const env = (info?.lightEnvironment || tileset).toUpperCase();
  const notes: string[] = [];
  const pick = async (kind: "terrain" | "unit", section: string): Promise<LightModel | null> => {
    const own = lights?.[`${kind}Model`];
    if (own && lights?.[`${kind}Enabled`]) {
      try {
        const m = readLightMdl(await w3.workspace.readText(`map/${own}`));
        notes.push(`${kind}: the map's own (${m.name})`);
        return m;
      } catch { /* the game's */ }
    }
    const entries = data?.get(section);
    const path = entries && [...entries].find(([k]) => k.toUpperCase() === env)?.[1];
    if (!path) return null;
    try {
      const m = readLightMdx(await w3.game.read(path.replace(/\.mdl$/i, ".mdx")));
      notes.push(`${kind}: ${m.name}`);
      return m;
    } catch { return null; }
  };
  const [terrain, unit] = await Promise.all([pick("terrain", "TerrainLights"), pick("unit", "UnitLights")]);
  return {
    terrain, unit, source: notes.join(" · ") || "no lighting found (neutral light)",
    // Without map info (a game map viewed alone): the waves a new map has.
    flags: info?.flags ?? CLIFF_SHORE_WAVES | ROLLING_SHORE_WAVES, waterTint: info?.waterTint ?? null,
  };
}
