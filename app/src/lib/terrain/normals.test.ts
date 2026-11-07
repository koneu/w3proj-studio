import assert from "node:assert/strict";
import { test } from "node:test";
import { cornerNormal, type Corner, type Terrain } from "./w3e";

/** Rows from the north, a char per corner: a digit is its cliff layer, `r` a ramp corner on layer 2, `R` one on layer 3.
 *  Ground height is `slope` per x. */
function land(rows: string[], slope = 0): Terrain {
  const height = rows.length, width = rows[0].length;
  const corners: Corner[] = [];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const ch = rows[height - 1 - y][x];
    const ramp = ch === "r" || ch === "R";
    const layer = ch === "r" ? 2 : ch === "R" ? 3 : Number(ch);
    corners.push({ layer, ramp, rawHeight: x * slope * 4 + 0x2000, height: x * slope + (layer - 2) * 128 } as Corner);
  }
  return { width, height, offsetX: 0, offsetY: 0, corners } as Terrain;
}
const tilt = (n: number[]) => (Math.acos(n[2]) * 180) / Math.PI;

test("flat ground beside a cliff has an upright normal", () => {
  // Layer 3 in the north (rows y=3,4), layer 2 below; the cliff runs between y=2 and y=3.
  const t = land(["33333", "33333", "22222", "22222", "22222"]);
  for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) {
    assert.ok(tilt(cornerNormal(t, x, y)) < 1e-6, `corner ${x},${y} is ${tilt(cornerNormal(t, x, y))} degrees off`);
  }
});

test("a real slope still tilts, on any layer", () => {
  const t = land(["33333", "33333", "22222", "22222", "22222"], 32);
  const want = (Math.atan((32 * 2) / 256) * 180) / Math.PI;
  assert.ok(Math.abs(tilt(cornerNormal(t, 2, 0)) - want) < 1e-6);
  assert.ok(Math.abs(tilt(cornerNormal(t, 2, 4)) - want) < 1e-6);
  assert.ok(cornerNormal(t, 2, 0)[0] < 0, "tilts away from the rising side");
});

test("a ramp slopes across its layers", () => {
  const t = land(["2rrR3", "2rrR3", "2rrR3"]);
  const n = cornerNormal(t, 2, 1);
  assert.ok(tilt(n) > 20, `ramp tilts (${tilt(n)})`);
  assert.ok(n[0] < 0, "rises to the east");
});

test("ground beside a ramp is not tilted by the ramp's layers", () => {
  const t = land(["22222", "2rRR3", "22222"]);
  assert.ok(tilt(cornerNormal(t, 0, 1)) < 1e-6);
});

const deg = (slope: number) => (Math.atan(slope) * 180) / Math.PI;

test("a one-row ramp shades its end corners as the slope they draw", () => {
  const t = land(["22233", "2rrR3", "22222"]);
  // Drawn heights along the row: 0, 0, 64, 128, 128 at 128 per tile.
  assert.ok(Math.abs(tilt(cornerNormal(t, 1, 1)) - deg(64 / 256)) < 1e-6, `low end ${tilt(cornerNormal(t, 1, 1))}`);
  assert.ok(Math.abs(tilt(cornerNormal(t, 3, 1)) - deg(64 / 256)) < 1e-6, `high end ${tilt(cornerNormal(t, 3, 1))}`);
  assert.ok(Math.abs(tilt(cornerNormal(t, 2, 1)) - deg(128 / 256)) < 1e-6, "middle");
});

test("the sides of a ramp and a cliff beside it stay upright across the ramp", () => {
  const t = land(["22233", "2rrR3", "22222"]);
  for (const x of [1, 2, 3]) for (const y of [0, 2]) {
    const n = cornerNormal(t, x, y);
    assert.ok(Math.abs(n[1]) < 1e-6, `corner ${x},${y} has no tilt across the ramp (${n[1]})`);
  }
  assert.ok(Math.abs(cornerNormal(t, 3, 1)[1]) < 1e-6, "ramp corner next to the cliff");
});

test("an edge corner tilts as much as the slope it is on", () => {
  const t = land(["22222", "22222", "22222"], 32);
  const want = deg(32 / 128);
  assert.ok(Math.abs(tilt(cornerNormal(t, 0, 1)) - want) < 1e-6, `west edge ${tilt(cornerNormal(t, 0, 1))}`);
  assert.ok(Math.abs(tilt(cornerNormal(t, 4, 1)) - want) < 1e-6, "east edge");
  assert.ok(Math.abs(tilt(cornerNormal(t, 2, 1)) - want) < 1e-6, "inside");
});
