import assert from "node:assert/strict";
import { test } from "node:test";
import { borderShade } from "./area";

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
