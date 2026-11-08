// The World Editor's stand-in for an object whose model it can't load: a cube standing on the object's place, its
// faces checkered green and black, four squares a side. Measured with we-drive on light_map.w3m in HD (LRsr and
// YOtc, whose models don't load there): about 128 a side at scale 1, following the object's scale and facing, lit
// as the other models are (the sides away from the sun darker).

import type { DecodedImage } from "../image/index";
import type { Model } from "./mdx";

/** The cube's side at scale 1. */
export const PLACEHOLDER_SIZE = 128;
/** Squares along a face's side. */
export const PLACEHOLDER_SQUARES = 4;
/** The light squares' colour (the dark ones are black). */
export const PLACEHOLDER_GREEN: readonly [number, number, number] = [0, 255, 24];

/** The cube as a model: one geoset of six faces (their own corners, so each face has its normal and the whole
 *  texture), on one still bone, one opaque layer of texture 0 (`placeholderImage`; no file: the path is empty). */
export function placeholderModel(size = PLACEHOLDER_SIZE): Model {
  const h = size / 2;
  // Per face: normal, and two axes along it (u, v), so the corners are centre ± u ± v.
  const faces: [number[], number[], number[]][] = [
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, 0, -1], [-1, 0, 0], [0, 1, 0]],
    [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [[-1, 0, 0], [0, -1, 0], [0, 0, 1]],
    [[0, 1, 0], [-1, 0, 0], [0, 0, 1]], [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
  ];
  const positions: number[] = [], normals: number[] = [], uvs: number[] = [], indices: number[] = [];
  for (const [n, u, v] of faces) {
    const base = positions.length / 3;
    for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      // The cube stands on the ground: its centre is half a side up.
      positions.push(n[0] * h + su * u[0] * h + sv * v[0] * h, n[1] * h + su * u[1] * h + sv * v[1] * h, h + n[2] * h + su * u[2] * h + sv * v[2] * h);
      normals.push(...n);
      uvs.push((su + 1) / 2, (1 - sv) / 2);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const extent = { radius: Math.hypot(h, h, h), min: [-h, -h, 0] as [number, number, number], max: [h, h, size] as [number, number, number] };
  return {
    version: 800, name: "Placeholder", extent,
    sequences: [{ name: "Stand", start: 0, end: 1000, moveSpeed: 0, flags: 0, rarity: 0, extent }],
    globalSequences: [],
    textures: [{ replaceableId: 0, path: "", flags: 0 }],
    materials: [{ priorityPlane: 0, flags: 0, layers: [{ filterMode: 0, shadingFlags: 0, textureIds: [0], textureAnimId: -1, coordId: 0, alpha: 1 }] }],
    geosets: [{
      positions: new Float32Array(positions), normals: new Float32Array(normals), uvs: new Float32Array(uvs), faces: new Uint16Array(indices),
      vertexGroups: new Uint8Array(positions.length / 3), groups: [[0]], materialId: 0, lod: 0, lodName: "", extent,
    }],
    geosetAnims: [],
    nodes: [{ name: "Root", objectId: 0, parentId: -1, flags: 0, kind: "bone" }],
    pivots: new Float32Array(3),
    particleEmitters2: [], ribbons: [], textureAnims: [], skipped: [], warnings: [],
  };
}

/** The checkered texture: `PLACEHOLDER_SQUARES` squares a side, 16 pixels each, the top-left one green. */
export function placeholderImage(): DecodedImage {
  const cell = 16, side = PLACEHOLDER_SQUARES * cell;
  const rgba = new Uint8ClampedArray(side * side * 4);
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const green = ((Math.floor(x / cell) + Math.floor(y / cell)) & 1) === 0;
      const at = (y * side + x) * 4;
      if (green) rgba.set(PLACEHOLDER_GREEN, at);
      rgba[at + 3] = 255;
    }
  }
  return { format: "placeholder", width: side, height: side, hasAlpha: false, mipCount: 1, mip: () => ({ width: side, height: side, rgba }) };
}
