import assert from "node:assert/strict";
import { test } from "node:test";
import { fogAmount, fogForCamera, fogOf } from "./fog";

const fog = { style: 0, start: 3000, end: 5000, density: 0.5, color: [255, 128, 0, 255] };

test("fog counts only when the map switches it on: most hold values they don't use", () => {
  assert.equal(fogOf({ flags: 0, fog }), null);
  assert.equal(fogOf({ flags: 0x10, fog }), null);
  assert.equal(fogOf({ flags: 0x2000 }), null, "older maps have no fog at all");
  assert.ok(fogOf({ flags: 0x2000 | 0x10, fog }));
});

test("the colour is stored blue first", () => {
  assert.deepEqual(fogOf({ flags: 0x2000, fog })?.color, [0, 128 / 255, 1]);
});

test("linear fog runs from start to end", () => {
  assert.equal(fogAmount(fog, 1000), 0);
  assert.equal(fogAmount(fog, 3000), 0);
  assert.equal(fogAmount(fog, 4000), 0.5);
  assert.equal(fogAmount(fog, 5000), 1);
  assert.equal(fogAmount(fog, 9000), 1);
});

test("a fog with no length is a wall, not a division by nothing", () => {
  const wall = { ...fog, start: 4000, end: 4000 };
  assert.equal(fogAmount(wall, 3999), 0);
  assert.equal(fogAmount(wall, 4000), 1);
});

test("exponential fog grows with distance and density, and stays in range", () => {
  const exp = { ...fog, style: 1 };
  assert.equal(fogAmount(exp, 0), 0);
  assert.ok(fogAmount(exp, 2000) > fogAmount(exp, 1000));
  assert.ok(fogAmount({ ...exp, density: 2 }, 1000) > fogAmount(exp, 1000));
  assert.ok(fogAmount(exp, 1e7) <= 1);
  assert.ok(fogAmount({ ...exp, style: 2 }, 100) < fogAmount(exp, 100), "squared starts slower");
});

test("from further out than the game's camera, what's looked at stays as clear as in the game", () => {
  const map = fogOf({ flags: 0x2000, fog })!;
  // In the game the target is 1650 away, before the fog starts at 3000.
  assert.equal(fogAmount(map, 1650), 0);
  const far = 8000;
  assert.equal(fogAmount(map, far), 1, "untouched it covers everything");
  assert.equal(fogAmount(fogForCamera(map, far), far), 0);
  assert.equal(fogAmount(fogForCamera(map, far), far + 3350), 1, "and what's far behind it still fades away");
});

test("closer than the game's camera the fog stays where the map has it", () => {
  const map = fogOf({ flags: 0x2000, fog })!;
  assert.deepEqual(fogForCamera(map, 1000), map);
});
