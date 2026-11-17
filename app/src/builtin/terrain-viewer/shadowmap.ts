// Shadow prediction for a terrain and its doodads (see shadows.ts): terrain
// shadows plus doodad models (opaque and alpha-tested parts). Destructables
// (trees) cast no baked shadows.

import { decodeImage } from "../../lib/image/index.ts";
import { parseMdx } from "../../lib/model/mdx";
import { neverStoredLast, textureCandidates } from "../../lib/model/texpath";
import { ModeCache } from "../../lib/modecache";
import type { loadSkins, Placed } from "./objects";
import { parseSlk } from "../../lib/formats/text";
import { alphaTexturePaths, castShadow, cliffCellHeights, shadowCliffName, shadowCliffVariation, shadowMesh, terrainShadows, terrainShadowsInSteps, type AlphaMap, type CliffCells, type ShadowMesh, type Sun } from "./shadows";
import type { Terrain } from "../../lib/terrain/w3e";

type Skins = Awaited<ReturnType<typeof loadSkins>>;

/** A model that was read and casts nothing (no opaque or alpha-tested faces in its most detailed geosets). */
const NO_FACES = "no casting faces" as const;

/** Casting triangles by graphics mode and model path (shared by all editors; HD and Classic models share paths). */
const meshes = new ModeCache<ShadowMesh | typeof NO_FACES>();

/** Forgets the casting triangles of every model read (the app smoke's way to make a calculation read the game again). */
export function clearShadowMeshes(): void { meshes.clear(); clearCliffHeights(); }

async function alphaMap(path: string, readFile: (path: string) => Promise<Uint8Array>): Promise<AlphaMap | null> {
  // Reforged names .tif/.blp sources the game ships as .dds; a .tif is never there, so last.
  for (const p of neverStoredLast([...new Set([...textureCandidates(path), ...textureCandidates(path.replace(/\.\w+$/, ".blp"))])])) {
    try {
      const mip = decodeImage(await readFile(p), p).mip(0);
      const alpha = new Uint8Array(mip.width * mip.height);
      for (let i = 0; i < alpha.length; i++) alpha[i] = mip.rgba[i * 4 + 3];
      return { width: mip.width, height: mip.height, alpha };
    } catch { /* next variant */ }
  }
  return null;
}

/** A model's casting triangles; NO_FACES when it was read and casts nothing; null when it can't be read. A failed read
 *  isn't kept for the session (the next prediction tries again); within one prediction, or a set of them sharing
 *  `failed`, it's tried once. */
function modelMesh(path: string, readFile: (path: string) => Promise<Uint8Array>, artMode: () => string, failed: Set<string>): Promise<ShadowMesh | typeof NO_FACES | null> {
  const key = `${artMode()}|${path.toLowerCase()}`;
  if (failed.has(key)) return Promise.resolve(null);
  return meshes.get(artMode, path.toLowerCase(), async () => {
    const model = parseMdx(await readFile(path));
    const maps = new Map<string, AlphaMap | null>();
    // Classic art: the editor casts alpha-tested geosets whole, their textures' holes included (we-drive, branch
    // we-shadow-3, SD: LRrk's ten variations and eight turns, 984 cells; whole quads 983 of them and 5 more, with the
    // alpha test 659 and 3 more).
    if (artMode() !== "sd") for (const p of alphaTexturePaths(model)) maps.set(p, await alphaMap(p, readFile));
    return shadowMesh(model, (p) => maps.get(p) ?? null) ?? NO_FACES;
  }).catch(() => { failed.add(key); return null; });
}

/** Cliff models' heights for the shadows (shadows.ts cliffCellHeights) by graphics mode and model path; null when the
 *  model can't be read. CliffTypes.slk's model folders by mode, the same way. */
const cliffHeights = new ModeCache<Float32Array | null>();
const cliffDirs = new ModeCache<Map<string, string>>();

/** The most variations a cliff model name is looked for with (the game's have 1 to 3; the w3e keeps 0 to 15). */
const MAX_CLIFF_VARIATIONS = 16;

/** Forgets the cliff heights read (with clearShadowMeshes). */
function clearCliffHeights(): void { cliffHeights.clear(); cliffDirs.clear(); }

/** The cliff tiles' heights for the terrain's shadows: per tile, the model shadowCliffName names in its cliff type's
 *  folder (CliffTypes.slk `cliffModelDir`; the bottom-left corner's type and variation, a variation the name doesn't
 *  have counted round its variations: shadowCliffVariation). Undefined when the cliff types can't be read; a tile whose
 *  model can't be read is taken as ground (shadowCellHeights). */
