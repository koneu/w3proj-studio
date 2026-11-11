// Gathers the minimap inputs (see minimap.ts) from the project and the game
// and encodes war3mapMap.blp.

import type { W3Api } from "../../extensions/api";
import { encodeBlp1Jpeg } from "../../lib/image/encode";
import { decodeImage, type DecodedImage } from "../../lib/image/index.ts";
import { parseIni, parseSlk } from "../../lib/formats/text";
import { MINIMAP_SIZE, renderMinimap, type MinimapInput, type MinimapParams, type Rgb } from "./minimap";
import type { Placed } from "./objects";
import { objectMods, pathOverrides, readMapJson } from "./pathmap";
import { loadKind } from "../../lib/objects/metadata";
import { minimapIcons, type MinimapIcon } from "../../lib/terrain/minimapicons";
import { maxPlayers } from "../../lib/terrain/startlocations";
import { ModeCache } from "../../lib/modecache";
import type { Terrain } from "../../lib/terrain/w3e";

/** Colour of a ground tile's or cliff's texture (smallestMipColor), by graphics mode and tile or cliff id (textures
 *  are shared; the modes have their own). */
const tileColors = new ModeCache<Rgb | null>();

/** The colour the World Editor's minimap gives a texture: its smallest mip level as the file stores it (1×1 in a
 *  full chain, which is not the plain average of the full-size picture), averaged by alpha where it is bigger; null
 *  when it is all transparent. */
export function smallestMipColor(image: DecodedImage): Rgb | null {
  const mip = image.mip(image.mipCount - 1);
  const sum = [0, 0, 0];
  let weight = 0;
  for (let i = 0; i < mip.width * mip.height; i++) {
    const a = mip.rgba[i * 4 + 3];
    for (let k = 0; k < 3; k++) sum[k] += mip.rgba[i * 4 + k] * a;
    weight += a;
  }
  return weight > 0 ? sum.map((s) => s / weight) as Rgb : null;
}

/** The graphics mode set (game.graphicsMode), which the game's files are read in. */
export const graphicsMode = (w3: W3Api) => w3.settings.get<string>("game.graphicsMode") ?? "hd";

/** The minimap parameters from the settings (terrain.minimap.*). */
export function minimapSettings(w3: W3Api): Partial<MinimapParams> {
  const cfg = <T,>(key: string) => w3.settings.get<T>(`terrain.minimap.${key}`);
  return {
    groundBrightness: cfg<number>("groundBrightness"),
    groundNoise: cfg<number>("groundNoise"),
    waterShallowColor: cfg<Rgb>("waterShallowColor"),
    waterDeepColor: cfg<Rgb>("waterDeepColor"),
    waterOpacityShallow: cfg<number>("waterOpacityShallow"),
    waterOpacityDeep: cfg<number>("waterOpacityDeep"),
    waterFullDepth: cfg<number>("waterFullDepth"),
    objectRadius: cfg<number>("objectRadius"),
    blurPasses: cfg<number>("blurPasses"),
  };
}

export async function buildMinimap(w3: W3Api, terrain: Terrain, doodads: Placed[],
  readFile: (path: string) => Promise<Uint8Array>, params?: Partial<MinimapParams>, quality = 80): Promise<Uint8Array> {
  const rgba = renderMinimap({ ...await minimapBase(w3, terrain, doodads, readFile), params });
  return encodeBlp1Jpeg(MINIMAP_SIZE, MINIMAP_SIZE, rgba, quality);
}

/** What every minimap picture is made of: the camera margins, the ground tiles' and the water's colours, and the
 *  doodads and destructables shown on the minimap. */
export async function minimapBase(w3: W3Api, terrain: Terrain, doodads: Placed[],
  readFile: (path: string) => Promise<Uint8Array>): Promise<Omit<MinimapInput, "params">> {
  const w3i = await readMapJson<{ cameraComplements?: number[] }>(w3, "war3map.w3i").catch(() => null);
  const m = w3i?.cameraComplements ?? [0, 0, 0, 0];

  /** A texture's colour, null when there is none or it can't be read. */
  const textureColor = (key: string, path: string | null) => (path ? tileColors.get(() => graphicsMode(w3), key, () => (async () =>
    smallestMipColor(decodeImage(await readFile(path), path)))().catch(() => null)) : Promise.resolve(null));
  const tileRows = new Map(parseSlk(await w3.game.readText("TerrainArt\\Terrain.slk")).map((r) => [r.tileID, r]));
  const colors = new Map<string, Rgb>();
  for (const id of terrain.groundTiles) {
    const row = tileRows.get(id);
    colors.set(id, await textureColor(id, row ? `${row.dir}\\${row.file}.blp` : null) ?? [128, 128, 128]);
  }
  // A cliff whose colour isn't known shows its ground's.
  const cliffRows = new Map(parseSlk(await w3.game.readText("TerrainArt\\CliffTypes.slk")).map((r) => [r.cliffID, r]));
  const cliffColors = new Map<string, Rgb | null>();
  for (const id of terrain.cliffTiles) {
    const row = cliffRows.get(id);
    cliffColors.set(id, await textureColor(`cliff:${id}`, row ? `${row.texDir}\\${row.texFile}.blp` : null));
  }

  const water = parseSlk(await w3.game.readText("TerrainArt\\Water.slk"));
  const wrow = water.find((r) => r.waterID === `${terrain.tileset}Sha`) ?? water.find((r) => r.waterID === "LSha");
  const waterColor: Rgb = wrow ? [Number(wrow.mmRed), Number(wrow.mmGreen), Number(wrow.mmBlue)] : [0, 0, 192];

  // Doodads and destructables with their own minimap colour.
  const rows = new Map([
    ...parseSlk(await w3.game.readText("Doodads\\Doodads.slk")).map((r) => [r.doodID, r] as const),
    ...parseSlk(await w3.game.readText("Units\\DestructableData.slk")).map((r) => [r.DestructableID, r] as const),
  ]);
  const bases = new Map([...await pathOverrides(w3, "war3map.w3d", "dptx"), ...await pathOverrides(w3, "war3map.w3b", "bptx")]);
  const objects: { x: number; y: number; rgb: Rgb }[] = [];
  for (const d of doodads) {
    const r = rows.get(d.id) ?? rows.get(bases.get(d.id)?.base ?? "");
    if (r?.showInMM === "1" && r.useMMColor === "1") objects.push({ x: d.position[0], y: d.position[1], rgb: [Number(r.MMRed), Number(r.MMGreen), Number(r.MMBlue)] });
  }

  return {
    terrain, margins: [m[0], m[1], m[2], m[3]], waterColor, objects,
    tileColor: (id) => colors.get(id) ?? [128, 128, 128],
    cliffColor: (id) => cliffColors.get(id) ?? null,
  };
}

