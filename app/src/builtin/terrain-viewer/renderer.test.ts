import assert from "node:assert/strict";
import { test } from "node:test";
import { applySky } from "../../lib/terrain/atmosphere";
import { borderShade } from "../../lib/terrain/area";
import { mapEdgeTiles, markMapEdge, type Terrain } from "../../lib/terrain/w3e";
import { castsSunShadow, edgeMode, HD_WATER, hdWaterAt, hdWaterColor, meanBrightness, playRect, TerrainRenderer, waterRamp, waterTile, wetLevels, withGroup } from "./renderer";

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

test("past the playable map cliffs and specials shade as the ground, placed models go black (doodads as the ground in HD)", () => {
  for (const tone of [1, 2] as const) {
    assert.equal(edgeMode({ group: "cliffs", followGround: true }, tone), "pixel", `cliffs, tone ${tone}`);
    // The special doodads: drawn with the doodads, standing on the ground's height map.
    assert.equal(edgeMode({ group: "doodads", followGround: true }, tone), "pixel", `specials, tone ${tone}`);
    assert.equal(edgeMode({ group: "units" }, tone), "tile", `units, items and start locations, tone ${tone}`);
    assert.equal(edgeMode({ group: "shoreline" }, tone), "tile", `the shore's waves, tone ${tone}`);
  }
  assert.equal(edgeMode({ group: "doodads" }, 1), "tile", "SD doodads and trees");
  assert.equal(edgeMode({ group: "doodads" }, 2), "object", "HD doodads and trees");
});

test("the view's tiles past the playable map follow the w3i's complements once read, the terrain's marks before", () => {
  const t = { width: 9, height: 7, corners: Array.from({ length: 63 }, () => ({ rawWater: 0 })) } as unknown as Terrain;
  markMapEdge(t, [1, 1, 1, 1]);
  const edgeTiles = (complements: number[] | null) => TerrainRenderer.prototype.edgeTiles.call({ terrain: t, complements } as unknown as TerrainRenderer);
  const count = (a: Uint8Array) => a.reduce((n, v) => n + v, 0);
  assert.equal(count(edgeTiles(null)), 48 - 6 * 4, "the marks: margins 1");
  assert.equal(count(edgeTiles([3, 1, 1, 1])), 48 - 4 * 4, "the w3i: left margin 3");
  assert.equal(edgeTiles([3, 1, 1, 1])[2 * 8 + 2], 1, "tile 2, 2 is past the w3i's left margin");
});

test("HD water's dark edge goes by the playable rectangle round the tiles the border leaves", () => {
  const t = { width: 9, height: 7, offsetX: -512, offsetY: -384, corners: Array.from({ length: 63 }, () => ({ rawWater: 0 })) } as unknown as Terrain;
  markMapEdge(t, [2, 1, 1, 2]);
  assert.deepEqual(playRect(t, mapEdgeTiles(t)), [-512 + 256, -384 + 128, -512 + 7 * 128, -384 + 4 * 128]);
  // Nothing playable: an empty rectangle in the middle, so all of the water is dark.
  assert.deepEqual(playRect(t, new Uint8Array(48).fill(1)), [0, 0, 0, 0]);
});

test("the border shade's texel in a tile's middle is shaded exactly where the tile lies past the playable map", () => {
  // The "tile" mode reads it (lib/model/renderer.ts instanceEdge): 4 texels a tile, the middle one at 4 t + 2.
  const t = { width: 9, height: 7, corners: Array.from({ length: 63 }, () => ({ rawWater: 0 })) } as unknown as Terrain;
  markMapEdge(t, [2, 1, 1, 2]);
  const marks = mapEdgeTiles(t), { rgba, width } = borderShade(t, marks);
  let past = 0;
  for (let ty = 0; ty < 6; ty++) for (let tx = 0; tx < 8; tx++) {
    const shaded = rgba[((4 * ty + 2) * width + 4 * tx + 2) * 4 + 3] > 0;
    assert.equal(shaded, marks[ty * 8 + tx] === 1, `tile ${tx}, ${ty}`);
    if (shaded) past++;
  }
  // The marks round the playable 5 by 3 tiles.
  assert.equal(past, 48 - 15);
  // A tile's edge texel is shaded beside a marked tile (the fade over the first playable cell), its middle not.
  assert.ok(rgba[((4 * 3 + 2) * width + 4 * 2) * 4 + 3] > 0);
  assert.equal(rgba[((4 * 3 + 2) * width + 4 * 2 + 2) * 4 + 3], 0);
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

test("models count as standing in the water on and next to its tiles, up to a little above its surface", () => {
  // A 5 × 4 tile map with one pool tile at (2, 1), its surface at 100, and a higher pool tile at (4, 3), at 300.
  const wet = wetLevels(5, 4, (x, y) => (x === 2 && y === 1 ? 100 : x === 4 && y === 3 ? 300 : null), 1);
  const at = (x: number, y: number) => wet[y * 5 + x];
  assert.equal(at(2, 1), 100);
  assert.equal(at(1, 0), 100, "a tile next to it (across a corner too)");
  assert.equal(at(3, 2), 300, "next to both: the higher surface");
  assert.equal(at(0, 3), -Infinity, "two tiles away: dry");
  assert.equal(at(4, 0), -Infinity);
  // The renderer's test of a model's origin, with that map at offset (0, 0).
  const view = { terrain: { offsetX: 0, offsetY: 0, width: 6, height: 5 }, wet } as unknown as TerrainRenderer;
  const standsIn = (x: number, y: number, z: number) => TerrainRenderer.prototype["underWater"].call(view, new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]));
  assert.equal(standsIn(320, 200, 100), true, "a swimming naga on the surface");
  assert.equal(standsIn(320, 200, -200), true, "a unit wading on the bed");
  assert.equal(standsIn(320, 200, 110), true, "a little above the surface");
  assert.equal(standsIn(320, 200, 300), false, "a flying unit over the water");
  assert.equal(standsIn(200, 64, 100), true, "on the shore tile next to it, at the water's height");
  assert.equal(standsIn(200, 64, 180), false, "a tree on the bank above it");
  assert.equal(standsIn(64, 450, 0), false, "away from the water");
  assert.equal(standsIn(-50, 200, 0), false, "off the map");
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
});

