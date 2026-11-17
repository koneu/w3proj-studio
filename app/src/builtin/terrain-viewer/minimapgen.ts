// Gathers the minimap inputs (see minimap.ts) from the project and the game
// and encodes war3mapMap.blp.

import type { W3Api } from "../../extensions/api";
import { encodeBlp1Jpeg } from "../../lib/image/encode";
import { decodeImage, type DecodedImage } from "../../lib/image/index.ts";
import { parseIni, parseSlk } from "../../lib/formats/text";
import { parseMdx } from "../../lib/model/mdx";
import { MINIMAP_SIZE, renderMinimap, type MinimapInput, type MinimapObject, type MinimapParams, type PathMask, type Rgb } from "./minimap";
import { loadSkins, modelPath, plainModelPath, type Placed, type Skin } from "./objects";
import { objectMods, pathOverrides, readMapJson } from "./pathmap";
import { loadKind } from "../../lib/objects/metadata";
import { minimapIcons, type MinimapIcon } from "../../lib/terrain/minimapicons";
import { neverStoredLast, textureCandidates } from "../../lib/model/texpath";
import { maxPlayers } from "../../lib/terrain/startlocations";
import { ModeCache } from "../../lib/modecache";
import { drawnGroundTiles, type Terrain } from "../../lib/terrain/w3e";
import { ownGroundTiles } from "../../lib/terrain/tilesets";
import { applyTilesetWater } from "./wateroffset";

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

/** The files a ground, cliff or blight texture's colour is read from, the first that can be: in HD and DE (`mode`
 *  not "sd") its Reforged `_Diffuse` texture, then the plain (classic) one. */
export function hdFirst(path: string, mode: string): string[] {
  return mode === "sd" ? [path] : [path.replace(/\.\w+$/, "_Diffuse.blp"), path];
}

/** Pathing cells along a tile's side (a pathing texture has one pixel per cell). */
const CELLS_PER_TILE = 4;
/** The dot of a doodad with no pathing texture and no model colour (the palisade LSpl): the editor's inner pixels there
 *  average 181.5 on all three channels, its grain taking about 1.5 off a colour. */
const NO_MODEL_RGB: Rgb = [183, 183, 183];

/** `make` once per key: the same promise for every later call. */
function memo<T>(make: (key: string) => Promise<T>): (key: string) => Promise<T> {
  const made = new Map<string, Promise<T>>();
  return (key) => {
    let p = made.get(key);
    if (!p) made.set(key, p = make(key));
    return p;
  };
}

/** The model's texture ids in the order the minimap colour looks at them: the textures its geosets' materials show
 *  first (an ice gate's first texture is a cloud one, for its particles: the editor colours it by the walls' texture,
 *  SnowareBay 2026-11-13), then the others in file order. */
export function textureOrder(model: { textures: readonly unknown[]; geosets: readonly { materialId: number }[]; materials: readonly { layers: readonly { textureIds: readonly number[] }[] }[] }): number[] {
  const shown = model.geosets.flatMap((g) => model.materials[g.materialId]?.layers.map((l) => l.textureIds[0]) ?? []);
  return [...new Set([...shown, ...model.textures.keys()])];
}

/** The mean of the colours of the textures a model's geosets' materials show, once each (`colorOf`: a texture's colour,
 *  null when it has none or can't be read: left out), a team colour texture (replaceable 1 and 2) counting black; null
 *  when none gives a colour. The editor's dot of a goblin shipyard (textures: its own, team colour, a second) is two
 *  thirds of the first texture's colour, a granary's (two textures) the mean of both (we-drive 2026-11-17: dots-more). */
