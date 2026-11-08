import assert from "node:assert/strict";
import { test } from "node:test";
import { waterRamp, withGroup } from "./renderer";

const b = (group: string, name: string) => ({ group, name });
const names = (list: { name: string }[]) => list.map((x) => x.name).join(" ");

test("each object group keeps its place in the drawing order, whichever finished loading first", () => {
  // Units first, then cliffs, then doodads, as a slow cliff plan and a fast unit load can land.
  let list = withGroup([], "units", [b("units", "u1")]);
  list = withGroup(list, "cliffs", [b("cliffs", "c1"), b("cliffs", "c2")]);
  list = withGroup(list, "doodads", [b("doodads", "d1")]);
  list = withGroup(list, "shoreline", [b("shoreline", "s1")]);
  assert.equal(names(list), "c1 c2 s1 d1 u1");
  // The other order of arrival draws the same.
  let again = withGroup([], "shoreline", [b("shoreline", "s1")]);
  again = withGroup(again, "doodads", [b("doodads", "d1")]);
  again = withGroup(again, "cliffs", [b("cliffs", "c1"), b("cliffs", "c2")]);
  again = withGroup(again, "units", [b("units", "u1")]);
  assert.equal(names(again), names(list));
});

test("replacing a group swaps only its batches, in their own order", () => {
  const list = [b("cliffs", "c1"), b("doodads", "d1"), b("doodads", "d2"), b("units", "u1")];
  assert.equal(names(withGroup(list, "doodads", [b("doodads", "d3")])), "c1 d3 u1");
  assert.equal(names(withGroup(list, "doodads", [])), "c1 u1");
  assert.equal(names(withGroup(list, "cliffs", [b("cliffs", "c9"), b("cliffs", "c8")])), "c9 c8 d1 d2 u1");
  // A group without a place goes last; the input isn't changed.
  assert.equal(names(withGroup(list, "extra", [b("extra", "x1")])), "c1 d1 d2 u1 x1");
  assert.equal(names(list), "c1 d1 d2 u1");
});

// Lordaeron Summer's ramp from TerrainArt\Water.slk (Smin/Smax/Dmin/Dmax: r, g, b, a in 0–1).
const LORDAERON = {
  shallowMin: [1, 1, 1, 10 / 255], shallowMax: [117 / 255, 117 / 255, 200 / 255, 219 / 255],
  deepMin: [117 / 255, 117 / 255, 200 / 255, 219 / 255], deepMax: [96 / 255, 96 / 255, 192 / 255, 250 / 255],
};
const near = (a: number[], b: number[]) => assert.ok(a.every((v, k) => Math.abs(v - b[k]) < 1e-6), `${a} ≠ ${b}`);

test("without water tinting the water keeps the tileset's colour ramp", () => {
  const ramp = waterRamp(LORDAERON, null);
  for (const k of ["shallowMin", "shallowMax", "deepMin", "deepMax"] as const) near(ramp[k], LORDAERON[k]);
  assert.equal(ramp.grey, false, "the texture keeps its own colour");
});

test("the map's water tint replaces the ramp's colour, stored blue first, and keeps its depth fade", () => {
  // 03b_Water_Tint: war3map.w3i holds 100, 100, 255, 255; its script says SetWaterBaseColor( 255, 100, 100, 255 ):
  // red. In the game that water is plainly red, not the ramp's blue darkened.
  const ramp = waterRamp(LORDAERON, [100, 100, 255, 255]);
  const red = [1, 100 / 255, 100 / 255];
  for (const k of ["shallowMin", "shallowMax", "deepMin", "deepMax"] as const) near(ramp[k], [...red, LORDAERON[k][3]]);
  // The water texture is blue itself (Lordaeron's Water00 averages 104, 117, 183): under red it would stay a
  // dull mauve. Tinted, only its brightness is kept, so the water is the tint's colour.
  assert.equal(ramp.grey, true);
  // The tint's alpha makes all of it more see-through, the shore still fading out.
  const half = waterRamp(LORDAERON, [100, 100, 255, 51]);
  near([half.shallowMin[3], half.deepMax[3]], [(10 / 255) * 0.2, (250 / 255) * 0.2]);
});
