import assert from "node:assert/strict";
import { test } from "node:test";
import { borderShade } from "./area";
import { markMapEdge, setWaterLevel, type Corner, type Terrain } from "./w3e";

test("the border's shade covers the tiles past the playable map, on each side", () => {
  // Left 1, right 2, bottom 1, top 0, on 5 by 3 tiles.
  const rgba = borderShade(5, 3, [1, 2, 1, 0]);
  const dark = (x: number, y: number) => rgba[(y * 5 + x) * 4 + 3] > 0;
  const rows = [0, 1, 2].map((y) => [0, 1, 2, 3, 4].map((x) => (dark(x, y) ? "#" : ".")).join(""));
  assert.deepEqual(rows, ["#####", "#..##", "#..##"]);
});

test("no border, no shade", () => {
  assert.equal(borderShade(4, 4, [0, 0, 0, 0]).some((v) => v !== 0), false);
  assert.equal(borderShade(4, 4).some((v) => v !== 0), false);
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
