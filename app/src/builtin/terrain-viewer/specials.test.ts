import assert from "node:assert/strict";
import { test } from "node:test";
import { heightAt, setGroundHeight, setLayer, type Terrain } from "../../lib/terrain/w3e";
import { planCliffs, type CliffType } from "./cliffs";
import { modelPath, type Skin } from "./objects";
import { SPECIAL_FACING, specialBase, specialCliffTiles, specialCliffType, specialPlacements, specialTextures, specialTiles } from "./specials";

const skin = (file: string): Skin => ({
  kind: "w3d", file, numVar: 1, texId: -1, texFile: "", modelScale: 1, minScale: 1, maxScale: 1.2, randScale: false, fixedRot: null, uberSplat: "",
});
const skins = new Map([["YCl2", skin("Doodads\\Terrain\\CliffDoodad\\Collapse\\Collapse")]]);
const offset = { x: -1024, y: -512 };

test("a special doodad stands in the middle of its pathing footprint, whose bottom left is its tile's, on the ground", () => {
  const out = specialPlacements([{ id: "YCl2", x: 3, y: 2 }], skins, () => ({ width: 4, height: 8 }), offset, (x, y) => x + y);
  assert.equal(out.length, 1);
  // Tile (3, 2): corner (-1024 + 384, -512 + 256); half the footprint (4 x 8 cells of 32) on.
  assert.deepEqual(out[0].position, [-1024 + 384 + 64, -512 + 256 + 128, -1024 + 384 + 64 - 512 + 256 + 128]);
  assert.equal(out[0].angle, SPECIAL_FACING);
  assert.deepEqual(out[0].scale, [1, 1, 1]);
  assert.equal(modelPath(skins.get(out[0].id)!, out[0].variation), "Doodads\\Terrain\\CliffDoodad\\Collapse\\Collapse.mdx");
});

test("a special doodad without a model is left out, one without a footprint stands in its tile's middle", () => {
  const out = specialPlacements([{ id: "ZZZZ", x: 0, y: 0 }, { id: "YCl2", x: 1, y: 1 }], skins, () => undefined, offset, () => 5);
  assert.deepEqual(out.map((p) => p.id), ["YCl2"]);
  assert.deepEqual(out[0].position, [-1024 + 128 + 64, -512 + 128 + 64, 5]);
});

test("the control: a footprint of another size moves the middle", () => {
  const at = (w: number) => specialPlacements([{ id: "YCl2", x: 0, y: 0 }], skins, () => ({ width: w, height: w }), offset, () => 0)[0].position[0];
  assert.notEqual(at(4), at(8));
});

const TYPES: CliffType[] = [
  { cliffID: "CFgr", cliffModelDir: "Cliffs", rampModelDir: "CliffTrans", texDir: "TerrainArt\\LordaeronFall", texFile: "Lordf_Cliff1", groundTile: "Fgrs" },
  { cliffID: "CFdi", cliffModelDir: "Cliffs", rampModelDir: "CliffTrans", texDir: "TerrainArt\\LordaeronFall", texFile: "Lordf_Cliff0", groundTile: "Fdrt" },
];

/** 6 × 6 tiles from `offset`: corners x 0..2 on layer 4 (ground -64), x 3..6 on layer 5 (ground 10), so tiles x = 2
 *  are a cliff one layer high; corners from row 4 up take the second cliff type. */
function cliffMap(): Terrain {
  const width = 7, height = 7;
  return {
    version: 11, tileset: "F", customTilesets: false, customTilesetsRaw: 0, groundTiles: ["Fgrs", "Fdrt"], cliffTiles: ["CFgr", "CFdi"],
    width, height, offsetX: offset.x, offsetY: offset.y, trailer: new Uint8Array(0),
    corners: Array.from({ length: width * height }, (_, i) => {
      const x = i % width, y = Math.floor(i / width);
      const c = {
        height: 0, water: 0, texture: 0, variation: 0, cliffVariation: 0, cliffTexture: y >= 4 ? 1 : 0, layer: 2,
        ramp: false, blight: false, hasWater: false, boundary: false, rawHeight: 0x2000, rawWater: 0x2000, texExtra: 0,
      };
      setLayer(c, x <= 2 ? 4 : 5);
      setGroundHeight(c, x <= 2 ? -64 : 10);
      return c;
    }),
  };
}

test("a special covers the tiles of its footprint (4 cells a tile), its own tile without one", () => {
  assert.deepEqual(specialTiles({ x: 2, y: 1 }, { width: 4, height: 8 }), { x0: 2, y0: 1, x1: 2, y1: 2 });
  assert.deepEqual(specialTiles({ x: 2, y: 1 }, { width: 6, height: 16 }), { x0: 2, y0: 1, x1: 3, y1: 4 });
  assert.deepEqual(specialTiles({ x: 2, y: 1 }, undefined), { x0: 2, y0: 1, x1: 2, y1: 1 });
});

