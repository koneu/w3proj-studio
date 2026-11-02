// Shadow prediction for a terrain and its doodads (see shadows.ts): terrain
// shadows plus doodad models (opaque and alpha-tested parts). Destructables
// (trees) cast no baked shadows.

import { decodeImage } from "../../lib/image/index.ts";
import { parseMdx } from "../../lib/model/mdx";
import type { loadSkins, Placed } from "./objects";
import { alphaTexturePaths, castShadow, shadowMesh, terrainShadows, type AlphaMap, type ShadowMesh, type Sun } from "./shadows";
import type { Terrain } from "../../lib/terrain/w3e";

type Skins = Awaited<ReturnType<typeof loadSkins>>;

/** Casting triangles by model path (shared by all editors). */
const meshes = new Map<string, Promise<ShadowMesh | null>>();

async function alphaMap(path: string, readFile: (path: string) => Promise<Uint8Array>): Promise<AlphaMap | null> {
  // Reforged names .tif/.blp sources the game ships as .dds.
  for (const p of [path, path.replace(/\.\w+$/, ".blp"), path.replace(/\.\w+$/, ".dds")]) {
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

export async function predictShadows(terrain: Terrain, doodads: Placed[], skins: Skins, baseOf: (id: string) => string | undefined,
  readFile: (path: string) => Promise<Uint8Array>, sun?: Sun): Promise<Uint8Array> {
  const out = terrainShadows(terrain, sun);
  for (const d of doodads) {
    const skin = skins.get(d.id) ?? skins.get(baseOf(d.id) ?? "");
    if (!skin || skin.kind !== "w3d") continue;
    const path = `${skin.file.replace(/\.(mdl|mdx)$/i, "")}${skin.numVar > 1 ? d.variation : ""}.mdx`;
    const mesh = await modelMesh(path, readFile);
    if (mesh) castShadow(out, terrain, { mesh, x: d.position[0], y: d.position[1], z: d.position[2], angle: d.angle, scale: d.scale }, sun);
  }
  return out;
}