test("the map's water tint multiplies the ramp's colour, stored blue first, as the World Editor draws SD water", () => {
  // 03b_Water_Tint: war3map.w3i holds 100, 100, 255, 255; its script says SetWaterBaseColor( 255, 100, 100, 255 ):
  // red. The World Editor (we-drive, SD, unlit, 2026-11-13) draws its deep water dark purple, 39, 19, 53: the red
  // tint times Lordaeron's blue ramp times the (blue) water texture, whose colour is kept.
  const ramp = waterRamp(LORDAERON, [100, 100, 255, 255]);
  const red = [1, 100 / 255, 100 / 255];
  for (const k of ["shallowMin", "shallowMax", "deepMin", "deepMax"] as const) {
    near(ramp[k], [LORDAERON[k][0] * red[0], LORDAERON[k][1] * red[1], LORDAERON[k][2] * red[2], LORDAERON[k][3]]);
  }
  // Lordaeron's Water00 averages 104, 117, 183: the deep water the shader gives (ramp times texture, alpha 250/255
  // over the bed) comes within a few levels of the editor's.
  const texture = [104, 117, 183], editor = [39, 19, 53];
  const deep = ramp.deepMax.slice(0, 3).map((c, k) => c * texture[k]);
  deep.forEach((v, k) => assert.ok(Math.abs(v - editor[k]) <= 4, `deep water ${deep.map(Math.round)} against the editor's ${editor}`));
  // The tint's alpha makes all of it more see-through, the shore still fading out.
  const half = waterRamp(LORDAERON, [100, 100, 255, 51]);
  near([half.shallowMin[3], half.deepMax[3]], [(10 / 255) * 0.2, (250 / 255) * 0.2]);
});

test("set_sky's waterTint is the colour white shallows take, as \"#rrggbb\" and as [red, green, blue]", () => {
  for (const waterTint of ["#dc5028", [220, 80, 40]]) {
    const doc: Record<string, any> = { version: 31, flags: 0 };
    applySky(doc, { waterTint }, { tilesets: [] });
    assert.deepEqual(waterRamp(LORDAERON, doc.waterTint).shallowMin.slice(0, 3).map((c) => Math.round(c * 255)), [220, 80, 40], JSON.stringify(waterTint));
  }
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
  // Murgul Oasis (Sunken Ruins, the same HD Water.slk row as Cityscape) in game view, 2026-11-12: blue, not olive teal.
  const ruins = rgb(hdWaterColor("Z", false));
  within(ruins, [30, 94, 174], [30, 94, 174], "Sunken Ruins");
  assert.ok(ruins[2] > ruins[1] && ruins[1] > ruins[0], `Sunken Ruins blue over green over red: ${ruins}`);
  within(rgb(hdWaterColor("z", false)), ruins, ruins, "the tileset's letter in any case");
  // 03b_Water_Tint (red): the editor's HD water loses Lordaeron's blue instead of turning red.
  within(rgb(hdWaterColor("L", true)), [22, 50, 40], [23, 50, 40], "Lordaeron tinted");
});

test("HD water over the ground as the editor's pools of set depths show it (we-drive, Lighting off)", () => {
  // Five pools on map 03's flat grass (the ground there 3, 132, 0 with Water off): their mean colour in the editor.
  const ground = [3, 132, 0];
  const measured: [number, number[]][] = [[8, [23, 126, 29]], [16, [30, 119, 41]], [32, [34, 109, 51]], [48, [29, 92, 55]], [96, [25, 60, 69]]];
  const deepColour = hdWaterColor("L", false).map((v) => v * 255);
  for (const [depth, editor] of measured) {
    const { alpha, deep } = hdWaterAt(depth);
    const water = HD_WATER.shallow.map((s, k) => s + (deepColour[k] - s) * deep);
    const got = ground.map((g, k) => g + (water[k] - g) * alpha);
    assert.ok(got.every((v, k) => Math.abs(v - editor[k]) <= 5), `depth ${depth}: ${got.map(Math.round)} against the editor's ${editor}`);
  }
  // The shore fades in: barely any water at the very edge, all of it from the full depth on.
  assert.equal(hdWaterAt(0).alpha, 0);
  assert.equal(hdWaterAt(HD_WATER.full + 50).alpha, 1);
  assert.ok(hdWaterAt(8).alpha < 0.3, "the outermost band is see-through");
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