async function shadowCliffs(t: Terrain, readFile: (path: string) => Promise<Uint8Array>, artMode: () => string): Promise<CliffCells | undefined> {
  const tw = t.width - 1, tiles: number[] = [];
  for (let ty = 0; ty < t.height - 1; ty++) {
    for (let tx = 0; tx < tw; tx++) {
      const cs = [t.corners[ty * t.width + tx], t.corners[ty * t.width + tx + 1], t.corners[(ty + 1) * t.width + tx], t.corners[(ty + 1) * t.width + tx + 1]];
      if (cs.every((c) => c.layer === cs[0].layer) || cs.every((c) => c.ramp)) continue;
      const low = Math.min(...cs.map((c) => c.layer));
      if (cs.every((c) => c.layer - low <= 2)) tiles.push(ty * tw + tx);
    }
  }
  if (!tiles.length) return undefined;
  const dirs = await cliffDirs.get(artMode, "CliffTypes", async () => {
    const rows = parseSlk(new TextDecoder().decode(await readFile("TerrainArt\\CliffTypes.slk")));
    return new Map(rows.filter((r) => r.cliffID && r.cliffModelDir).map((r) => [r.cliffID, r.cliffModelDir]));
  }).catch(() => null);
  if (!dirs) return undefined;
  const list = t.cliffTiles.map((id) => dirs.get(id));
  // A model that can't be read is kept as null for the mode (most are variations the cliff type doesn't have, read
  // again on every prediction otherwise): before and after of a save agree on it. clearShadowMeshes forgets it.
  const heights = (path: string) => cliffHeights.get(artMode, path.toLowerCase(), async () => {
    try {
      const model = parseMdx(await readFile(path));
      const positions: number[] = [], faces: number[] = [];
      for (const g of model.geosets) {
        if (g.lod > 0) continue;
        const base = positions.length / 3;
        positions.push(...g.positions);
        for (const f of g.faces) faces.push(base + f);
      }
      return faces.length ? cliffCellHeights(positions, faces) : null;
    } catch { return null; }
  });
  /** How many variations a name has (0, 1, … read until one is missing). */
  const counts = new Map<string, number>();
  const variations = async (stem: string) => {
    let n = counts.get(stem);
    if (n === undefined) {
      n = 0;
      while (n < MAX_CLIFF_VARIATIONS && await heights(`${stem}${n}.mdx`)) n++;
      counts.set(stem, n);
    }
    return n;
  };
  const byTile = new Map<number, Float32Array>();
  for (const i of tiles) {
    const tx = i % tw, ty = (i - tx) / tw, bl = t.corners[ty * t.width + tx];
    const dir = list[bl.cliffTexture] ?? list[0];
    if (!dir) continue;
    const stem = `Doodads\\Terrain\\${dir}\\${dir}${shadowCliffName(t, tx, ty)}`;
    const n = await variations(stem);
    const found = n ? await heights(`${stem}${shadowCliffVariation(bl.cliffVariation, n)}.mdx`) : null;
    if (found) byTile.set(i, found);
  }
  return (tx, ty) => byTile.get(ty * tw + tx) ?? null;
}

/** What a prediction could not use: `wanted` doodads whose model should cast a shadow, `unreadable` of those whose model
 *  (or its texture data) couldn't be read. `failed`: the models that couldn't be read, by mode and path; predictions
 *  sharing it read each failed model once and agree on it (the save's before/after diff, where a model read in one and
 *  not the other would wipe or add its baked shadow). */
export type ShadowStats = { wanted: number; unreadable: number; failed?: Set<string> };

/** How many doodad and destructable types with a model the skins have: what tells whether the game's tables were read.
 *  Not `skins.size`: the built-in few (start location, random objects) are always there, and the map's own custom types
 *  of a base no table gave have no model. */
export function doodadTypes(skins: Skins): number {
  let n = 0;
  for (const s of skins.values()) if ((s.kind === "w3d" || s.kind === "w3b") && s.file) n++;
  return n;
}

/** Whether a calculated shadow map may replace the stored one. Nothing wanted from models, or all of them readable:
 *  write. Every wanted model unreadable (the game's files can't be opened): refuse, the result would be cliffs only.
 *  Some unreadable: write, and say how many objects were left out. `types`: doodadTypes of the skins (0 with doodads
 *  placed: the game's object tables weren't read, refuse). */
export function shadowVerdict(stats: ShadowStats, doodads: number, types: number): { write: boolean; leftOut: number; problem?: string } {
  if (doodads > 0 && types === 0) return { write: false, leftOut: doodads, problem: "the game's object tables couldn't be read (is the game folder set?)" };
  if (stats.wanted > 0 && stats.unreadable === stats.wanted) return { write: false, leftOut: stats.unreadable, problem: `none of the ${stats.wanted} doodad models could be read (is the game folder set?)` };
  return { write: true, leftOut: stats.unreadable };
}

/** `pause`: the terrain's part is done a few rows at a time, waiting for it in between (the terrain view, where it
 *  would hold up the page for a second or two on a big map); it returning false stops the work (rejects).
 *  `artMode`: the graphics mode `readFile` reads in (game.graphicsMode), which the models' meshes are kept by. */
export async function predictShadows(terrain: Terrain, doodads: Placed[], skins: Skins, baseOf: (id: string) => string | undefined,
  readFile: (path: string) => Promise<Uint8Array>, sun?: Sun, pause?: () => Promise<boolean>, artMode: () => string = () => "",
  stats?: ShadowStats): Promise<Uint8Array> {
  const cliffs = await shadowCliffs(terrain, readFile, artMode);
  const out = pause ? await terrainShadowsInSteps(terrain, sun, pause, cliffs) : terrainShadows(terrain, sun, cliffs);
  let since = performance.now();
  const failed = stats?.failed ?? new Set<string>();
  for (const d of doodads) {
    if (pause && performance.now() - since > 8) {
      if (!(await pause())) throw new Error("superseded");
      since = performance.now();
    }
    const skin = skins.get(d.id) ?? skins.get(baseOf(d.id) ?? "");
    // Doodads whose table says shadow=0 (corn, flowers, …) aren't in the World Editor's war3map.shd.
    if (!skin || skin.kind !== "w3d" || skin.bakesShadow === false) continue;
    const path = `${skin.file.replace(/\.(mdl|mdx)$/i, "")}${skin.numVar > 1 ? d.variation : ""}.mdx`;
    const mesh = await modelMesh(path, readFile, artMode, failed);
    // Only a model that couldn't be read is unreadable; one read with nothing to cast is used (as nothing).
    if (stats) { stats.wanted++; if (mesh === null) stats.unreadable++; }
    if (mesh && mesh !== NO_FACES) castShadow(out, terrain, { mesh, x: d.position[0], y: d.position[1], z: d.position[2], angle: d.angle, scale: d.scale }, sun);
  }
  return out;
}
