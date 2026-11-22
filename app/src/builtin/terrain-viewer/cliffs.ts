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
import { cliffSlot, rampSides } from "../../lib/terrain/cliffs";

/** A Reforged cliff model's texture as drawn: its placeholders for the cliff type's HD set become that set
 *  (TerrainArt\CityScape\City_Cliff1_Diffuse.blp). The Cliffs models name Doodads\Terrain\#ignore_Cliffs\Cliff1_…,
 *  the City cliffs (CityCliffs) ReplaceableTextures\Cliff\Cliff1_…, a file the game doesn't have (drawn white
 *  before: OrcX02_03's city walls). Other paths stay. `slot` (hdSlots: "_Diffuse"…), when given, is the part of the
 *  set: the placeholder's own name can be wrong (the HD cave CliffDoodadCave lists Cliff1_ORM in its diffuse slot and
 *  Cliff1_Diffuse in its ORM slot, which drew it white). */
export function cliffRetexture(path: string, type: Pick<CliffType, "texDir" | "texFile">, slot?: string): string {
  return path.replace(/^.*(?:#ignore_Cliffs|ReplaceableTextures[\\/]Cliff)[\\/]Cliff\d+_(\w+)\.\w+$/i,
    (_m, own: string) => `${type.texDir}\\${type.texFile}${slot ?? `_${own}`}.blp`);
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

/** What the default cliff type is picked by (tilesetDefaultCliff): CliffTypes.slk's id, model folder and texture. */
export type CliffLook = Pick<CliffType, "cliffID" | "cliffModelDir" | "texFile">;

/** The cliff type the World Editor's water brush and cliff palette start on for a tileset (its letter, as the cliff
 *  ids' second one): of the tileset's own cliff types (`types`, CliffTypes.slk), the first natural one (cliffModelDir
 *  Cliffs, not CityCliffs) with the second texture (texFile …Cliff1), else the first natural one, else the first with
 *  the second texture. Seen (we-compare, the water brush's cliff type): Grass Cliff CLgr on Lordaeron Summer, CAgr on
 *  Ashenvale, and on Dungeon, Underground and Black Citadel the natural CDdi, CGdi, CKdi, not their …Cliff1 (CDsq,
 *  CGsq, CKdt: CityCliffs; water-dungeon, branch we-compare-14). Null when the tileset has none. */
export function tilesetDefaultCliff(tileset: string, types: ReadonlyMap<string, CliffLook>): string | null {
  const own = [...types.values()].filter((c) => c.cliffID[1] === tileset);
  const natural = (c: CliffLook) => /^cliffs$/i.test(c.cliffModelDir);
  const second = (c: CliffLook) => /cliff1$/i.test(c.texFile);
  return (own.find((c) => natural(c) && second(c)) ?? own.find(natural) ?? own.find(second))?.cliffID ?? null;
}

/** The cliff type number (in `list`, cliffList's) the World Editor's cliff palette starts on: the tileset's default
 *  cliff (tilesetDefaultCliff) wherever it is in the w3e's cliff list (we-compare water-brush-swapped, 2026-11-13: Grass
 *  Cliff under CLdi CLgr and CLgr CLdi; branch we-compare-14: CLgr third in CLdi CWsn CLgr, second in CKdt CLgr CLdi
 *  CYsq). The editor appends it to a list without it (CAgr CLdi became CAgr CLdi CLgr on Lordaeron Summer: Studio's
 *  strokes do that first, defaultCliffToAdd); without it here (a full list, the game's types not read) the first entry
 *  with the second texture. -1 when the map has neither. */
export function weDefaultCliffType(list: readonly (CliffLook | undefined)[], tileset = "", types: ReadonlyMap<string, CliffLook> = new Map()): number {
  const id = tilesetDefaultCliff(tileset, types);
  const at = id === null ? -1 : list.findIndex((c) => c?.cliffID === id);
  return at >= 0 ? at : list.findIndex((c) => !!c && /_cliff1$/i.test(c.texFile));
}

/** The cliff id a stroke on the palette's default cliff type appends to the w3e's cliff list (`ids`) first: the
 *  tileset's default cliff (tilesetDefaultCliff) when the list lacks it and has room (`max` entries, the numbers a corner
 *  can name). The World Editor's water brush on Lordaeron Summer with the list CAgr CLdi saved CAgr CLdi CLgr and typed
 *  the rim with CLgr (2), while an open and save alone kept CAgr CLdi (we-compare water-cliff-append, branch
 *  we-compare-14 and -15). Null when nothing is to be added. */
export function defaultCliffToAdd(ids: readonly string[], tileset: string, types: ReadonlyMap<string, CliffLook>, max: number): string | null {
  const id = tilesetDefaultCliff(tileset, types);
  return id === null || ids.includes(id) || ids.length >= max ? null : id;
}

/** A cliff model and the tiles (y × (width-1) + x) it covers. */
export type CliffRequest = ModelRequest & { tiles: number[] };

export interface CliffPlan {
  requests: CliffRequest[];
  /** Corner index → ground texture index: corners touching a cliff show its ground tile. */
  groundOverrides: Map<number, number>;
  /** The tiles another model stands for (`hidden`, inside the map), cliff tiles or flat: no ground is drawn there. */
  hiddenTiles: number[];
}

/** The cliff types a corner's cliff texture index refers to: the w3e's own cliff list, in its order, whatever the
 *  ground list says and with custom-tilesets 0 or 1 (we-compare ct0-cliff-*: the World Editor's Grass Cliff is 1
 *  under the cliff list CLdi CLgr and 0 under CLgr CLdi, with the ground list either way round). An entry the game
 *  doesn't define (CLno) keeps its place, as undefined, so the numbers after it stay. */
export function cliffList(t: Pick<Terrain, "cliffTiles">, types: ReadonlyMap<string, CliffType>): CliffList {
  return t.cliffTiles.map((id) => types.get(id));
}

/** cliffList's result: by cliff type number, undefined for an entry the game doesn't define. */
export type CliffList = readonly (CliffType | undefined)[];

/** `exists` tells whether a game path is present (to pick a variation that has a file). `hidden`: tiles (y ×
 *  (width-1) + x) another model stands for (special doodads): no cliff or ramp model there, and no ground either, on
 *  flat ground too (the plan's `hiddenTiles`). The World Editor leaves every tile of a special's footprint without
 *  ground: on flat ground, where the cave or collapse model doesn't cover its tiles, the view shows through to what is
 *  behind the ground (we-specials-5, 2026-11-18: the white quads of SD and the blue ones of HD at the footprint's edge,
 *  the black inside of a cave; Studio drew the ground there). */
export function planCliffs(t: Terrain, types: Map<string, CliffType>, exists: (path: string) => boolean,
  hidden: ReadonlySet<number> = new Set()): CliffPlan {
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
      retexture: (p: string, slot?: string) => cliffRetexture(p, type, slot), retextureKey: texture,
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
  const hiddenTiles = [...hidden].filter((i) => i >= 0 && i < tw * (t.height - 1));
  // The blocks (rampSides) a model of the cliff type's ramp folder exists for; the others are ordinary cliffs.
  rampSides(t, ({ x: bx, y: by, w: bw, outer, base, tiles }) => {
    const name = outer.map((c) => (c.ramp ? "LHX" : "ABC")[c.layer - base]).join("");
    const type = list[cliffSlot(outer[0].cliffTexture)] ?? list[0];
    if (!type?.rampModelDir) return false;
    const path = `Doodads\\Terrain\\${type.rampModelDir}\\${type.rampModelDir}${name}0.mdx`;
    if (!exists(path)) return false;
    // A block a special covers part of is left to the ordinary cliffs below, which skip only the special's tiles.
    if (tiles.some((i) => hidden.has(i))) return false;
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
      const type = list[cliffSlot(bl.cliffTexture)] ?? list[0];
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
      if (!hidden.has(y * tw + x)) add(path, type, world, [y * tw + x]);
    }
  }
  return { requests: [...byPath.values()], groundOverrides, hiddenTiles };
}