/** WorldEditData.txt's keys for the preview icons: gold mine, neutral building, start location. */
const ICON_KEYS = ["minimapicongold", "minimapiconneutralbuilding", "minimapiconstartloc"];
const ICON_FALLBACK = ["UI\\MiniMap\\MinimapIcon\\MinimapIconGold.blp", "UI\\MiniMap\\MinimapIcon\\MinimapIconNeutralBuilding.blp", "UI\\MiniMap\\MinimapIcon\\MinimapIconStartLoc.blp"];

/** A preview icon's picture (a map's own import first, through `readFile`), or null when it can't be read. The
 *  game stores some of them only as .dds. */
export async function minimapIconImage(w3: W3Api, type: 0 | 1 | 2, readFile: (path: string) => Promise<Uint8Array>): Promise<{ width: number; height: number; rgba: Uint8Array } | null> {
  const data = parseIni(await w3.game.readText("UI\\WorldEditData.txt").catch(() => ""));
  const art = [...data].find(([s]) => s.toLowerCase() === "worldeditart")?.[1];
  const path = art?.get(ICON_KEYS[type]) ?? ICON_FALLBACK[type];
  for (const p of [path, path.replace(/\.blp$/i, ".dds")]) {
    try {
      const mip = decodeImage(await readFile(p), p).mip(0);
      return { width: mip.width, height: mip.height, rgba: Uint8Array.from(mip.rgba) };
    } catch { /* the next name */ }
  }
  return null;
}

const PLAYABLE_RACES =new Set(["human", "orc", "undead", "nightelf"]);
const GOLD_MINE_ABILITIES = ["Agld", "Abgm", "Aegm"];

/** The minimap icons (war3map.mmp) of the placed units, by the rules in lib/terrain/minimapicons
 *  with the game's unit data and the map's object data (and skin) changes. */
export async function buildMinimapIcons(w3: W3Api, terrain: Terrain, units: Placed[]): Promise<MinimapIcon[]> {
  const w3i = await readMapJson<{ version: number; cameraComplements?: number[] }>(w3, "war3map.w3i");
  const area = { width: terrain.width, height: terrain.height, offsetX: terrain.offsetX, offsetY: terrain.offsetY, margins: w3i?.cameraComplements ?? [0, 0, 0, 0] };
  return minimapIcons(area, units, await iconKinds(w3, w3i));
}

/** Which minimap icon a placed unit gets (0 gold mine, 1 neutral building, null none; start locations are told
 *  apart by their id), by the rules in lib/terrain/minimapicons. `w3i`: the map info, read if not given. */
export async function iconKinds(w3: W3Api, w3i?: { version: number } | null): Promise<(u: { id: string; player?: number }) => 0 | 1 | null> {
  w3i ??= await readMapJson<{ version: number }>(w3, "war3map.w3i").catch(() => null);
  const kind = await loadKind(w3, "w3u");
  const mods = new Map([...await objectMods(w3, "war3map.w3u"), ...await objectMods(w3, "war3mapSkin.w3u")]);
  const base = (id: string) => mods.get(id)?.base ?? id;
  const value = (id: string, field: string): string => {
    const own = mods.get(id)?.mods.get(field);
    if (own !== undefined) return String(own);
    const f = kind.fieldById.get(field);
    return (f && kind.defaultValue(base(id), f, 0)) ?? "";
  };
  const ability = kind.fieldById.get("uabi");
  // Neutral Passive: player 15 before 24 players (w3i version 31), else 27.
  const neutralPassive = maxPlayers({ version: w3i?.version ?? 31 }) + 3;
  return (u) => {
    const abilities = ability ? kind.defaultValue(base(u.id), ability, 0) ?? "" : "";
    if (GOLD_MINE_ABILITIES.some((a) => abilities.split(",").includes(a))) return 0;
    if (u.player === neutralPassive && value(u.id, "unbm") === "1" && !PLAYABLE_RACES.has(value(u.id, "urac"))) return 1;
    return null;
  };
}