export async function shownTextureMean(model: { textures: readonly { replaceableId: number; path: string }[]; geosets: readonly { materialId: number }[]; materials: readonly { layers: readonly { textureIds: readonly number[] }[] }[] },
  colorOf: (tex: { replaceableId: number; path: string }) => Promise<Rgb | null>): Promise<Rgb | null> {
  const shown = [...new Set(model.geosets.flatMap((g) => model.materials[g.materialId]?.layers.map((l) => l.textureIds[0]) ?? []))];
  const colors: Rgb[] = [];
  for (const id of shown) {
    const tex = model.textures[id];
    if (!tex) continue;
    if (tex.replaceableId === 1 || tex.replaceableId === 2) { colors.push([0, 0, 0]); continue; }
    const c = await colorOf(tex);
    if (c) colors.push(c);
  }
  if (!colors.some((c) => c[0] + c[1] + c[2] > 0)) return null;
  return [0, 1, 2].map((k) => colors.reduce((a, c) => a + c[k], 0) / colors.length) as Rgb;
}

/** The minimap colour of a doodad or destructable without its own (useMMColor 0): the smallest mip colour of its
 *  model's first texture (its replaceable texture, trees' for example, where the model asks for one), null when the
 *  model or texture can't be read. The first variation's model stands for all.
 *  `mean`: for a dot, shownTextureMean's colour when it has one. */
export async function modelTextureColor(skin: Pick<Skin, "file" | "numVar" | "texId" | "texFile">,
  readFile: (path: string) => Promise<Uint8Array>, mean = false): Promise<Rgb | null> {
  let model;
  try {
    model = parseMdx(await readFile(modelPath(skin, 0)));
  } catch {
    const plain = plainModelPath(skin);
    if (!plain) return null;
    try { model = parseMdx(await readFile(plain)); } catch { return null; }
  }
  const pathOf = (tex: { replaceableId: number; path: string }) => tex.replaceableId === 0 ? tex.path
    : tex.replaceableId === skin.texId && skin.texFile ? (/\.\w{3}$/.test(skin.texFile) ? skin.texFile : `${skin.texFile}.blp`) : "";
  /** A texture's colour: null when it has none to read or can't be. HD models name their textures as the artists
   *  exported them (.tif); the game stores those as .dds (texpath.ts). */
  const colorOf = async (path: string): Promise<Rgb | null> => {
    for (const p of neverStoredLast([...new Set([path, ...textureCandidates(path)])])) {
      try { return smallestMipColor(decodeImage(await readFile(p), p)); } catch { /* the next name */ }
    }
    return null;
  };
  if (mean) {
    const m = await shownTextureMean(model, async (tex) => { const path = pathOf(tex); return path ? colorOf(path) : null; });
    if (m) return m;
  }
  for (const id of textureOrder(model)) {
    const tex = model.textures[id];
    const path = tex && pathOf(tex);
    if (!path) continue;
    return colorOf(path);
  }
  return null;
}

/** The doodads and destructables the minimap shows, and how (see minimap.ts): those whose type's row (Doodads.slk,
 *  DestructableData.slk; a custom type's base's) has showInMM, in their row's minimap colour (useMMColor) or else
 *  `modelColor`'s of the type (left out when that is null), in the shape of their pathing texture (the map's object
 *  data's first) turned by their angle when it isn't one full square (`pathMask`), else as big a dot as `footprint`
 *  says the texture is, in tiles (1 without one). */
