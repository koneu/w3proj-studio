import assert from "node:assert/strict";
import { test } from "node:test";
import { layoutPicture, slotColor } from "./layoutpicture";
import type { Corner } from "./w3e";

const corner = (over: Partial<Corner> = {}): Corner => ({
  height: 0, water: 0, texture: 0, variation: 0, cliffVariation: 0, cliffTexture: 15, layer: 2, ramp: false, blight: false, hasWater: false, boundary: false, rawHeight: 0x2000, rawWater: 0, texExtra: 0, ...over,
});

test("the layout editor's picture: a pixel per corner in its slot's colour, north up, water tinted, boundary darker", () => {
  // 3×2 corners: the south row slots 0 1 2, the north row water, boundary, plain slot 1.
  const corners = [corner({ texture: 0 }), corner({ texture: 1 }), corner({ texture: 2 }), corner({ hasWater: true, water: 100 }), corner({ boundary: true }), corner({ texture: 1 })];
  const colors = [[200, 0, 0], [0, 200, 0], [0, 0, 200]] as [number, number, number][];
  const px = layoutPicture({ width: 3, height: 2, corners }, (i) => colors[i], [0, 0, 255]);
  const at = (x: number, row: number) => [...px.slice((row * 3 + x) * 4, (row * 3 + x) * 4 + 4)];
  // Row 0 of the picture is the north row.
  assert.deepEqual(at(2, 0), [0, 200, 0, 255], "north-east: slot 1, flat");
  assert.deepEqual(at(0, 1), [200, 0, 0, 255], "south-west: slot 0");
  assert.deepEqual(at(2, 1), [0, 0, 200, 255]);
  assert.ok(at(0, 0)[2] > 100 && at(0, 0)[0] < 120, `water is blue: ${at(0, 0)}`);
  assert.ok(at(1, 0)[0] < 100 && at(1, 0)[1] < 100, `boundary is dark: ${at(1, 0)}`);
  // Slopes: a corner whose south-east is higher than its north-west is darker than flat ground.
  const slope = layoutPicture({ width: 3, height: 3, corners: Array.from({ length: 9 }, (_, i) => corner({ height: (i % 3 - Math.floor(i / 3)) * 100 })) }, () => [100, 100, 100]);
  const mid = slope[(1 * 3 + 1) * 4];
  assert.ok(mid !== 100, "a slope is shaded");
  // Without the game: far apart colours, the same every time.
  assert.deepEqual(slotColor(3), slotColor(3));
  assert.notDeepEqual(slotColor(0), slotColor(1));
});
