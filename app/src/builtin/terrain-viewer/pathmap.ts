// Gathers what the pathing generator needs from the project and the game:
// map margins (w3i), ground tile rules, and pathing textures of placed
// doodads and walkable destructables (with the map's object data overrides).

import type { W3Api } from "../../extensions/api";
import { decodeImage } from "../../lib/image/index.ts";
import { parseSlk } from "../../lib/formats/text";
import { generatePathing, type PathingStamp, type TileRule } from "../../lib/terrain/pathing";
import type { Placed } from "./objects";
import { parseWaterOffsets, type Terrain } from "../../lib/terrain/w3e";

/** A map file as the format engine's JSON: `map/<name>.json` if the project
 *  keeps it that way, else decoded from the raw file. */
export async function readMapJson<T>(w3: W3Api, name: string): Promise<T | null> {
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

/** Object id → base id and all fields the map sets for it (first value per field). */
export async function objectMods(w3: W3Api, name: string): Promise<Map<string, { base: string; mods: Map<string, unknown> }>> {
  const out = new Map<string, { base: string; mods: Map<string, unknown> }>();
  const file = await readMapJson<ObjectFile>(w3, name).catch(() => null);
  for (const o of [...(file?.original ?? []), ...(file?.custom ?? [])]) {
    const mods = new Map<string, unknown>();
    for (const m of [...(o.mods ?? []), ...(o.sets ?? []).flatMap((s) => s.mods)]) if (!mods.has(m.field)) mods.set(m.field, m.value);
    out.set(o.id ?? o.base, { base: o.base, mods });
  }
  return out;
}

/** Object id → base id and the pathing texture the map sets for it. */
export async function pathOverrides(w3: W3Api, name: string, field: string): Promise<Map<string, { base: string; pathTex?: string }>> {
  const out = new Map<string, { base: string; pathTex?: string }>();
  const file = await readMapJson<ObjectFile>(w3, name).catch(() => null);
  for (const o of [...(file?.original ?? []), ...(file?.custom ?? [])]) {
    const mods = [...(o.mods ?? []), ...(o.sets ?? []).flatMap((s) => s.mods)];
    const tex = mods.find((m) => m.field === field)?.value;
    out.set(o.id ?? o.base, { base: o.base, pathTex: typeof tex === "string" ? tex : undefined });
  }
  return out;
}

export type PathImage = { width: number; height: number; rgba: Uint8ClampedArray };

/** Pathing inputs from the game and the map: margins, tile rules, and the
 *  pathing texture of any doodad/destructable/unit id (map overrides first). */
export interface PathingData {
  margins: [number, number, number, number];
  tileRules: Map<string, TileRule>;
  /** How far below its stored level a tileset's water surface lies (generatePathing's `waterOffset`); undefined for
   *  a tileset the game's water table doesn't have. */
  waterOffset(tileset: string): number | undefined;
  /** Doodad or destructable (`dest`, `walkable` for bridges) pathing texture. `fallback`: the type's own from the
   *  game's table, when the map's object data names another (see placedImage). */
  placedTex(id: string): PlacedTex | null;
  /** The pathing picture of a placed doodad or destructable: its texture, else (the map's object data names a file
   *  that is neither imported nor the game's) its type's own from the game's table, as `fallback` says. `image` null
   *  with neither: then it leaves no pathing, and `missing` names what wasn't found. */
  placedImage(info: PlacedTex): Promise<{ image: PathImage | null; fellBackTo?: string; missing?: string }>;
  /** Units: building pathing texture or collision size (world units). */
  unitShape(id: string): { path?: string; collision: number } | null;
  texture(path: string): Promise<PathImage | null>;
  /** Texture paths that couldn't be read. */
  missing: Set<string>;
}

export interface PlacedTex { path?: string; fallback?: string; dest: boolean; walkable: boolean }

const usable = (p: string | undefined): p is string => !!p && p !== "_" && p !== "-" && p.toLowerCase() !== "none";

export async function loadPathingData(w3: W3Api, readFile: (path: string) => Promise<Uint8Array>,
  unitBase: (id: string) => string | undefined = () => undefined): Promise<PathingData> {
  const w3i = await readMapJson<{ cameraComplements?: number[] }>(w3, "war3map.w3i").catch(() => null);
  const m = w3i?.cameraComplements ?? [0, 0, 0, 0];
  const tileRules = new Map<string, TileRule>();
  for (const r of parseSlk(await w3.game.readText("TerrainArt\\Terrain.slk"))) {
    if (r.tileID) tileRules.set(r.tileID, { walkable: r.walkable !== "0", buildable: r.buildable !== "0", flyable: r.flyable !== "0" });
  }
  // A tileset's water is the row "<letter>Sha"; its height is in tiles (128), negative below the stored level.
  const waterOffsets = parseWaterOffsets(parseSlk(await w3.game.readText("TerrainArt\\Water.slk").catch(() => "")));
  const doodadRows = new Map(parseSlk(await w3.game.readText("Doodads\\Doodads.slk")).map((r) => [r.doodID, r]));
  const destRows = new Map(parseSlk(await w3.game.readText("Units\\DestructableData.slk")).map((r) => [r.DestructableID, r]));
  const unitRows = new Map(parseSlk(await w3.game.readText("Units\\UnitData.slk").catch(() => "")).map((r) => [r.unitID, r]));
  const unitBalance = new Map(parseSlk(await w3.game.readText("Units\\UnitBalance.slk").catch(() => "")).map((r) => [r.unitBalanceID, r]));
  const doodadMods = await pathOverrides(w3, "war3map.w3d", "dptx");
  const destMods = await pathOverrides(w3, "war3map.w3b", "bptx");
  const unitMods = await objectMods(w3, "war3map.w3u");

  const textures = new Map<string, Promise<PathImage | null>>();
  const missing = new Set<string>();
  const texture = (path: string): Promise<PathImage | null> => {
    // The SLKs write some paths with doubled backslashes.
    const p = path.replace(/\\+/g, "\\");
    let t = textures.get(p.toLowerCase());
    if (!t) {
      t = readFile(p).then((b) => decodeImage(b, p).mip(0)).catch(() => { missing.add(p); return null; });
      textures.set(p.toLowerCase(), t);
    }
    return t;
  };
  return {
    margins: [m[0], m[1], m[2], m[3]],
    tileRules,
    waterOffset: (tileset) => waterOffsets.get(tileset),
    missing,
    texture,
    placedTex(id) {
      /** The map's texture, with the type's own as the fallback when they differ. */
      const tex = (own: string | undefined, table: string | undefined) => {
        const path = own ?? table;
        const fallback = own !== undefined && usable(table) && table.toLowerCase() !== own.toLowerCase() ? table : undefined;
        return { path: usable(path) ? path : undefined, ...(fallback && usable(path) ? { fallback } : {}) };
      };
      const destMod = destMods.get(id);
      const dest = destRows.get(id) ?? (destMod && destRows.get(destMod.base));
      if (dest) return { ...tex(destMod?.pathTex, dest.pathTex), dest: true, walkable: dest.walkable === "1" };
      const mod = doodadMods.get(id);
      const row = doodadRows.get(id) ?? (mod && doodadRows.get(mod.base));
      if (!row) return null;
      return { ...tex(mod?.pathTex, row.pathTex), dest: false, walkable: false };
    },
    async placedImage(info) {
      if (!info.path) return { image: null };
      const own = await texture(info.path);
      if (own) return { image: own };
      const other = info.fallback ? await texture(info.fallback) : null;
      return other ? { image: other, fellBackTo: info.fallback } : { image: null, missing: info.path };
    },
    unitShape(id) {
      // The map's own values (collision ucol, pathing texture upat) win over the base unit's.
      const mod = unitMods.get(id);
      const key = unitRows.has(id) ? id : mod?.base ?? unitBase(id) ?? id;
      const row = unitRows.get(key), bal = unitBalance.get(key);
      if (!row && !bal && !mod) return null;
      const path = typeof mod?.mods.get("upat") === "string" ? (mod.mods.get("upat") as string) : row?.pathTex;
      const collision = typeof mod?.mods.get("ucol") === "number" ? (mod.mods.get("ucol") as number) : Number(bal?.collision ?? 16);
      return { path: usable(path) ? path : undefined, collision: collision || 16 };
    },
  };
}

/** war3map.wpm for the terrain and placed doodads. `readFile` reads the
 *  map's imports first, then the game. A texture the map's object data names that can't be read gives way to the
 *  type's own (`fellBack`: that texture → the one used); with neither, it's listed in `missing` (those objects leave
 *  no pathing; the Problems view names the object data field). `specials`: the doodad file's special doodads
 *  (specialsOf), stamped into the ground as the World Editor does on save. */
export async function buildPathingMap(w3: W3Api, terrain: Terrain, doodads: Placed[],
  readFile: (path: string) => Promise<Uint8Array>, deepWater?: number, specials: readonly SpecialDoodad[] = []): Promise<{ wpm: Uint8Array; missing: string[]; fellBack: [string, string][] }> {
  const data = await loadPathingData(w3, readFile);
  const stamps: PathingStamp[] = [];
  const missing = new Set<string>(), fellBack = new Map<string, string>();
  await Promise.all(doodads.map(async (d) => {
    const e = d as Placed & { flags?: number };
    const info = data.placedTex(d.id);
    if (!info?.path) return;
    // Destructables are added by the game at run time, except that walkable
    // ones (bridges) clear the cells they cover. Only solid doodads (flag
    // bit 1) block.
    if (info.dest ? !info.walkable : e.flags !== undefined && !(e.flags & 2)) return;
    const { image: t, fellBackTo, missing: lost } = await data.placedImage(info);
    if (fellBackTo) fellBack.set(info.path, fellBackTo);
    if (lost) missing.add(lost);
    if (t) stamps.push({ x: d.position[0], y: d.position[1], angle: d.angle, width: t.width, height: t.height, rgba: t.rgba, clear: info.dest });
  }));
  // Cliff doodads (caves, collapsed cliffs): the doodad file's second list, placed by tile. Their texture lies with
  // its bottom left on that tile's, unturned.
  for (const sp of specials) {
    const info = data.placedTex(sp.id);
    if (!info?.path || info.dest) continue;
    const { image: t, fellBackTo, missing: lost } = await data.placedImage(info);
    if (fellBackTo) fellBack.set(info.path, fellBackTo);
    if (lost) missing.add(lost);
    if (!t) continue;
    stamps.push({
      x: terrain.offsetX + sp.x * 128 + t.width * 16, y: terrain.offsetY + sp.y * 128 + t.height * 16,
      angle: -Math.PI / 2, width: t.width, height: t.height, rgba: t.rgba, cliffDoodad: true,
    });
  }
  const wpm = generatePathing({ terrain, margins: data.margins, tileRules: data.tileRules, stamps, deepWater, waterOffset: data.waterOffset(terrain.tileset) });
  return { wpm, missing: [...missing], fellBack: [...fellBack] };
}

/** A special doodad (war3map.doo's second list: caves, collapsed cliffs), placed by tile from the map's bottom left. */
export interface SpecialDoodad { id: string; x: number; y: number }

/** The special doodads of a doodad file's JSON (`specials`); malformed entries are left out. */
export function specialsOf(doc: Record<string, unknown> | null | undefined): SpecialDoodad[] {
  const list = doc?.specials;
  if (!Array.isArray(list)) return [];
  return list.filter((s): s is SpecialDoodad => typeof s?.id === "string" && Number.isInteger(s.x) && Number.isInteger(s.y));
}
