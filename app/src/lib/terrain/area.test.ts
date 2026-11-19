import assert from "node:assert/strict";
import { test } from "node:test";
import { BORDER_ALPHA, BORDER_SPREAD, borderShade, borderShadeRect, darkWaterCorners, hdBorderKeep, isBackdrop, type BorderSpread } from "./area";
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

/** The border shade's alpha (0 to 1) at world (x, y), sampled as the GPU's linear filter reads the texture over its rect
 *  (area.ts borderShadeRect; clamped at the edges). */
function shadeAt(t: Terrain, edge: Uint8Array, spread: BorderSpread, x: number, y: number): number {
  const { rgba, width, height } = borderShade(t, edge, spread);
  const [rx, ry, rw, rh] = borderShadeRect(t, spread);
  const u = ((x - rx) / rw) * width - 0.5, v = ((y - ry) / rh) * height - 0.5;
  const at = (i: number, j: number) => rgba[(Math.min(height - 1, Math.max(0, j)) * width + Math.min(width - 1, Math.max(0, i))) * 4 + 3] / 255;
  const i = Math.floor(u), j = Math.floor(v), fu = u - i, fv = v - j;
  return (at(i, j) * (1 - fu) + at(i + 1, j) * fu) * (1 - fv) + (at(i, j + 1) * (1 - fu) + at(i + 1, j + 1) * fu) * fv;
}

/** How far inside an edge the shade's alpha falls to half of BORDER_ALPHA (`shade(d)`: the alpha d units inside). */
function halfInside(shade: (d: number) => number): number {
  const half = BORDER_ALPHA / 255 / 2;
  for (let d = 0; d < 200; d += 0.25) if (shade(d) <= half) return d;
  return Infinity;
}

test("the border's shade reaches a further half cell in where the editor's does: HD on every side, SD west and east", () => {
  // 10 by 10 tiles from 0, 0; left 2, right 2, bottom 2, top 2: the playable edges at 256 and 1024 on both axes.
  const t = marked(10, 10, [2, 2, 2, 2]), edge = mapEdgeTiles(t);
  const sides = (spread: BorderSpread) => ({
    west: halfInside((d) => shadeAt(t, edge, spread, 256 + d, 640)),
    east: halfInside((d) => shadeAt(t, edge, spread, 1024 - d, 640)),
    south: halfInside((d) => shadeAt(t, edge, spread, 640, 256 + d)),
    north: halfInside((d) => shadeAt(t, edge, spread, 640, 1024 - d)),
  });
  // we-drive 2026-11-19 (nv-L.w3x, game view, oblique): the editor's half 37 units in on every side in HD; in SD 30.6
  // west, 39.0 east, 13.5 south, 22.4 north. Corners on every side (Studio before, the control) put it at 16.
  assert.deepEqual(sides({ x: false, y: false }), { west: 16, east: 16, south: 16, north: 16 });
  assert.deepEqual(sides(BORDER_SPREAD.hd), { west: 32, east: 32, south: 32, north: 32 });
  assert.deepEqual(sides(BORDER_SPREAD.sd), { west: 32, east: 32, south: 16, north: 16 });
  // Past the edge and well inside, the same as before: full shade one cell out, none two cells in.
  for (const spread of [BORDER_SPREAD.hd, BORDER_SPREAD.sd]) {
    assert.equal(shadeAt(t, edge, spread, 256 - 32, 640), BORDER_ALPHA / 255);
    assert.equal(shadeAt(t, edge, spread, 640, 1024 + 32), BORDER_ALPHA / 255);
    assert.equal(shadeAt(t, edge, spread, 256 + 64, 640), 0);
    assert.equal(shadeAt(t, edge, spread, 640, 640), 0);
  }
  // The texture's size and place: a texel per cell's middle along a spread axis, per corner along the other.
  assert.deepEqual(borderShadeRect(t, BORDER_SPREAD.sd), [0, -16, 1280, 1312]);
  const { width, height } = borderShade(t, edge, BORDER_SPREAD.sd);
  assert.deepEqual([width, height], [40, 41]);
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

test("HD's border keeps the shade's 1 - a in linear light: the editor's dark land past the edge", () => {
  const dec = (v: number) => ((v / 255 + 0.055) / 1.055) ** 2.4;
  const enc = (l: number) => 255 * (l <= 0.0031308 ? l * 12.92 : 1.055 * l ** (1 / 2.4) - 0.055);
  const keep = hdBorderKeep(BORDER_ALPHA / 255);
  // we-drive 2026-11-19, ws-L and ws-A (make-water-tilesets.mjs --shore), HD, game view, from above: the land inside
  // and past the west edge.
  const seen: [number[], number[]][] = [[[133.2, 92.6, 26.3], [14.5, 7.0, 1.0]], [[31.1, 34.7, 44.7], [1.0, 1.0, 1.8]]];
  for (const [inside, past] of seen) {
    inside.forEach((v, i) => assert.ok(Math.abs(enc(dec(v) * keep) - past[i]) <= 1, `${v} keeps ${enc(dec(v) * keep).toFixed(1)}, the editor ${past[i]}`));
  }
  // The control: SD's plain share of the sRGB value (Studio's HD before) is 4 to 7 levels off on Lordaeron's land.
  assert.ok(Math.abs(133.2 * (1 - BORDER_ALPHA / 255) - 14.5) > 4 || Math.abs(92.6 * (1 - BORDER_ALPHA / 255) - 7.0) > 4);
  assert.equal(hdBorderKeep(0), 1);
  assert.equal(hdBorderKeep(1), 0);
  assert.ok(Math.abs(keep - 0.0185) < 0.0005);
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

test("trees and doodads may stand in the border, units and items may not", () => {
  const playable = { left: 0, bottom: 0, right: 1000, top: 1000 }, whole = { left: -500, bottom: -500, right: 1500, top: 1500 };
  assert.equal(isBackdrop("w3b", -100, 500, playable, whole), true);
  assert.equal(isBackdrop("w3d", 1200, 1200, playable, whole), true);
  assert.equal(isBackdrop("w3u", -100, 500, playable, whole), false);
  assert.equal(isBackdrop("w3t", -100, 500, playable, whole), false);
  assert.equal(isBackdrop("w3b", 500, 500, playable, whole), false, "inside, the ground still decides");
  assert.equal(isBackdrop("w3b", -900, 500, playable, whole), false, "off the map altogether");
  assert.equal(isBackdrop("w3b", -100, 500, null, whole), false, "bounds unknown: no exception");
});
