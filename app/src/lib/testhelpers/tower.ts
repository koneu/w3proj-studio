import { toClassicMdx } from "../model/classic";
import type { Model } from "../model/mdx";

/** A model of one opaque box, 100 wide and `h` high, standing on its origin. `filterMode` 2 (blended): it casts nothing. */
export function towerModel(filterMode = 0, h = 1000): Uint8Array {
  const w = 50;
  const positions: number[] = [];
  for (const z of [0, h]) for (const [x, y] of [[-w, -w], [w, -w], [w, w], [-w, w]]) positions.push(x, y, z);
  // The four sides and the top, two triangles each.
  const quads = [[0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7], [4, 5, 6, 7]];
  const faces = quads.flatMap(([a, b, c, d]) => [a, b, c, a, c, d]);
  const extent = { radius: h, min: [-w, -w, 0] as [number, number, number], max: [w, w, h] as [number, number, number] };
  const model = {
    version: 800, name: "tower", extent, sequences: [], globalSequences: [], textures: [], textureAnims: [], geosetAnims: [],
    materials: [{ priorityPlane: 0, flags: 0, layers: [{ filterMode, shadingFlags: 0, textureIds: [0], textureAnimId: -1, coordId: 0, alpha: 1 }] }],
    geosets: [{
      positions: new Float32Array(positions), normals: new Float32Array(positions.length), uvs: new Float32Array((positions.length / 3) * 2),
      faces: new Uint16Array(faces), vertexGroups: new Uint8Array(positions.length / 3), groups: [[0]], materialId: 0, lod: 0, lodName: "", extent,
    }],
    nodes: [{ name: "root", objectId: 0, parentId: -1, flags: 0, kind: "bone" }], pivots: new Float32Array(3),
    particleEmitters2: [], ribbons: [], skipped: [], warnings: [],
  } as unknown as Model;
  return toClassicMdx(model, () => null);
}
