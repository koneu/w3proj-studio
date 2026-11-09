// Shadow prediction for a terrain and its doodads (see shadows.ts): terrain
// shadows plus doodad models (opaque and alpha-tested parts). Destructables
// (trees) cast no baked shadows.

import { decodeImage } from "../../lib/image/index.ts";
import { parseMdx } from "../../lib/model/mdx";
import { neverStoredLast } from "../../lib/model/texpath";
import type { loadSkins, Placed } from "./objects";
import { alphaTexturePaths, castShadow, shadowMesh, terrainShadows, terrainShadowsInSteps, type AlphaMap, type ShadowMesh, type Sun } from "./shadows";
import type { Terrain } from "../../lib/terrain/w3e";

type Skins = Awaited<ReturnType<typeof loadSkins>>;

/** Casting triangles by model path (shared by all editors). */
const meshes = new Map<string, Promise<ShadowMesh | null>>();

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

function modelMesh(path: string, readFile: (path: string) => Promise<Uint8Array>): Promise<ShadowMesh | null> {
  const key = path.toLowerCase();
  let m = meshes.get(key);
  if (!m) {
    m = (async () => {
      const model = parseMdx(await readFile(path));
      const maps = new Map<string, AlphaMap | null>();
      for (const p of alphaTexturePaths(model)) maps.set(p, await alphaMap(p, readFile));
      return shadowMesh(model, (p) => maps.get(p) ?? null);
    })().catch(() => null);
    meshes.set(key, m);
  }
  return m;
}

/** `pause`: the terrain's part is done a few rows at a time, waiting for it in between (the terrain view, where it
 *  would hold up the page for a second or two on a big map); it returning false stops the work (rejects). */
export async function predictShadows(terrain: Terrain, doodads: Placed[], skins: Skins, baseOf: (id: string) => string | undefined,
  readFile: (path: string) => Promise<Uint8Array>, sun?: Sun, pause?: () => Promise<boolean>): Promise<Uint8Array> {
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
    const mesh = await modelMesh(path, readFile);
    if (mesh) castShadow(out, terrain, { mesh, x: d.position[0], y: d.position[1], z: d.position[2], angle: d.angle, scale: d.scale }, sun);
  }
  return out;
}
