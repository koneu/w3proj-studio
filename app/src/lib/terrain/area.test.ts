import assert from "node:assert/strict";
import { test } from "node:test";
import { borderShade, darkWaterCorners } from "./area";
import { mapEdgeTiles, markMapEdge, onBoundary, playableEdgeTiles, setWaterLevel, validComplements, type Corner, type Terrain } from "./w3e";

/** A terrain of `tilesX` by `tilesY` tiles, its map edge marked for these complements (left, right, bottom, top). */
function marked(tilesX: number, tilesY: number, complements: number[]): Terrain {
  const corners = Array.from({ length: (tilesX + 1) * (tilesY + 1) }, () => ({ rawWater: 0x2000 }) as Corner);
  const t = { width: tilesX + 1, height: tilesY + 1, offsetX: 0, offsetY: 0, corners } as Terrain;
  markMapEdge(t, complements);
  return t;
}

test("the border's shade covers the tiles the terrain marks as past the playable map, fading over the first playable cell", () => {
  // Left 1, right 2, bottom 1, top 0, on 5 by 3 tiles: texels on the pathing cells' corners, 21 by 13.
  const { rgba, width, height } = borderShade({ width: 6, height: 4 }, playableEdgeTiles({ width: 6, height: 4 }, [1, 2, 1, 0]));
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

test("the tiles past the playable map come from the w3i's complements, whatever the terrain's marks say", () => {
  // As the World Editor (we-drive, AutumnLeaves_S2 with the w3i's left margin 23 and the marks' 15, and the other way
  // round: the dark edge followed the w3i both times). 6 by 4 tiles; the w3i says left 2, right 1, bottom 1, top 0.
  const t = marked(6, 4, [0, 0, 0, 0]);
  t.corners[2 * 7 + 3].rawWater |= 0x4000; // A stale mark inside.
  const rows = (tiles: Uint8Array) => [3, 2, 1, 0].map((y) => [...tiles.slice(y * 6, y * 6 + 6)].map((v) => (v ? "#" : ".")).join(""));
  assert.deepEqual(rows(playableEdgeTiles(t, [2, 1, 1, 0])), ["##...#", "##...#", "##...#", "######"]);
  assert.deepEqual(rows(mapEdgeTiles(t)), ["......", "...#..", "......", "......"], "the marks are another thing");
  // Agreeing marks give the same tiles (markMapEdge writes them from the same rule).
  assert.deepEqual(mapEdgeTiles(marked(6, 4, [2, 1, 1, 0])), playableEdgeTiles(t, [2, 1, 1, 0]));
  // The shade covers what it's given, not the marks.
  const shade = borderShade(t, playableEdgeTiles(t, [2, 1, 1, 0])).rgba, width = 6 * 4 + 1;
  assert.equal(shade[(10 * width + 2) * 4 + 3], 218, "west border");
  assert.equal(shade[(10 * width + 14) * 4 + 3], 0, "the stale mark's tile stays lit");
  // Margins wider than the map leave nothing playable; an empty w3i rule nothing past it.
  assert.ok(playableEdgeTiles(t, [9, 9, 9, 9]).every((v) => v === 1));
  assert.ok(playableEdgeTiles(t, [0, 0, 0, 0]).every((v) => v === 0));
});

test("only four whole numbers from 0 up stand for the playable map", () => {
  assert.deepEqual(validComplements([15, 15, 15, 15]), [15, 15, 15, 15]);
  for (const bad of [undefined, null, [1, 2, 3], [1, 2, 3, 4, 5], [1, 2, -1, 4], [1, 2, 3.5, 4], ["1", 2, 3, 4], { 0: 1 }]) {
    assert.equal(validComplements(bad), null, JSON.stringify(bad));
  }
});

test("the classic water is black at corners whose north-east tile is past the playable map, as the editor's", () => {
  // 6 by 4 tiles, left 2, right 1, bottom 1, top 1.
  const t = marked(6, 4, [2, 1, 1, 1]);
  const dark = darkWaterCorners(t, mapEdgeTiles(t));
  const rows = [4, 3, 2, 1, 0].map((y) => [0, 1, 2, 3, 4, 5, 6].map((x) => (dark[y * 7 + x] ? "#" : ".")).join(""));
  // West and south: the corners on the playable edge (column 2, row 1) lit, so the fade lies in the last border tile.
  // East and north: the corners on the playable edge (column 5, row 3) dark, so it lies in the last playable tile.
  assert.deepEqual(rows, ["#######", "#######", "##...##", "##...##", "#######"]);
  assert.equal(darkWaterCorners({ width: 1, height: 1 }, new Uint8Array(0)).length, 1, "no tiles");
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
