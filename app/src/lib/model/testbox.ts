// A made-up Reforged model for the tests of Convert to Classic (classiccheck.test.ts, problems/reforged.test.ts).
// Only tests import it.

import type { Model, Node } from "./mdx";

type V3 = [number, number, number];

/** A Reforged-like model: a box on the bone "arm" (child of "root"), an attachment on "arm" and a sound event on
 *  "root" whose id comes after the attachment's, as in the game's units (events last). Its geosets are at `lods`. */
export function reforgedModel(lods = [0]): Model {
  const [w, h] = [50, 200];
  const positions: number[] = [];
  for (const z of [0, h]) for (const [x, y] of [[-w, -w], [w, -w], [w, w], [-w, w]]) positions.push(x, y, z);
  const quads = [[0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7], [4, 5, 6, 7]];
  const faces = quads.flatMap(([a, b, c, d]) => [a, b, c, a, c, d]);
  const extent = { radius: h, min: [-w, -w, 0] as V3, max: [w, w, h] as V3 };
  const node = (name: string, objectId: number, parentId: number, kind: string): Node => ({ name, objectId, parentId, flags: 0, kind });
  return {
    version: 1000, name: "box", extent, globalSequences: [], textureAnims: [], geosetAnims: [],
    sequences: [{ name: "Stand", start: 0, end: 1000, moveSpeed: 0, flags: 0, rarity: 0, extent }],
    textures: [{ replaceableId: 0, path: "Textures/Box_Diffuse.tif", flags: 0 }, { replaceableId: 0, path: "Textures/Box_Normal.tif", flags: 0 }],
    materials: [{ priorityPlane: 0, flags: 0, layers: [{ filterMode: 0, shadingFlags: 0, textureIds: [0, 1], textureAnimId: -1, coordId: 0, alpha: 1 }] }],
    geosets: lods.map((lod) => ({
      positions: new Float32Array(positions), normals: new Float32Array(positions.length), uvs: new Float32Array((positions.length / 3) * 2),
      faces: new Uint16Array(faces), vertexGroups: new Uint8Array(positions.length / 3), groups: [[1]], materialId: 0, lod, lodName: `LOD${lod}`, extent,
    })),
    nodes: [node("root", 0, -1, "bone"), node("arm", 1, 0, "bone"), node("Origin Ref", 2, 1, "atch"), node("SNDXHFOO", 3, 0, "event")],
    pivots: new Float32Array([0, 0, 0, 0, 0, 100, 0, 0, 150, 0, 0, 5]),
    particleEmitters2: [], ribbons: [], skipped: [], warnings: [],
  } as unknown as Model;
}

/** Where the Convert to Classic fix would put texture `i` of `m` (a BLP in war3mapImported\Classic\Box). */
export const blpPath = (m: Model) => (i: number) => `war3mapImported\\Classic\\Box\\${m.textures[i].path.split("/").pop()!.replace(/\.\w+$/, "")}.blp`;