test("a special stands on the lowest layer of the corners it covers, as a cliff model does, not on the ground at its middle", () => {
  const t = cliffMap();
  const [p] = specialPlacements([{ id: "YCl2", x: 2, y: 1 }], skins, () => ({ width: 4, height: 8 }), offset, (_x, _y, tiles) => specialBase(t, tiles));
  // Corners x 2..3, y 1..3: layers 4 and 5; the model (0 to 128 high) spans the cliff from layer 4 to layer 5, the
  // ground's own height comes per vertex (the batch follows the ground).
  assert.equal(p.position[2], (4 - 2) * 128);
  // The ground at the model's middle (half way up the cliff: 293) would float it, its top 35 above the high side: the
  // flat square the editor doesn't show.
  assert.ok(heightAt(t, p.position[0], p.position[1]) - p.position[2] > 32);
  // Control: on the high side only, it stands on layer 5.
  assert.equal(specialBase(t, { x0: 4, y0: 1, x1: 4, y1: 1 }), (5 - 2) * 128);
  // Past the map's edge the corners inside count.
  assert.equal(specialBase(t, { x0: 5, y0: 5, x1: 9, y1: 9 }), (5 - 2) * 128);
});

test("a special takes the cliff type of the bottom-left corner of the tile under its origin, as a cliff model does", () => {
  const t = cliffMap();
  // Origin in tile (2, 1): corner (2, 1) has the first type; in tile (2, 4) the second.
  assert.equal(specialCliffType(t, TYPES, offset.x + 2.5 * 128, offset.y + 1.5 * 128)?.cliffID, "CFgr");
  assert.equal(specialCliffType(t, TYPES, offset.x + 2.5 * 128, offset.y + 4.5 * 128)?.cliffID, "CFdi");
  // An index past the list (15: reserved) is the first type; no types, none.
  t.corners[1 * t.width + 2].cliffTexture = 15;
  assert.equal(specialCliffType(t, TYPES, offset.x + 2.5 * 128, offset.y + 1.5 * 128)?.cliffID, "CFgr");
  assert.equal(specialCliffType(t, [], offset.x, offset.y), undefined);
});

test("a special's cliff part shows its cliff type's texture, classic and HD, not the game's generic Cliff0", () => {
  const look = specialTextures(TYPES[1]);
  assert.deepEqual(look.replaceable, { 11: "TerrainArt\\LordaeronFall\\Lordf_Cliff0.blp" });
  // HD models: replaceable 11 sets (renderer: X_Diffuse…) and the cave's #ignore_Cliffs placeholders.
  assert.equal(look.retexture?.("Doodads/Terrain/#ignore_Cliffs/Cliff1_Normal.tif"), "TerrainArt\\LordaeronFall\\Lordf_Cliff0_Normal.blp");
  assert.equal(look.retexture?.("Textures/CaveCliffDoodad_Diffuse.tif"), "Textures/CaveCliffDoodad_Diffuse.tif");
  assert.notEqual(specialTextures(TYPES[0]).key, look.key, "the types are drawn apart");
});

test("the cliff models leave a special's tiles to it: no model there, and no ground either", () => {
  const t = cliffMap(), tw = t.width - 1;
  const hidden = specialCliffTiles(t, [{ x0: 2, y0: 1, x1: 2, y1: 2 }, { x0: 5, y0: 5, x1: 8, y1: 8 }]);
  assert.deepEqual([...hidden].sort((a, b) => a - b), [1 * tw + 2, 2 * tw + 2, 5 * tw + 5]);
  const modelled = (h?: Set<number>) => planCliffs(t, new Map(TYPES.map((c) => [c.cliffID, c])), () => true, h).requests.flatMap((r) => r.tiles).sort((a, b) => a - b);
  // Control: without specials every tile of column 2 has its cliff.
  assert.deepEqual(modelled(), [0, 1, 2, 3, 4, 5].map((y) => y * tw + 2));
  assert.deepEqual(modelled(hidden), [0, 3, 4, 5].map((y) => y * tw + 2));
  const plan = planCliffs(t, new Map(TYPES.map((c) => [c.cliffID, c])), () => true, hidden);
  // Only cliff tiles are listed (tile (5, 5) is flat ground and stays drawn).
  assert.deepEqual(plan.hiddenTiles?.sort((a, b) => a - b), [1 * tw + 2, 2 * tw + 2]);
});
