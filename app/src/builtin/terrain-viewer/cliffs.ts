// Cliff models. A tile whose four corners sit on different layers is drawn
// with a model from the cliff type's folder, named after the corners' layers
// relative to the lowest one (A = lowest, B = +1, C = +2) in the order
// bottom-left, top-left, top-right, bottom-right, plus a variation number:
// Doodads\Terrain\Cliffs\CliffsAABA0.mdx. The model's replaceable texture 11
// is the cliff type's texture; Reforged cliff models instead name placeholder
// textures (#ignore_Cliffs\Cliff1_Diffuse…) that stand for its HD set.
// Ramps (tiles with the ramp flag) aren't modelled and stay sloped ground.

import type { Mat4 } from "../../lib/model/renderer";
import type { ModelRequest } from "./objects";
import type { Terrain } from "./w3e";

export interface CliffType {
  cliffID: string;
  cliffModelDir: string;
  texDir: string;
  texFile: string;
  /** Ground tile the cliff belongs to (and paints around itself). */
  groundTile: string;
}

/** A cliff model and the tiles (y × (width-1) + x) it covers. */
export type CliffRequest = ModelRequest & { tiles: number[] };

export interface CliffPlan {
  requests: CliffRequest[];
  /** Corner index → ground texture index: corners touching a cliff show its ground tile. */
  groundOverrides: Map<number, number>;
}

/** The cliff types a corner's cliff texture index refers to. The list stored
 *  in the w3e is ignored by the game: it is every ground tile of the map, in
 *  order, that has a cliff version. */
export function cliffList(t: Terrain, types: Map<string, CliffType>): CliffType[] {
  const byGround = new Map([...types.values()].map((c) => [c.groundTile, c]));
  return t.groundTiles.map((g) => byGround.get(g)).filter((c): c is CliffType => !!c);
}

/** `exists` tells whether a game path is present (to pick a variation that has a file). */
export function planCliffs(t: Terrain, types: Map<string, CliffType>, exists: (path: string) => boolean): CliffPlan {
  const list = cliffList(t, types);
  const byPath = new Map<string, CliffRequest>();
  const groundOverrides = new Map<number, number>();
  const corner = (x: number, y: number) => t.corners[y * t.width + x];
  for (let y = 0; y < t.height - 1; y++) {
    for (let x = 0; x < t.width - 1; x++) {
      const bl = corner(x, y), br = corner(x + 1, y), tl = corner(x, y + 1), tr = corner(x + 1, y + 1);
      const cs = [bl, tl, tr, br];
      if (cs.every((c) => c.layer === bl.layer) || cs.some((c) => c.ramp)) continue;
      const base = Math.min(...cs.map((c) => c.layer));
      if (cs.some((c) => c.layer - base > 2)) continue;
      const name = cs.map((c) => String.fromCharCode(65 + c.layer - base)).join("");
      // The bottom-left corner decides; 15 is reserved and taken as the first type.
      const type = list[bl.cliffTexture] ?? list[0];
      if (!type) continue;
      const dir = `Doodads\\Terrain\\${type.cliffModelDir}\\${type.cliffModelDir}${name}`;
      // Missing variations fall back to the highest one that exists.
      let v = bl.cliffVariation;
      while (v > 0 && !exists(`${dir}${v}.mdx`)) v--;
      const path = `${dir}${v}.mdx`;
      if (!exists(path)) continue;

      const ground = t.groundTiles.indexOf(type.groundTile);
      if (ground >= 0) {
        for (const [cx, cy] of [[x, y], [x + 1, y], [x, y + 1], [x + 1, y + 1]]) groundOverrides.set(cy * t.width + cx, ground);
      }

      // Cliff models stand on their lowest layer; the renderer adds the ground
      // height (without layers) per vertex.
      const z = (base - 2) * 128;
      // The models span one tile to the -x side of their origin (bottom-right corner).
      const world: Mat4 = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, t.offsetX + (x + 1) * 128, t.offsetY + y * 128, z, 1]);
      const texture = `${type.texDir}\\${type.texFile}.blp`;
      const key = `${path}|${texture}`;
      const req = byPath.get(key) ?? {
        path, replaceable: { 11: texture }, instances: [], tiles: [],
        retexture: (p: string) => p.replace(/^.*#ignore_Cliffs[\\/]Cliff\d+_(\w+)\.\w+$/i, `${type.texDir}\\${type.texFile}_$1.blp`),
      };
      req.instances.push({ world, team: 0 });
      req.tiles.push(y * (t.width - 1) + x);
      byPath.set(key, req);
    }
  }
  return { requests: [...byPath.values()], groundOverrides };
}
