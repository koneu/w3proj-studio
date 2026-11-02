// Gathers what the pathing generator needs from the project and the game:
// map margins (w3i), ground tile rules, and pathing textures of placed
// doodads and walkable destructables (with the map's object data overrides).

import type { W3Api } from "../../extensions/api";
import { decodeImage } from "../../lib/image/index.ts";
import { parseSlk } from "../../lib/formats/text";
import { generatePathing, type PathingStamp, type TileRule } from "./pathing";
import type { Placed } from "./objects";
import type { Terrain } from "./w3e";

/** A map file as the format engine's JSON: `map/<name>.json` if the project
 *  keeps it that way, else decoded from the raw file. */
async function readMapJson<T>(w3: W3Api, name: string): Promise<T | null> {
  const files = new Set(w3.workspace.files().map((f) => f.path.toLowerCase()));
  const path = `map/${name}`;
  if (files.has(`${path}.json`.toLowerCase())) return JSON.parse(await w3.workspace.readText(`${path}.json`)) as T;
  if (!files.has(path.toLowerCase())) return null;
  return JSON.parse(await w3.backend.invoke<string>("codec_decode", { root: w3.workspace.project()!.root, path })) as T;
}

interface ObjectFile {
  original?: ObjectEntry[];
  custom?: ObjectEntry[];
}
interface ObjectEntry {
  base: string;
  id?: string;
  mods?: { field: string; value: unknown }[];
  sets?: { mods: { field: string; value: unknown }[] }[];
}

/** Object id → base id and the pathing texture the map sets for it. */
async function pathOverrides(w3: W3Api, name: string, field: string): Promise<Map<string, { base: string; pathTex?: string }>> {
  const out = new Map<string, { base: string; pathTex?: string }>();
  const file = await readMapJson<ObjectFile>(w3, name).catch(() => null);
  for (const o of [...(file?.original ?? []), ...(file?.custom ?? [])]) {
    const mods = [...(o.mods ?? []), ...(o.sets ?? []).flatMap((s) => s.mods)];
    const tex = mods.find((m) => m.field === field)?.value;
    out.set(o.id ?? o.base, { base: o.base, pathTex: typeof tex === "string" ? tex : undefined });
  }
  return out;
}

/** war3map.wpm for the terrain and placed doodads. `readFile` reads the
 *  map's imports first, then the game. Textures that can't be read are
 *  listed in `missing` (their objects leave no pathing). */
export async function buildPathingMap(w3: W3Api, terrain: Terrain, doodads: Placed[],
  readFile: (path: string) => Promise<Uint8Array>): Promise<{ wpm: Uint8Array; missing: string[] }> {
  const w3i = await readMapJson<{ cameraComplements?: number[] }>(w3, "war3map.w3i").catch(() => null);
  const m = w3i?.cameraComplements ?? [0, 0, 0, 0];
  const tileRules = new Map<string, TileRule>();
  for (const r of parseSlk(await w3.game.readText("TerrainArt\\Terrain.slk"))) {
    if (r.tileID) tileRules.set(r.tileID, { walkable: r.walkable !== "0", buildable: r.buildable !== "0", flyable: r.flyable !== "0" });
  }
  const doodadRows = new Map(parseSlk(await w3.game.readText("Doodads\\Doodads.slk")).map((r) => [r.doodID, r]));
  const destRows = new Map(parseSlk(await w3.game.readText("Units\\DestructableData.slk")).map((r) => [r.DestructableID, r]));
  const doodadMods = await pathOverrides(w3, "war3map.w3d", "dptx");
  const destMods = await pathOverrides(w3, "war3map.w3b", "bptx");

  const textures = new Map<string, Promise<{ width: number; height: number; rgba: Uint8ClampedArray } | null>>();
  const missing = new Set<string>();
  const texture = (path: string) => {
    // The SLKs write some paths with doubled backslashes.
    const p = path.replace(/\\+/g, "\\");
    let t = textures.get(p.toLowerCase());
    if (!t) {
      t = readFile(p).then((b) => decodeImage(b, p).mip(0)).catch(() => { missing.add(p); return null; });
      textures.set(p.toLowerCase(), t);
    }
    return t;
  };
  const usable = (p: string | undefined) => !!p && p !== "_" && p !== "-" && p.toLowerCase() !== "none";

  const stamps: PathingStamp[] = [];
  await Promise.all(doodads.map(async (d) => {
    const e = d as Placed & { flags?: number };
    // Destructables are added by the game at run time, except that walkable
    // ones (bridges) clear the cells they cover.
    const destMod = destMods.get(d.id);
    const dest = destRows.get(d.id) ?? (destMod && destRows.get(destMod.base));
    let path: string | undefined, clear = false;
    if (dest) {
      if (dest.walkable !== "1") return;
      path = destMod?.pathTex ?? dest.pathTex;
      clear = true;
    } else {
      // Only solid doodads (flag bit 1) block.
      if (e.flags !== undefined && !(e.flags & 2)) return;
      const mod = doodadMods.get(d.id);
      const row = doodadRows.get(d.id) ?? (mod && doodadRows.get(mod.base));
      if (!row) return;
      path = mod?.pathTex ?? row.pathTex;
    }
    if (!usable(path)) return;
    const t = await texture(path!);
    if (t) stamps.push({ x: d.position[0], y: d.position[1], angle: d.angle, width: t.width, height: t.height, rgba: t.rgba, clear });
  }));
  const wpm = generatePathing({ terrain, margins: [m[0], m[1], m[2], m[3]], tileRules, stamps });
  return { wpm, missing: [...missing] };
}