export async function minimapObjects(doodads: readonly (Pick<Placed, "id" | "position"> & { life?: number; angle?: number })[], tables: {
  rows: ReadonlyMap<string, Record<string, string>>;
  bases: ReadonlyMap<string, { base: string; pathTex?: string }>;
  /** `mean`: the colour of a dot (modelTextureColor), not of a shape drawn from its pathing texture's cells. */
  modelColor: (type: string, mean: boolean) => Promise<Rgb | null>;
  footprint: (pathTex: string) => Promise<number>;
  /** The texture's width and height in cells when it is known (a dot reaches the tiles by them, see dotReach);
   *  left out, `footprint` squared. */
  cells?: (pathTex: string) => Promise<[number, number] | null>;
  /** The cells of a pathing texture, drawn as they are; null (or left out): a dot of its `footprint` size. */
  pathMask?: (pathTex: string) => Promise<PathMask | null>;
}): Promise<MinimapObject[]> {
  const { rows, bases } = tables;
  const objects: MinimapObject[] = [];
  for (const d of doodads) {
    // A destructable placed dead (life 0 %) is mostly left out of the World Editor's minimap: of SnowareBay's 205 dead
    // Northrend tree walls the export shows 77, nearly all on higher ground (ground height 250 and up: 85 %; below
    // 200: 8 %), where the others show nothing at all. What decides it isn't known (2026-11-13), so none are drawn.
    if (d.life === 0) continue;
    const type = rows.has(d.id) ? d.id : bases.get(d.id)?.base ?? "";
    const r = rows.get(type);
    if (r?.showInMM !== "1") continue;
    const pathTex = bases.get(d.id)?.pathTex ?? r.pathTex;
    const file = pathTex && !/^(_|none)$/i.test(pathTex.trim()) ? (/\.\w{3}$/i.test(pathTex) ? pathTex : `${pathTex}.tga`) : "";
    const mask = file ? await tables.pathMask?.(file) : null;
    // Gates, walls and rock spires are drawn as their texture's cells; a texture that is one full square (trees,
    // rocks) stays a dot, which the editor's squares of about that size fit as well (see minimap.ts).
    // A texture that is one full rectangle is a dot of tiles (dotReach, turned by the angle); one with gaps is its cells.
    const shape = !!mask && !mask.cells.every((c) => c);
    // The palisade (no pathing texture, no model colour to read): a grey dot, as the editor draws it (we-drive 2026-11-17).
    const rgb = r.useMMColor === "1" ? [Number(r.MMRed), Number(r.MMGreen), Number(r.MMBlue)] as Rgb : await tables.modelColor(type, !shape) ?? (file ? null : NO_MODEL_RGB);
    if (!rgb) continue;
    if (shape) { objects.push({ x: d.position[0], y: d.position[1], rgb, mask: mask!, angle: d.angle }); continue; }
    const size = file ? await tables.footprint(file) : 1;
    // No pathing texture (a palisade): the one tile it stands in.
    // (The doodad's scale makes no difference: tried on HillsbradCreek, TurtleRock and SnowareBay, 0.8 to 1.2.)
    const cells = file ? await tables.cells?.(file) ?? undefined : [0, 0] as [number, number];
    objects.push({ x: d.position[0], y: d.position[1], rgb, size: file ? size : 0, ...(cells ? { cells } : {}), ...(d.angle !== undefined ? { angle: d.angle } : {}) });
  }
  return objects;
}

/** The graphics mode set (game.graphicsMode), which the game's files are read in. */
export const graphicsMode = (w3: W3Api) => w3.settings.get<string>("game.graphicsMode") ?? "hd";

