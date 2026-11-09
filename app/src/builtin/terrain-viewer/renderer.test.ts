import assert from "node:assert/strict";
import { test } from "node:test";
import { castsSunShadow, hdWaterColor, meanBrightness, TerrainRenderer, waterRamp, waterTile, withGroup } from "./renderer";

test("HD's real shadows are cast by units and doodads, not by cliffs, shoreline waves or see-through previews", () => {
  const one = [{ world: new Float32Array(16), team: 0 }];
  assert.equal(castsSunShadow({ group: "units", instances: one }), true);
  assert.equal(castsSunShadow({ group: "doodads", instances: one }), true);
  // cliff.w3m in the World Editor's HD view: the same picture with View > Shadows on and off.
  assert.equal(castsSunShadow({ group: "cliffs", instances: one, followGround: true }), false);
  assert.equal(castsSunShadow({ group: "shoreline", instances: one }), false);
  assert.equal(castsSunShadow({ group: "units", instances: one, tint: [1, 1, 1, 0.5] }), false, "a start building's see-through look");
  assert.equal(castsSunShadow({ group: "units", instances: [] }), false);
});

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

test("HD with the lighting on (the editor's game view) draws no shoreline waves; classic, or unlit, does", () => {
  // A view with nothing but the shoreline's particle emitters: whether it animates says whether they're drawn.
  const animating = Object.getOwnPropertyDescriptor(TerrainRenderer.prototype, "animating")!.get!;
  const view = (tone: number, gameView: boolean, hidden: string[] = []) => ({
    showWater: false, water: { count: 0 }, animate: false, showWeather: false, weather: [], showEffects: true,
    batches: [{ group: "shoreline", instances: [{}], effects: {}, gpu: { model: { sequences: [] } } }],
    hiddenGroups: new Set(hidden), tone, gameView, groupShown: TerrainRenderer.prototype.groupShown,
  });
  assert.equal(animating.call(view(2, true)), false, "HD game view");
  assert.equal(animating.call(view(2, false)), true, "HD, lighting off");
  assert.equal(animating.call(view(1, true)), true, "classic game view");
  assert.equal(animating.call(view(1, false, ["shoreline"])), false, "hidden by its toggle");
  const shown = (tone: number, gameView: boolean, group: string) => TerrainRenderer.prototype.groupShown.call({ hiddenGroups: new Set(), tone, gameView } as unknown as TerrainRenderer, group);
  assert.equal(shown(2, true, "doodads"), true, "only the shoreline");
});

test("game view leaves out the editor-only batches; a wireframe or hidden terrain leaves out the cliffs", () => {
  const view = (o: object) => ({ hiddenGroups: new Set<string>(), tone: 2, gameView: false, groundLook: "textured", showEditorOnly: true, groupShown: TerrainRenderer.prototype.groupShown, ...o }) as unknown as TerrainRenderer;
  const shown = (v: TerrainRenderer, b: { group: string; editorOnly?: boolean }) => TerrainRenderer.prototype.batchShown.call(v, b);
  const starts = { group: "units", editorOnly: true }, units = { group: "units" }, cliffs = { group: "cliffs" };
  assert.equal(shown(view({}), starts), true);
  assert.equal(shown(view({ showEditorOnly: false }), starts), false, "the start locations in game view");
  assert.equal(shown(view({ showEditorOnly: false }), units), true, "the units stay");
  assert.equal(shown(view({ hiddenGroups: new Set(["units"]) }), starts), false, "hidden with the units");
  assert.equal(shown(view({ groundLook: "wireframe" }), cliffs), false);
  assert.equal(shown(view({ groundLook: "hidden" }), cliffs), false);
  assert.equal(shown(view({ groundLook: "hidden" }), units), true);
  assert.equal(shown(view({}), cliffs), true);
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

test("HD water is the editor's dark teal, not Water.slk's HD ramp colour (we-drive, 2026-11-08)", () => {
  const rgb = (c: number[]) => c.map((v) => Math.round(v * 255));
  // Measured in the deep middle of map 03's lake, and of the same map on Northrend and Barrens, game view on and off.
  const within = (got: number[], lo: number[], hi: number[], what: string) =>
    assert.ok(got.every((v, i) => v >= lo[i] - 3 && v <= hi[i] + 3), `${what}: ${got} outside ${lo}–${hi}`);
  within(rgb(hdWaterColor("L", false)), [22, 54, 73], [23, 61, 73], "Lordaeron");
  within(rgb(hdWaterColor("N", false)), [22, 48, 39], [23, 52, 41], "Northrend");
  within(rgb(hdWaterColor("B", false)), [25, 41, 42], [26, 46, 44], "Barrens");
  // OrcX02_03's city pool (Cityscape, game view, 2026-11-09): blue, not teal.
  within(rgb(hdWaterColor("Y", false)), [50, 61, 121], [50, 61, 121], "Cityscape");
  // 03b_Water_Tint (red): the editor's HD water loses Lordaeron's blue instead of turning red.
  within(rgb(hdWaterColor("L", true)), [22, 50, 40], [23, 50, 40], "Lordaeron tinted");
});

test("a texture's mean brightness comes from a small mip level", () => {
  const level = (w: number, h: number, rgba: number[]) => ({ width: w, height: h, rgba: new Uint8ClampedArray(rgba) });
  const asked: number[] = [];
  const img = {
    format: "t", width: 64, height: 64, hasAlpha: false, mipCount: 4,
    // Levels 64, 32, 16, 8: the 16-high one is read.
    mip(l: number) { asked.push(l); return l === 2 ? level(1, 2, [255, 255, 255, 255, 0, 0, 0, 255]) : level(1, 1, [9, 9, 9, 255]); },
  };
  assert.equal(meanBrightness(img), 0.5);
  assert.deepEqual(asked, [2]);
  assert.equal(meanBrightness({ ...img, mip() { throw new Error("truncated"); } }), null, "an image that can't be decoded");
});

test("a shore corner's water depth is its own stored level's; its surface stays the lake's", () => {
  // Map 03's lake edge: two wet corners (12 and 21 deep at 247.9) and two dry ones on the bank at 256.
  const wet = (height: number) => ({ height, water: 247.9, hasWater: true, layer: 2 });
  const dry = (water: number) => ({ height: 256, water, hasWater: false, layer: 2 });
  // Dry corners stored far below (the default, -346 under the bank): the water is clear well before them, so the
  // edge follows the wet corners tile by tile, as in the World Editor.
  const low = waterTile([wet(235.9), wet(226.9), dry(-90), dry(-90)])!;
  assert.deepEqual(low.z, [247.9, 247.9, 247.9, 247.9], "the surface doesn't tilt down to the stored level");
  near(low.depth, [12, 21, -346, -346]);
  // Dry corners stored at the lake's level: the water fades out just past them, a smooth edge.
  near(waterTile([wet(235.9), wet(226.9), dry(247.9), dry(247.9)])!.depth, [12, 21, -8.1, -8.1]);
  // A cliff tile: the dry corners on top keep the wet ones' depth (the wall goes down into the water).
  const cliffTop = { height: 384, water: -90, hasWater: false, layer: 3 };
  near(waterTile([wet(235.9), wet(226.9), cliffTop, cliffTop])!.depth, [12, 21, 21, 21]);
  assert.equal(waterTile([dry(-90), dry(-90), dry(-90), dry(-90)]), null, "no wet corner");
  assert.equal(waterTile([{ ...wet(250), water: 247.9 }, dry(247.9), dry(247.9), dry(247.9)]), null, "the ground above the surface everywhere");
});
