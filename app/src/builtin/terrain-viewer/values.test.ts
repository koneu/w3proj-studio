import assert from "node:assert/strict";
import { test } from "node:test";
import { givenNumber, placedValueProblem } from "./values";

const map = { left: -3328, right: 3328, bottom: -3584, top: 3584 };

test("placed values in range are taken as they are", () => {
  assert.equal(placedValueProblem({ x: -3328, y: 3584, z: -500.5, facing: 725, scale: [0, 1, 2.5], variation: 4, numVar: 5, player: 27 }, map), null);
  assert.equal(placedValueProblem({}, map), null);
  assert.equal(placedValueProblem({ x: 1e6 }, null), null, "no map: x and y only have to be numbers");
});

test("a place off the map is refused, not moved onto its edge", () => {
  assert.match(placedValueProblem({ x: 3328.5 }, map) ?? "", /x 3328.5 is off the map \(x goes from -3328 to 3328\)/);
  assert.match(placedValueProblem({ x: -4000 }, map) ?? "", /x -4000 is off the map/);
  assert.match(placedValueProblem({ y: 3600 }, map) ?? "", /y 3600 is off the map \(y goes from -3584 to 3584\)/);
  assert.match(placedValueProblem({ y: -32256 }, map) ?? "", /y -32256 is off the map/);
});

test("a number a placement file can't store (not finite, past a 32-bit float) is refused", () => {
  for (const k of ["x", "y", "z", "facing"] as const) {
    for (const v of [NaN, Infinity, -Infinity, 1e39, "12" as unknown as number]) {
      assert.match(placedValueProblem({ [k]: v }, null) ?? "", new RegExp(`^${k} must be a number`), `${k} ${v}`);
    }
  }
});

test("a scale below 0 or not a number is refused; 0 is a doodad's random size", () => {
  for (const s of [-0.1, NaN, Infinity, 1e39]) assert.match(placedValueProblem({ scale: [1, s, 1] }, null) ?? "", /scale must be a number from 0 up/);
  assert.equal(placedValueProblem({ scale: [0, 0, 0] }, null), null);
});

test("a variation the type hasn't got is refused, not moved to its last one", () => {
  for (const v of [5, -1, 1.5, NaN, Infinity]) assert.match(placedValueProblem({ variation: v, numVar: 5 }, null) ?? "", /variation goes from 0 to 4/);
  assert.match(placedValueProblem({ variation: 1 }, null) ?? "", /one variation: 0/);
  assert.equal(placedValueProblem({ variation: 0 }, null), null);
});

test("an owner past player 28 or below player 1 is refused, not held to the nearest", () => {
  for (const p of [-1, 28, 1.5, NaN]) assert.match(placedValueProblem({ player: p }, null) ?? "", /player 1 to 28/);
  assert.equal(placedValueProblem({ player: 0 }, null), null);
});

test("a tool's number setting outside its range is refused, not held to the nearest end; left out, it's the default", () => {
  const edge = { min: 0, max: 1, fallback: 0.4 };
  assert.equal(givenNumber("edge", undefined, edge), 0.4);
  assert.equal(givenNumber("edge", 0, edge), 0);
  assert.equal(givenNumber("edge", 1, edge), 1);
  for (const v of [-0.1, 1.5, NaN, Infinity, "0.5", null]) assert.throws(() => givenNumber("edge", v, edge), /^Error: edge must be a number from 0 to 1\.$/, String(v));
  const count = { min: 1, max: 30, whole: true, fallback: 12 };
  for (const v of [0, 31, 2.5]) assert.throws(() => givenNumber("count", v, count), /count must be a whole number from 1 to 30\./);
  const width = { min: 0, max: Infinity, above: true, fallback: 256 };
  for (const v of [0, -5, Infinity]) assert.throws(() => givenNumber("width", v, width), /^Error: width must be a number above 0\.$/);
  assert.equal(givenNumber("width", 0.5, width), 0.5);
  assert.throws(() => givenNumber("limit", 0, { min: 1, max: Infinity, whole: true, fallback: 3000 }), /limit must be a whole number from 1 up\./);
});
