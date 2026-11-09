import assert from "node:assert/strict";
import { test } from "node:test";
import type { W3Api } from "../../extensions/api";
import { toClassicMdx } from "../../lib/model/classic";
import type { Model } from "../../lib/model/mdx";
import { newTerrain, type NewMapOptions } from "./newmap";
import { loadSkins, withObjectArt, type Placed } from "./objects";
import { predictShadows } from "./shadowmap";
import { terrainShadows } from "./shadows";

/** A model of one opaque box, 100 wide and 1000 high, standing on its origin. */
function towerModel(): Uint8Array {
  const [w, h] = [50, 1000];
  const positions: number[] = [];
  for (const z of [0, h]) for (const [x, y] of [[-w, -w], [w, -w], [w, w], [-w, w]]) positions.push(x, y, z);
  // The four sides and the top, two triangles each.
  const quads = [[0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7], [4, 5, 6, 7]];
  const faces = quads.flatMap(([a, b, c, d]) => [a, b, c, a, c, d]);
  const extent = { radius: h, min: [-w, -w, 0] as [number, number, number], max: [w, w, h] as [number, number, number] };
  const model = {
    version: 800, name: "tower", extent, sequences: [], globalSequences: [], textures: [], textureAnims: [], geosetAnims: [],
    materials: [{ priorityPlane: 0, flags: 0, layers: [{ filterMode: 0, shadingFlags: 0, textureIds: [0], textureAnimId: -1, coordId: 0, alpha: 1 }] }],
    geosets: [{
      positions: new Float32Array(positions), normals: new Float32Array(positions.length), uvs: new Float32Array((positions.length / 3) * 2),
      faces: new Uint16Array(faces), vertexGroups: new Uint8Array(positions.length / 3), groups: [[0]], materialId: 0, lod: 0, lodName: "", extent,
    }],
    nodes: [{ name: "root", objectId: 0, parentId: -1, flags: 0, kind: "bone" }], pivots: new Float32Array(3),
    particleEmitters2: [], ribbons: [], skipped: [], warnings: [],
  } as unknown as Model;
  return toClassicMdx(model, () => null);
}

test("doodads the skin table says cast no shadow (shadow=0, as corn) stay out of war3map.shd, and the map's object data decides over it", async () => {
  // DoodadSkins.txt as the game has it: a rock casts, corn doesn't.
  const files: Record<string, string> = {
    "Doodads\\DoodadSkins.txt": "[LOrk]\nfile=Doodads\\Rock\nshadow=1\n[LPcr]\nfile=Doodads\\Corn\nshadow=0",
    "Units\\DestructableSkin.txt": "", "Units\\UnitSkin.txt": "", "Units\\ItemSkin.txt": "", "Units\\UnitData.slk": "ID;P\nE",
  };
  const w3 = { settings: { get: () => "sd-baked-shadow-test" }, game: { readText: async (p: string) => files[p] ?? "" } } as unknown as W3Api;
  const skins = withObjectArt(await loadSkins(w3), [{
    kind: "w3d",
    custom: [{ base: "LPcr", id: "D000", mods: [{ field: "dshd", value: 1 }] }, { base: "LOrk", id: "D001", mods: [{ field: "dshd", value: 0 }] }],
  }]);
  assert.equal(skins.get("LPcr")?.bakesShadow, false);
  assert.equal(skins.get("LOrk")?.bakesShadow, undefined, "shadow=1 casts");

  const terrain = newTerrain({ width: 32, height: 32, tileset: "L", groundTiles: ["Ldrt"], cliffTiles: [], baseTile: "Ldrt", layer: 2, water: "none", noise: false, customTiles: false } as unknown as NewMapOptions);
  const tower = towerModel();
  const asked: string[] = [];
  const read = async (p: string) => {
    asked.push(p);
    if (/\.mdx$/i.test(p)) return tower;
    throw new Error(`no ${p}`);
  };
  const at = (id: string): Placed => ({ id, variation: 0, position: [terrain.offsetX + 16 * 128, terrain.offsetY + 16 * 128, 0], angle: 0, scale: [1, 1, 1] });
  const ground = terrainShadows(terrain);
  const shadowed = (m: Uint8Array) => m.reduce((n, v, i) => n + (v !== ground[i] ? 1 : 0), 0);
  const predict = (id: string) => predictShadows(terrain, [at(id)], skins, () => undefined, read);

  const rock = await predict("LOrk");
  assert.ok(shadowed(rock) > 10, `the rock casts (the control): ${shadowed(rock)} cells`);
  asked.length = 0;
  assert.equal(shadowed(await predict("LPcr")), 0, "corn casts nothing");
  assert.deepEqual(asked, [], "corn's model isn't even read");
  assert.deepEqual(await predict("D000"), rock, "corn whose object data turns its shadow on casts");
  assert.equal(shadowed(await predict("D001")), 0, "a rock whose object data turns it off doesn't");
});