/** The minimap parameters from the settings (terrain.minimap.*). */
export function minimapSettings(w3: W3Api): Partial<MinimapParams> {
  const cfg = <T,>(key: string) => w3.settings.get<T>(`terrain.minimap.${key}`);
  return {
    groundBrightness: cfg<number>("groundBrightness"),
    groundNoise: cfg<number>("groundNoise"),
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
  await applyTilesetWater(w3, terrain);
  const w3i = await readMapJson<{ cameraComplements?: number[] }>(w3, "war3map.w3i").catch(() => null);
  const m = w3i?.cameraComplements ?? [0, 0, 0, 0];

  /** A texture's colour, null when there is none or it can't be read. In HD and DE the Reforged `_Diffuse` texture
   *  first, as the terrain draws: the World Editor's HD export has its colours (HillsbradCreek's grass 23, 119, 16,
   *  the classic one's 44, 108, 27; we-drive 2026-11-13). */
  const textureColor = (key: string, path: string | null) => (path ? tileColors.get(() => graphicsMode(w3), key, () => (async () => {
    for (const p of hdFirst(path, graphicsMode(w3))) {
      try { return smallestMipColor(decodeImage(await readFile(p), p)); } catch { /* the next */ }
    }
    return null;
  })()) : Promise.resolve(null));
  const terrainSlk = parseSlk(await w3.game.readText("TerrainArt\\Terrain.slk"));
  const tileRows = new Map(terrainSlk.map((r) => [r.tileID, r]));
  // Under "custom tilesets" 0 the slots show the tileset's own tiles, in the World Editor's saved minimap as in its view
  // (we-compare custom-tilesets-0: its minimap of a reversed list has the tileset's order).
  const drawnTiles = drawnGroundTiles(terrain, ownGroundTiles(terrainSlk, terrain.tileset));
  const colors = new Map<string, Rgb>();
  for (const id of new Set(drawnTiles)) {
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

  // The tileset's blight texture (UI\WorldEditData.txt, [TileSets]: name,texture), for Export Minimap's Include Blight.
  const tilesets = parseIni(await w3.game.readText("UI\\WorldEditData.txt").catch(() => "")).get("TileSets");
  const blightPath = tilesets?.get(terrain.tileset.toLowerCase())?.split(",")[1]?.trim();
  const blightColor = await textureColor(`blight:${terrain.tileset}`, blightPath ? `${blightPath}.blp` : null);

  const water = parseSlk(await w3.game.readText("TerrainArt\\Water.slk"));
  const wrow = water.find((r) => r.waterID === `${terrain.tileset}Sha`) ?? water.find((r) => r.waterID === "LSha");
  const waterColor: Rgb = wrow ? [Number(wrow.mmRed), Number(wrow.mmGreen), Number(wrow.mmBlue)] : [0, 0, 192];
  const mmAlpha = Number(wrow?.mmAlpha);
  const waterAlpha = wrow?.mmAlpha && Number.isFinite(mmAlpha) ? Math.min(255, Math.max(0, mmAlpha)) / 255 : undefined;

  // Doodads and destructables shown on the minimap (see minimap.ts).
  const rows = new Map([
    ...parseSlk(await w3.game.readText("Doodads\\Doodads.slk")).map((r) => [r.doodID, r] as const),
    ...parseSlk(await w3.game.readText("Units\\DestructableData.slk")).map((r) => [r.DestructableID, r] as const),
  ]);
  const bases = new Map([...await pathOverrides(w3, "war3map.w3d", "dptx"), ...await pathOverrides(w3, "war3map.w3b", "bptx")]);
  let skins: Promise<Map<string, Skin>> | null = null;
  const colorOf = memo((key: string) => (async () => {
    skins ??= loadSkins(w3);
    const mean = key.startsWith("mean:"), type = key.slice(mean ? 5 : 6);
    const skin = (await skins).get(type);
    return skin ? modelTextureColor(skin, readFile, mean) : null;
  })().catch(() => null));
  const modelColor = (type: string, mean: boolean) => colorOf(`${mean ? "mean" : "first"}:${type}`);
  // A pathing texture is read and decoded once, for its cells and its size alike (null: unreadable).
  const pathImage = memo((path: string) => (async () => decodeImage(await readFile(path), path).mip(0))().catch(() => null));
  const footprint = async (path: string) => {
    const image = await pathImage(path);
    return image ? Math.sqrt(image.width * image.height) / CELLS_PER_TILE : 1;
  };
  const cells = async (path: string): Promise<[number, number] | null> => { const image = await pathImage(path); return image ? [image.width, image.height] : null; };
  const pathMask = memo((path: string) => (async () => {
    const image = await pathImage(path);
    if (!image) return null;
    const cells = new Uint8Array(image.width * image.height);
    for (let i = 0; i < cells.length; i++) cells[i] = image.rgba[i * 4] | image.rgba[i * 4 + 1] | image.rgba[i * 4 + 2] ? 1 : 0;
    return { width: image.width, height: image.height, cells };
  })().catch(() => null));
  const objects = await minimapObjects(doodads, { rows, bases, modelColor, footprint, cells, pathMask });

  return {
    terrain, margins: [m[0], m[1], m[2], m[3]], waterColor, waterAlpha, objects, blightColor, drawnTiles,
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
  for (const p of textureCandidates(path)) {
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
