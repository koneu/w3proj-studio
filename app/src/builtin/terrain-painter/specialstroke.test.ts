import assert from "node:assert/strict";
import { test } from "node:test";
import { setLayer, type Terrain } from "../../lib/terrain/w3e";
import { specialFits, specialsAfterCliffs, type SpecialTexture } from "../../lib/terrain/specialfit";
import { applyLayer, brushOf, paintTexture, Stroke } from "./tools";

/** A pathing texture `w` × `h` cells whose alpha is `alpha(cell x, cell y from the south)` (rows stored from the top). */
function pathTex(w: number, h: number, alpha: (x: number, y: number) => number): SpecialTexture {
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let r = 0; r < h; r++) for (let x = 0; x < w; x++) rgba[(r * w + x) * 4 + 3] = alpha(x, h - 1 - r);
  return { width: w, height: h, rgba };
}
// As the game's: YCp2 (CliffCollapse1Path) two layers up to the east, YCl2 ("Short") one, YCp1 two up to the north,
// YCx3 (a ruined floor) flat.
const TEX = new Map<string, SpecialTexture>([
  ["YCp2", pathTex(4, 8, (x) => (x < 2 ? 0 : 255))],
  ["YCl2", pathTex(4, 8, (x) => (x < 2 ? 127 : 255))],
  ["YCp1", pathTex(8, 4, (_x, y) => (y < 2 ? 0 : 255))],
  ["YCx3", pathTex(8, 8, () => 0)],
]);

/** 24 × 24 tiles, layer 2, with a two-layer cliff up to the east between corner columns 5 and 6 (x ≥ 6 on layer 4). */
function stepMap(): Terrain {
  const width = 25, height = 25;
  return {
    version: 11, tileset: "L", customTilesets: false, customTilesetsRaw: 0, groundTiles: ["Lgrs", "Ldrt"], cliffTiles: ["CLdi", "CLgr"],
    width, height, offsetX: -12 * 128, offsetY: -12 * 128, trailer: new Uint8Array(0),
    corners: Array.from({ length: width * height }, (_, i) => {
      const c = {
        height: 0, water: 0, texture: 0, variation: 0, cliffVariation: 0, cliffTexture: 0, layer: 2,
        ramp: false, blight: false, hasWater: false, boundary: false, rawHeight: 0x2000, rawWater: 0x2000, texExtra: 0,
      };
      setLayer(c, i % width >= 6 ? 4 : 2);
      return c;
    }),
  };
}

test("a special fits the cliff its pathing texture's alpha draws: its corners' layers, any base, its facing and height", () => {
  const t = stepMap(), fits = (id: string, x: number, y: number) => specialFits(t, { x, y }, TEX.get(id)!);
  // YCp2 1 × 2 tiles at tile 5: corners x 5 (layer 2) and 6 (layer 4), as on AutumnLeaves (24/24/24).
  assert.equal(fits("YCp2", 5, 3), true);
  // The ruined floor fits flat ground on either side, on any layer.
  assert.equal(fits("YCx3", 1, 1), true);
  assert.equal(fits("YCx3", 10, 1), true);
  // Controls: off the step (flat), across a step of one layer only, and the floor across the step, don't.
  assert.equal(fits("YCp2", 8, 3), false);
  assert.equal(fits("YCl2", 5, 3), false);
  assert.equal(fits("YCx3", 4, 1), false);
  // YCp1 wants its step to the north: not this east one.
  assert.equal(fits("YCp1", 5, 3), false);
  // One layer up, the short collapse fits (layers 4 | 5).
  for (let y = 0; y < t.height; y++) setLayer(t.corners[y * t.width + 7], 5);
  assert.equal(specialFits(t, { x: 6, y: 3 }, TEX.get("YCl2")!), true);
  // Off the map, a corner not open (a partial load) or a texture without cells: it can't be told.
  assert.equal(specialFits(t, { x: 24, y: 3 }, TEX.get("YCp2")!), undefined);
  assert.equal(specialFits(t, { x: 5, y: 3 }, TEX.get("YCp2")!, () => false), undefined);
  assert.equal(specialFits(t, { x: 5, y: 3 }, { width: 0, height: 0, rgba: [] }), undefined);
});

test("a Level and an Increase One stroke take out the specials left without their cliff, anywhere, and keep the rest (we-compare special-paint)", () => {
  const specials = [
    { id: "YCp2", z: 0, x: 5, y: 3 }, // on the step: fits
    { id: "YCp2", z: 0, x: 5, y: 15 }, // on the step, far from the strokes: fits
    { id: "YCx3", z: 0, x: 1, y: 18 }, // a floor on flat ground: fits
    { id: "YCp2", z: 0, x: 15, y: 15 }, // a made-up one on flat ground: fits nothing, goes on any cliff stroke
    { id: "ZZZZ", z: 0, x: 2, y: 2 }, // a type without a texture: can't be told, stays
    { bad: true }, // not a special: stays
  ];
  const after = (t: Terrain) => specialsAfterCliffs(t, specials, (id) => TEX.get(id));
  // Control: before any stroke only the made-up one doesn't fit.
  assert.deepEqual(after(stepMap()).removed.map((s) => [s.x, s.y]), [[15, 15]]);

  // Level (size 3) from the low side across the step under the first YCp2: its east corners come down to layer 2.
  const level = stepMap();
  assert.ok(applyLayer(level, brushOf("cliffLevel", level, level.offsetX + 6 * 128, level.offsetY + 4 * 128, 3), "cliffLevel", { layer: 2 }, new Stroke("cliffLevel")));
  const l = after(level);
  assert.deepEqual(l.removed.map((s) => [s.x, s.y]), [[5, 3], [15, 15]]);
  assert.deepEqual(l.kept, [specials[1], specials[2], specials[4], specials[5]]);

  // Increase One (size 3) on the high side, away from every special: the step's YCp2s keep their cliff.
  const up = stepMap(), us = new Stroke("cliffUp");
  assert.ok(applyLayer(up, brushOf("cliffUp", up, up.offsetX + 12 * 128, up.offsetY + 4 * 128, 3), "cliffUp", { layer: 5 }, us));
  assert.deepEqual(after(up).removed.map((s) => [s.x, s.y]), [[15, 15]]);
  // Increase One on a corner of the floor: a part of it a layer up, so it goes too.
  assert.ok(applyLayer(up, brushOf("cliffUp", up, up.offsetX + 1 * 128, up.offsetY + 19 * 128, 1), "cliffUp", { layer: 3 }, us));
  assert.deepEqual(after(up).removed.map((s) => [s.x, s.y]), [[1, 18], [15, 15]]);
});

test("a ground tile stroke changes no cliff layer: the specials fit as before (special-paint-ground)", () => {
  const t = stepMap();
  assert.ok(paintTexture(t, brushOf("paint", t, t.offsetX + 6 * 128, t.offsetY + 4 * 128, 3), 1, new Stroke("paint")));
  assert.equal(specialFits(t, { x: 5, y: 3 }, TEX.get("YCp2")!), true);
});
