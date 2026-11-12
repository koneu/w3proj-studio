import assert from "node:assert/strict";
import { test } from "node:test";
import { borderShade, darkWaterCorners } from "./area";
import { mapEdgeTiles, markMapEdge, onBoundary, setWaterLevel, type Corner, type Terrain } from "./w3e";

/** A terrain of `tilesX` by `tilesY` tiles, its map edge marked for these complements (left, right, bottom, top). */
function marked(tilesX: number, tilesY: number, complements: number[]): Terrain {
  const corners = Array.from({ length: (tilesX + 1) * (tilesY + 1) }, () => ({ rawWater: 0x2000 }) as Corner);
  const t = { width: tilesX + 1, height: tilesY + 1, offsetX: 0, offsetY: 0, corners } as Terrain;
  markMapEdge(t, complements);
  return t;
}

test("the border's shade covers the tiles the terrain marks as past the playable map, fading over the first playable cell", () => {
  // Left 1, right 2, bottom 1, top 0, on 5 by 3 tiles: texels on the pathing cells' corners, 21 by 13.
  const { rgba, width, height } = borderShade(marked(5, 3, [1, 2, 1, 0]));
  assert.deepEqual([width, height], [21, 13]);
  const a = (x: number, y: number) => rgba[(y * width + x) * 4 + 3];
  // Row 8 (inside the bottom border's reach): dark up to the corner on the playable edge (x 4), clear from the first
  // playable cell's far corner (x 5) to the last one before the right border (x 11), dark again from its edge (x 12).
  const row = [...Array(width).keys()].map((x) => (a(x, 8) ? "#" : ".")).join("");
  assert.equal(row, "#####.......#########");
  // The bottom border's top edge (y 4) is dark, the next corner row clear; the top row (no border there) clear inside.
  assert.equal(a(8, 4), 218);
  assert.equal(a(8, 5), 0);
  assert.equal(a(8, 12), 0);
  assert.ok([...rgba].every((v, i) => i % 4 === 3 || v === 0), "black");
});

test("no marks, no shade, whatever the w3i says: the editor goes by the terrain's marks", () => {
  // HillsbradCreek-like: a border in the w3i, but these corners carry no mark (a map made before Studio marked them).
  const t = marked(4, 4, [0, 0, 0, 0]);
  assert.equal(borderShade(t).rgba.some((v) => v !== 0), false);
  assert.equal(mapEdgeTiles(t).some((v) => v !== 0), false);
  // A stale mark inside the playable part (corner 2, 2) darkens that tile all the same.
  t.corners[2 * 5 + 2].rawWater |= 0x4000;
  assert.deepEqual([...mapEdgeTiles(t)].map((v, i) => (v ? i : -1)).filter((i) => i >= 0), [2 * 4 + 2]);
  assert.ok(borderShade(t).rgba[(10 * 17 + 10) * 4 + 3] > 0);
});

test("the border's water is black at corners whose tiles are all past the playable map, lit on the playable edge", () => {
  // 6 by 4 tiles, left 2, right 1, bottom 1, top 1.
  const t = marked(6, 4, [2, 1, 1, 1]);
  const dark = darkWaterCorners(t);
  const rows = [4, 3, 2, 1, 0].map((y) => [0, 1, 2, 3, 4, 5, 6].map((x) => (dark[y * 7 + x] ? "#" : ".")).join(""));
  // Corner columns 0 and 1 (left of the playable edge at 2), 6 and the outer rim on the right; rows 0 and 4.
  assert.deepEqual(rows, ["#######", "##....#", "##....#", "##....#", "#######"]);
});

test("the map edge marks each tile past the playable map at its lower left corner, as the World Editor's maps do", () => {
  // 4 by 3 tiles, so 5 by 4 corners. Left 1, right 1, bottom 0, top 1.
  const corners = Array.from({ length: 20 }, () => ({ rawWater: 0x2000 + 5 }) as Corner);
  corners[0].rawWater |= 0x8000;
  corners[7].rawWater |= 0x4000; // Stale: inside the map.
  const t = { width: 5, height: 4, corners } as Terrain;
  markMapEdge(t, [1, 1, 0, 1]);
  const rows = [0, 1, 2, 3].map((y) => [0, 1, 2, 3, 4].map((x) => (corners[y * 5 + x].rawWater & 0x4000 ? "#" : ".")).join(""));
  assert.deepEqual(rows, ["#..#.", "#..#.", "####.", "....."]);
  assert.equal(corners[0].rawWater & 0x3fff, 0x2000 + 5, "the water level stays");
  assert.equal(corners[0].rawWater & 0x8000, 0x8000, "the other bit stays");
  setWaterLevel(corners[0], 0x2100);
  assert.equal(corners[0].rawWater & 0x4000, 0x4000, "a new water level keeps the mark");
});

test("a tile counts as Boundary when one of its corners is painted, the same tiles the view darkens", () => {
  const corners = Array.from({ length: 16 }, () => ({ boundary: false }) as Corner);
  corners[5].boundary = true; // Corner (1, 1), at world 128, 128.
  const t = { width: 4, height: 4, offsetX: 0, offsetY: 0, corners } as Terrain;
  assert.equal(onBoundary(t, 64, 64), true, "the tile south-west of it");
  assert.equal(onBoundary(t, 200, 200), true, "the tile north-east of it");
  assert.equal(onBoundary(t, 300, 64), false, "two tiles away");
  assert.equal(onBoundary(t, -10, 64), false, "off the map");
  assert.equal(onBoundary(t, 64, 400), false, "past the last row of tiles");
});
