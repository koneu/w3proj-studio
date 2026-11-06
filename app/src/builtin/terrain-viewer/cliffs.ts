// Cliff models. A tile whose four corners sit on different layers is drawn
// with a model from the cliff type's folder, named after the corners' layers
// relative to the lowest one (A = lowest, B = +1, C = +2) in the order
// bottom-left, top-left, top-right, bottom-right, plus a variation number:
// Doodads\Terrain\Cliffs\CliffsAABA0.mdx. The model's replaceable texture 11
// is the cliff type's texture; Reforged cliff models instead name placeholder
// textures (#ignore_Cliffs\Cliff1_Diffuse…) that stand for its HD set.
// Ramps: see planCliffs.

import type { Mat4 } from "../../lib/model/renderer";
import type { ModelRequest } from "./objects";
import type { Terrain } from "../../lib/terrain/w3e";

export interface CliffType {
  cliffID: string;
  cliffModelDir: string;
  /** Folder (and name prefix) of the ramp models, e.g. CliffTrans. */
  rampModelDir: string;
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
  const tw = t.width - 1;
  const add = (path: string, type: CliffType, world: Mat4, tiles: number[]) => {
    const texture = `${type.texDir}\\${type.texFile}.blp`;
    const key = `${path}|${texture}`;
    const req = byPath.get(key) ?? {
      path, replaceable: { 11: texture }, instances: [], tiles: [],
      retexture: (p: string) => p.replace(/^.*#ignore_Cliffs[\\/]Cliff\d+_(\w+)\.\w+$/i, `${type.texDir}\\${type.texFile}_$1.blp`),
    };
    req.instances.push({ world, team: 0 });
    req.tiles.push(...tiles);
    byPath.set(key, req);
  };

  // Ramp sides: a 2×1 or 1×2 block where a ramp meets the cliff, drawn with
  // a model from the type's ramp folder named after the block's outer
  // corners (bottom-left, top-left, top-right, bottom-right): A/B/C as for
  // cliffs, L/H/X for ramp corners 0/1/2 layers up. Pure ramp tiles (all
  // corners flagged) stay sloped ground.
  const covered = new Set<number>();
  for (let y = 0; y < t.height - 1; y++) {
    for (let x = 0; x < tw; x++) {
      if (covered.has(y * tw + x)) continue;
      const cs = [corner(x, y), corner(x, y + 1), corner(x + 1, y + 1), corner(x + 1, y)];
      if (!cs.some((c) => c.ramp) || cs.every((c) => c.ramp) || cs.every((c) => c.layer === cs[0].layer)) continue;
      // Blocks containing this tile: horizontal (2×1) or vertical (1×2).
      const blocks: [number, number, number, number][] = [[x, y, 2, 1], [x - 1, y, 2, 1], [x, y, 1, 2], [x, y - 1, 1, 2]];
      for (const [bx, by, bw, bh] of blocks) {
        if (bx < 0 || by < 0 || bx + bw > tw || by + bh > t.height - 1) continue;
        const tiles = bw === 2 ? [by * tw + bx, by * tw + bx + 1] : [by * tw + bx, (by + 1) * tw + bx];
        if (tiles.some((i) => covered.has(i))) continue;
        const outer = [corner(bx, by), corner(bx, by + bh), corner(bx + bw, by + bh), corner(bx + bw, by)];
        const base = Math.min(...outer.map((c) => c.layer));
        if (outer.some((c) => c.layer - base > 2)) continue;
        const name = outer.map((c) => (c.ramp ? "LHX" : "ABC")[c.layer - base]).join("");
        // The ramp corners run along the block's long side: a row (top 1,2 or
        // bottom 0,3) for 2×1 pieces, a column (left 0,1 or right 2,3) for 1×2.
        const ramps = outer.map((c, i) => (c.ramp ? i : -1)).filter((i) => i >= 0).join("");
        if (!(bw === 2 ? ramps === "12" || ramps === "03" : ramps === "01" || ramps === "23")) continue;
        // A side piece for a ramp running straight past it: the ramp's row flagged all along, the far side
        // not, and level with the ramp's low end in the middle (it falls high, low, low). Others are where a
        // ramp ends on a bent cliff, where the piece leaves a hole here: an ordinary cliff meets its
        // neighbours. This only decides what the view draws, the map keeps its flags.
        const middle = bw === 2 ? [corner(bx + 1, by), corner(bx + 1, by + 1)] : [corner(bx, by + 1), corner(bx + 1, by + 1)];
        const [near, far] = ramps === "03" || ramps === "01" ? middle : [middle[1], middle[0]];
        const low = Math.min(...outer.filter((c) => c.ramp).map((c) => c.layer));
        if (!near.ramp || far.ramp || near.layer !== low) continue;
        const type = list[outer[0].cliffTexture] ?? list[0];
        if (!type?.rampModelDir) continue;
        const path = `Doodads\\Terrain\\${type.rampModelDir}\\${type.rampModelDir}${name}0.mdx`;
        if (!exists(path)) continue;
        // Origin at the block's bottom-right corner, like cliff models.
        add(path, type, new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, t.offsetX + (bx + bw) * 128, t.offsetY + by * 128, (base - 2) * 128, 1]), tiles);
        for (const i of tiles) covered.add(i);
        break;
      }
    }
  }

  for (let y = 0; y < t.height - 1; y++) {
    for (let x = 0; x < t.width - 1; x++) {
      const bl = corner(x, y), br = corner(x + 1, y), tl = corner(x, y + 1), tr = corner(x + 1, y + 1);
      const cs = [bl, tl, tr, br];
      // Ramp surfaces stay ground; tiles a ramp model covers are done; any
      // other tile touching a ramp corner is an ordinary cliff.
      if (cs.every((c) => c.layer === bl.layer) || cs.every((c) => c.ramp) || covered.has(y * tw + x)) continue;
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
      add(path, type, world, [y * tw + x]);
    }
  }
  return { requests: [...byPath.values()], groundOverrides };
}
