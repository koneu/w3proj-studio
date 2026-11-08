import assert from "node:assert/strict";
import { test } from "node:test";
import { fogAmount, fogColorForBlend, fogOf } from "./fog";

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
  const exp = { ...fog, style: 1, density: 0.0005 };
  assert.equal(fogAmount(exp, 0), 0);
  assert.ok(fogAmount(exp, 2000) > fogAmount(exp, 1000));
  assert.ok(fogAmount({ ...exp, density: 2 }, 1000) > fogAmount(exp, 1000));
  assert.ok(fogAmount(exp, 1e7) <= 1);
  assert.ok(fogAmount({ ...exp, style: 2 }, 100) < fogAmount(exp, 100), "squared starts slower");
});

const close = (actual: number, expected: number, what?: string) => assert.ok(Math.abs(actual - expected) < 1e-9, `${what ?? ""} ${actual} is not ${expected}`);

test("the exponential styles are Direct3D's, the density per world unit as the map stores it", () => {
  // exp: 1/e^(d·density) is left of the colour; exp2: 1/e^((d·density)²).
  close(fogAmount({ ...fog, style: 1, density: 0.001 }, 1000), 1 - Math.exp(-1));
  close(fogAmount({ ...fog, style: 1, density: 0.002 }, 1000), 1 - Math.exp(-2));
  close(fogAmount({ ...fog, style: 2, density: 0.001 }, 1000), 1 - Math.exp(-1));
  close(fogAmount({ ...fog, style: 2, density: 0.001 }, 2000), 1 - Math.exp(-4));
  close(fogAmount({ ...fog, style: 1, density: 0.0003 }, 0), 0, "nothing at the eye");
});

test("density 0.5 is fog all over from the game's camera, as the game shows (02e, 02f)", () => {
  // The game's camera is 1650 from what it looks at, 56° down: the nearest ground on screen is about 1000 away.
  for (const style of [1, 2]) {
    const map = fogOf({ flags: 0x2000, fog: { ...fog, style, density: 0.5 } })!;
    assert.ok(fogAmount(map, 1000) > 0.999, `style ${style}: ${fogAmount(map, 1000)}`);
    assert.ok(fogAmount(map, 100) > 0.999, `style ${style} even close: ${fogAmount(map, 100)}`);
  }
});

test("a near linear fog (02c, 500 to 2200) covers the far rows from the game's camera", () => {
  const map = fogOf({ flags: 0x2000, fog: { ...fog, style: 0, start: 500, end: 2200 } })!;
  // What the camera looks at is 1650 from the eye: two thirds fog. Rows further north are deeper still.
  close(fogAmount(map, 1650), 1150 / 1700);
  assert.equal(fogAmount(map, 2200), 1);
});

test("layers that add or multiply fade to what leaves the picture alone, the others to the fog's colour", () => {
  const c: [number, number, number] = [0.75, 0.78, 0.86];
  assert.deepEqual(fogColorForBlend(0, c), c, "none");
  assert.deepEqual(fogColorForBlend(1, c), c, "transparent");
  assert.deepEqual(fogColorForBlend(2, c), c, "blend");
  assert.deepEqual(fogColorForBlend(3, c), [0, 0, 0], "additive adds nothing");
  assert.deepEqual(fogColorForBlend(4, c), [0, 0, 0], "add alpha adds nothing");
  assert.deepEqual(fogColorForBlend(5, c), [1, 1, 1], "modulate times one");
  assert.deepEqual(fogColorForBlend(6, c), [0.5, 0.5, 0.5], "modulate 2x times two halves");
});
