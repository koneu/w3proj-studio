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
import { rampSides } from "../../lib/terrain/cliffs";

/** A Reforged cliff model's texture as drawn: its placeholders for the cliff type's HD set become that set
 *  (TerrainArt\CityScape\City_Cliff1_Diffuse.blp). The Cliffs models name Doodads\Terrain\#ignore_Cliffs\Cliff1_…,
 *  the City cliffs (CityCliffs) ReplaceableTextures\Cliff\Cliff1_…, a file the game doesn't have (drawn white
 *  before: OrcX02_03's city walls). Other paths stay. */
export function cliffRetexture(path: string, type: Pick<CliffType, "texDir" | "texFile">): string {
  return path.replace(/^.*(?:#ignore_Cliffs|ReplaceableTextures[\\/]Cliff)[\\/]Cliff\d+_(\w+)\.\w+$/i, `${type.texDir}\\${type.texFile}_$1.blp`);
}

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
      retexture: (p: string) => cliffRetexture(p, type),
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
  // The blocks (rampSides) a model of the cliff type's ramp folder exists for; the others are ordinary cliffs.
  rampSides(t, ({ x: bx, y: by, w: bw, outer, base, tiles }) => {
    const name = outer.map((c) => (c.ramp ? "LHX" : "ABC")[c.layer - base]).join("");
    const type = list[outer[0].cliffTexture] ?? list[0];
    if (!type?.rampModelDir) return false;
    const path = `Doodads\\Terrain\\${type.rampModelDir}\\${type.rampModelDir}${name}0.mdx`;
    if (!exists(path)) return false;
    // Origin at the block's bottom-right corner, like cliff models.
    add(path, type, new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, t.offsetX + (bx + bw) * 128, t.offsetY + by * 128, (base - 2) * 128, 1]), tiles);
    for (const i of tiles) covered.add(i);
    return true;
  });

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
