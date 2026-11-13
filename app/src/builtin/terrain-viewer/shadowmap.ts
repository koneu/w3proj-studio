// Shadow prediction for a terrain and its doodads (see shadows.ts): terrain
// shadows plus doodad models (opaque and alpha-tested parts). Destructables
// (trees) cast no baked shadows.

import { decodeImage } from "../../lib/image/index.ts";
import { parseMdx } from "../../lib/model/mdx";
import { neverStoredLast } from "../../lib/model/texpath";
import { ModeCache } from "../../lib/modecache";
import type { loadSkins, Placed } from "./objects";
import { alphaTexturePaths, castShadow, shadowMesh, terrainShadows, terrainShadowsInSteps, type AlphaMap, type ShadowMesh, type Sun } from "./shadows";
import type { Terrain } from "../../lib/terrain/w3e";

type Skins = Awaited<ReturnType<typeof loadSkins>>;

/** Casting triangles by graphics mode and model path (shared by all editors; HD and Classic models share paths). */
const meshes = new ModeCache<ShadowMesh | null>();

async function alphaMap(path: string, readFile: (path: string) => Promise<Uint8Array>): Promise<AlphaMap | null> {
  // Reforged names .tif/.blp sources the game ships as .dds; a .tif is never there, so last.
  for (const p of neverStoredLast([path, path.replace(/\.\w+$/, ".blp"), path.replace(/\.\w+$/, ".dds")])) {
    try {
      const mip = decodeImage(await readFile(p), p).mip(0);
      const alpha = new Uint8Array(mip.width * mip.height);
      for (let i = 0; i < alpha.length; i++) alpha[i] = mip.rgba[i * 4 + 3];
      return { width: mip.width, height: mip.height, alpha };
    } catch { /* next variant */ }
  }
  return null;
}

function modelMesh(path: string, readFile: (path: string) => Promise<Uint8Array>, artMode: () => string): Promise<ShadowMesh | null> {
  return meshes.get(artMode, path.toLowerCase(), () => (async () => {
    const model = parseMdx(await readFile(path));
    const maps = new Map<string, AlphaMap | null>();
    for (const p of alphaTexturePaths(model)) maps.set(p, await alphaMap(p, readFile));
    return shadowMesh(model, (p) => maps.get(p) ?? null);
  })().catch(() => null));
}

/** What a prediction could not use: `wanted` doodads whose model should cast a shadow, `unreadable` of those whose model
 *  (or its texture data) couldn't be read. `skins` is how many object entries the game's tables gave. */
export type ShadowStats = { wanted: number; unreadable: number };

/** Whether a calculated shadow map may replace the stored one. Nothing wanted from models, or all of them readable:
 *  write. Every wanted model unreadable (the game's files can't be opened): refuse, the result would be cliffs only.
 *  Some unreadable: write, and say how many objects were left out. */
export function shadowVerdict(stats: ShadowStats, doodads: number, skins: number): { write: boolean; leftOut: number; problem?: string } {
  if (doodads > 0 && skins === 0) return { write: false, leftOut: doodads, problem: "the game's object tables couldn't be read (is the game folder set?)" };
  if (stats.wanted > 0 && stats.unreadable === stats.wanted) return { write: false, leftOut: stats.unreadable, problem: `none of the ${stats.wanted} doodad models could be read (is the game folder set?)` };
  return { write: true, leftOut: stats.unreadable };
}

/** `pause`: the terrain's part is done a few rows at a time, waiting for it in between (the terrain view, where it
 *  would hold up the page for a second or two on a big map); it returning false stops the work (rejects).
 *  `artMode`: the graphics mode `readFile` reads in (game.graphicsMode), which the models' meshes are kept by. */
export async function predictShadows(terrain: Terrain, doodads: Placed[], skins: Skins, baseOf: (id: string) => string | undefined,
  readFile: (path: string) => Promise<Uint8Array>, sun?: Sun, pause?: () => Promise<boolean>, artMode: () => string = () => "",
  stats?: ShadowStats): Promise<Uint8Array> {
  const out = pause ? await terrainShadowsInSteps(terrain, sun, pause) : terrainShadows(terrain, sun);
  let since = performance.now();
  for (const d of doodads) {
    if (pause && performance.now() - since > 8) {
      if (!(await pause())) throw new Error("superseded");
      since = performance.now();
    }
    const skin = skins.get(d.id) ?? skins.get(baseOf(d.id) ?? "");
    // Doodads whose table says shadow=0 (corn, flowers, …) aren't in the World Editor's war3map.shd.
    if (!skin || skin.kind !== "w3d" || skin.bakesShadow === false) continue;
    const path = `${skin.file.replace(/\.(mdl|mdx)$/i, "")}${skin.numVar > 1 ? d.variation : ""}.mdx`;
    const mesh = await modelMesh(path, readFile, artMode);
    if (stats) { stats.wanted++; if (!mesh) stats.unreadable++; }
    if (mesh) castShadow(out, terrain, { mesh, x: d.position[0], y: d.position[1], z: d.position[2], angle: d.angle, scale: d.scale }, sun);
  }
  return out;
}
