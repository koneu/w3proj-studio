import assert from "node:assert/strict";
import { test } from "node:test";
import type { W3Api } from "../../extensions/api";
import type { DecodedImage } from "../../lib/image/index";
import type { Terrain } from "../../lib/terrain/w3e";
import { loadSkins, withObjectArt, type Placed, type Skin } from "./objects";
import { terrainShadows, terrainShadowsInSteps } from "./shadows";
import { groundShadows, shadowLookFor, shadowImage, shadowImagePath, shadowStamps, stampShadow, unitShadows, ViewShadows, type Baked, type ShadowImage } from "./viewshadows";

/** A 3 × 3 tile terrain (12 × 12 shadow cells) from (0, 0). */
const T = { width: 4, height: 4, offsetX: 0, offsetY: 0 };
const W = 12;

/** An image from rows (north first) of '.' (clear), '#' (shadow) and 'A' (the anchor: red, in shadow). */
function image(rows: string[]): { rgba: Uint8Array; width: number; height: number } {
  const width = rows[0].length, height = rows.length, rgba = new Uint8Array(width * height * 4);
  rows.forEach((row, y) => [...row].forEach((c, x) => {
    const i = (y * width + x) * 4;
    if (c === "A") rgba[i] = 255;
    rgba[i + 3] = c === "." ? 0 : 255;
  }));
  return { rgba, width, height };
}
const img = (rows: string[]): ShadowImage => { const m = image(rows); return shadowImage(m.width, m.height, m.rgba); };

const placed = (id: string, x: number, y: number): Placed => ({ id, variation: 0, position: [x, y, 0], angle: 0, scale: [1, 1, 1] });
const baseSkin: Skin = { kind: "w3u", file: "x", numVar: 1, texId: -1, texFile: "", modelScale: 1, minScale: 1, maxScale: 1, randScale: false, fixedRot: null, uberSplat: "" };

test("HD leaves the baked shadow map out, as the World Editor's HD view does", () => {
  assert.ok(shadowLookFor(1).baked > 0);
  assert.equal(shadowLookFor(2).baked, 0);
  assert.equal(shadowLookFor(2).unit, shadowLookFor(1).unit);
});

test("a shadow image's anchor is its red texel, else its middle", () => {
  assert.deepEqual(img(["...", "..#", "A#."]).anchor, [0, 2]);
  assert.deepEqual(img(["#..", "...", "..."]).anchor, [1, 1]);
  assert.equal(shadowImagePath("ShadowCrates"), "ReplaceableTextures\\Shadows\\ShadowCrates.blp");
  assert.equal(shadowImagePath("ShadowCrates.blp"), "ReplaceableTextures\\Shadows\\ShadowCrates.blp", "the table's name with an extension");
});

test("a shadow image goes into the grid with its anchor on the object's cell and its top to the north", () => {
  const grid = new Uint8Array(W * W);
  // One texel east of the anchor, one north-east of that.
  stampShadow(grid, T, 5 * 32 + 10, 4 * 32 + 3, img(["..#", ".A#", "..."]));
  const set = [...grid.keys()].filter((i) => grid[i]).map((i) => [i % W, Math.floor(i / W)]);
  assert.deepEqual(set.sort(), [[5, 4], [6, 4], [6, 5]].sort());
});

test("shadow images at the map's edge are cut off, not wrapped", () => {
  const grid = new Uint8Array(W * W);
  stampShadow(grid, T, 0, 0, img(["###", "#A#", "###"]));
  stampShadow(grid, T, 383, 383, img(["###", "#A#", "###"]));
  stampShadow(grid, T, -5000, 5000, img(["A"]));
  assert.equal(grid.filter((v) => v).length, 8, "4 cells at each corner");
  assert.equal(grid[0], 255);
  assert.equal(grid[W * W - 1], 255);
  assert.equal(grid[W - 1], 0, "nothing wraps to the other side");
});

test("the ground's shadow map keeps the baked cells and the objects' images apart, two bytes a cell", () => {
  const baked = new Uint8Array(W * W);
  baked[3] = 255;
  const out = groundShadows(T, baked, [{ x: 40, y: 40, image: img(["A"]) }]);
  assert.equal(out.length, W * W * 2);
  assert.equal(out[3 * 2], 255);
  assert.equal(out[3 * 2 + 1], 0);
  assert.equal(out[(W + 1) * 2], 0);
  assert.equal(out[(W + 1) * 2 + 1], 255);
  // A baked map of another size (a damaged file) isn't drawn shifted over the map.
  const wrong = groundShadows(T, new Uint8Array(W * W - 1).fill(255), []);
  assert.equal(wrong.filter((v, i) => i % 2 === 0 && v).length, 0);
  // Two images over one cell: the darker counts.
  const half = img(["A"]);
  half.alpha[0] = 100;
  const both = groundShadows(T, null, [{ x: 40, y: 40, image: half }, { x: 40, y: 40, image: img(["A"]) }, { x: 40, y: 40, image: half }]);
  assert.equal(both[(W + 1) * 2 + 1], 255);
});

test("units get their shadow texture over shadowX, shadowY, shadowW, shadowH; buildings and units without one don't", () => {
  const skins: Record<string, Skin> = {
    hfoo: { ...baseSkin, unitShadow: "Shadow", shadowX: 50, shadowY: 40, shadowW: 140, shadowH: 120 },
    hbar: { ...baseSkin, unitShadow: "Shadow", shadowW: 10, shadowH: 10, buildingShadow: "ShadowHumanBarracks" },
    hnone: { ...baseSkin },
    hzero: { ...baseSkin, unitShadow: "Shadow", shadowW: 0, shadowH: 50 },
  };
  const of = (p: Placed) => skins[p.id];
  const list = unitShadows([placed("hfoo", 1000, 2000), placed("hbar", 0, 0), placed("hnone", 0, 0), placed("hzero", 0, 0), placed("unknown", 0, 0)], of);
  assert.deepEqual(list, [{ x0: 950, y0: 1960, w: 140, h: 120, texture: "ReplaceableTextures\\Shadows\\Shadow.blp" }]);
  assert.deepEqual(shadowStamps([placed("hfoo", 1, 2), placed("hbar", 3, 4)], of), [{ x: 3, y: 4, name: "ShadowHumanBarracks" }]);
});

test("the skin tables give units' and destructables' shadows, and the map's object data changes them", async () => {
  const files: Record<string, string> = {
    "Doodads\\DoodadSkins.txt": "[LOrk]\nfile=Doodads\\Rock\nshadow=1",
    "Units\\DestructableSkin.txt": "[LTlt]\nfile=Doodads\\Tree\nshadow=BuildingShadowSmall\n[LTba]\nfile=Doodads\\Barricade\nshadow=none",
    "Units\\UnitSkin.txt": "[hfoo]\nfile=Units\\Footman\nunitShadow=Shadow\nshadowX=50\nshadowY=50\nshadowW=140\nshadowH=140\n[hbar]\nfile=Buildings\\Barracks\nbuildingShadow=ShadowHumanBarracks\n[hpea]\nfile=Units\\Peasant\nunitShadow=_",
    "Units\\ItemSkin.txt": "", "Units\\UnitData.slk": "ID;P\nE",
  };
  const w3 = { settings: { get: () => "sd-shadow-test" }, game: { readText: async (p: string) => files[p] ?? "" } } as unknown as W3Api;
  const skins = await loadSkins(w3);
  const foot = skins.get("hfoo")!;
  assert.deepEqual([foot.unitShadow, foot.shadowX, foot.shadowY, foot.shadowW, foot.shadowH], ["Shadow", 50, 50, 140, 140]);
  assert.equal(skins.get("hbar")?.buildingShadow, "ShadowHumanBarracks");
  assert.equal(skins.get("hpea")?.unitShadow, undefined, "\"_\" is none");
  assert.equal(skins.get("LTlt")?.buildingShadow, "BuildingShadowSmall");
  assert.equal(skins.get("LTba")?.buildingShadow, undefined, "\"none\" is none");
  assert.equal(skins.get("LOrk")?.buildingShadow, undefined, "a doodad's shadow flag isn't an image");
  const art = withObjectArt(skins, [
    { kind: "w3u", original: [{ base: "hfoo", mods: [{ field: "ushx", value: 20 }, { field: "ushu", value: "ShadowFlyer" }] }], custom: [{ base: "hbar", id: "h000", mods: [{ field: "ushb", value: "none" }] }] },
    { kind: "w3b", original: [{ base: "LTlt", mods: [{ field: "bshd", value: "ShadowCrates" }] }] },
  ]);
  assert.equal(art.get("hfoo")?.shadowX, 20);
  assert.equal(art.get("hfoo")?.unitShadow, "ShadowFlyer");
  assert.equal(art.get("hfoo")?.shadowW, 140, "fields the map doesn't set stay");
  assert.equal(art.get("h000")?.buildingShadow, undefined, "a custom building without a shadow");
  assert.equal(art.get("LTlt")?.buildingShadow, "ShadowCrates");
});

// ---- the view's shadows over time -------------------------------------------------------------

const terrain = { ...T } as unknown as Terrain;
const anchorImage = (): DecodedImage => {
  const m = image(["A"]);
  return { width: 1, height: 1, mip: () => ({ width: 1, height: 1, rgba: m.rgba }) } as unknown as DecodedImage;
};
const tick = () => new Promise((r) => setTimeout(r, 0));

function harness(opts: { baked: () => Promise<Baked>; predict?: (t: Terrain, d: Placed[], pause: () => Promise<boolean>) => Promise<Uint8Array> }) {
  const maps: (Uint8Array | null)[] = [];
  const shadows = new ViewShadows({
    terrain,
    target: { setShadowMap: (v) => maps.push(v ? v.slice() : null), setUnitShadows: () => {}, setSplatTexture: () => {} },
    readBaked: opts.baked,
    readImage: async () => anchorImage(),
    predict: opts.predict ?? null,
    redraw: () => {},
  });
  return { shadows, maps, last: () => maps[maps.length - 1] };
}
const bakedCells = (m: Uint8Array | null | undefined) => (m ? [...m.keys()].filter((i) => i % 2 === 0 && m[i]).map((i) => i / 2) : null);

test("the view shows the stored shadow map, nothing without one, and objects' images either way", async () => {
  const stored = new Uint8Array(W * W);
  stored[7] = 255;
  const a = harness({ baked: async () => ({ bytes: stored }) });
  await a.shadows.reloadBaked();
  assert.deepEqual(bakedCells(a.last()), [7]);
  const b = harness({ baked: async () => "absent" });
  await b.shadows.reloadBaked();
  assert.equal(b.last(), null, "no file, no objects: no shadow map at all");
  const skins: Record<string, Skin> = { LTlt: { ...baseSkin, kind: "w3b", buildingShadow: "T" } };
  await b.shadows.objectsChanged([], [placed("LTlt", 40, 40)], (p) => skins[p.id]);
  assert.equal(b.last()?.[(W + 1) * 2 + 1], 255, "the tree's image");
});

test("unsaved edits change only the cells their prediction changes, and an unreadable stored map isn't predicted over", async () => {
  const stored = new Uint8Array(W * W);
  stored[0] = 255; // the World Editor's, which the prediction doesn't know of
  const before = new Uint8Array(W * W), after = new Uint8Array(W * W);
  before[5] = 255; // a doodad that was moved away …
  after[9] = 255; // … to here
  const saved = { key: {}, terrain: () => terrain, doodads: [] as Placed[] };
  let calls = 0;
  const predict = async (_t: Terrain, d: Placed[]) => { calls++; return d === saved.doodads ? before : after; };
  const a = harness({ baked: async () => ({ bytes: stored }), predict });
  await a.shadows.reloadBaked();
  await a.shadows.editsChanged(saved, [placed("x", 0, 0)]);
  assert.deepEqual(bakedCells(a.last()), [0, 9]);
  await a.shadows.editsChanged(saved, [placed("x", 0, 0)]);
  assert.equal(calls, 3, "the saved state is predicted once until the next save");
  // Saving wrote the map: it's read again, and shown as it is.
  const written = new Uint8Array(W * W);
  written[9] = 255;
  const b = harness({ baked: async () => "unreadable", predict });
  await b.shadows.reloadBaked();
  await b.shadows.editsChanged(saved, [placed("x", 0, 0)]);
  assert.equal(b.maps.filter((m) => m).length, 0, "an unreadable stored map: nothing predicted, nothing drawn");
});

test("a prediction that lands after the stored map was read again, or after another edit, is dropped", async () => {
  let stored = new Uint8Array(W * W);
  const slow: ((v: Uint8Array) => void)[] = [];
  const predict = () => new Promise<Uint8Array>((resolve) => slow.push(resolve));
  const a = harness({ baked: async () => ({ bytes: stored }), predict });
  await a.shadows.reloadBaked();
  const saved = { key: {}, terrain: () => terrain, doodads: [] as Placed[] };
  const old = a.shadows.editsChanged(saved, []);
  await tick();
  // A save writes the map meanwhile.
  stored = new Uint8Array(W * W);
  stored[11] = 255;
  await a.shadows.reloadBaked();
  const stale = new Uint8Array(W * W).fill(255);
  for (const r of slow) r(stale);
  await old;
  assert.deepEqual(bakedCells(a.last()), [11], "the old prediction doesn't land over the new map");
  // Two edits in a row: the first one's result is overtaken.
  slow.length = 0;
  const first = a.shadows.editsChanged({ ...saved, key: {} }, []);
  await tick();
  const second = a.shadows.editsChanged({ ...saved, key: {} }, []);
  await tick();
  const [b1, a1, b2, a2] = slow;
  const one = new Uint8Array(W * W), two = new Uint8Array(W * W);
  two[4] = 255;
  b2(one); a2(two);
  await second;
  b1(one); a1(new Uint8Array(W * W).fill(255));
  await first;
  assert.deepEqual(bakedCells(a.last()), [4, 11]);
});

test("an edit made while the prediction is under way stops it, and its half-done result isn't drawn", async () => {
  let stopped = 0;
  const predict = async (_t: Terrain, d: Placed[], pause: () => Promise<boolean>) => {
    // Like predictShadows: some rows, then the page's turn, then the rest, unless no longer wanted.
    if (!(await pause())) { stopped++; throw new Error("superseded"); }
    return new Uint8Array(W * W).fill(d.length ? 255 : 0);
  };
  const a = harness({ baked: async () => ({ bytes: new Uint8Array(W * W) }), predict });
  await a.shadows.reloadBaked();
  const drawn = a.maps.length;
  const run = a.shadows.editsChanged({ key: {}, terrain: () => terrain, doodads: [] }, [placed("x", 0, 0)]);
  a.shadows.editing();
  await run;
  assert.equal(stopped, 1, "the current state's prediction stopped; the saved state's is still wanted");
  assert.equal(a.maps.length, drawn, "nothing drawn from it");
});

test("the terrain's shadows done in steps are the same as at once, and stop when no longer wanted", async () => {
  // A 9 × 9 corner terrain with a wall in the middle: it shades cells to the north-east (sun from the south-west).
  const corners = Array.from({ length: 81 }, (_, i) => ({ height: i % 9 === 4 && Math.floor(i / 9) >= 2 && Math.floor(i / 9) <= 6 ? 600 : 0 }));
  const hill = { width: 9, height: 9, offsetX: 0, offsetY: 0, corners } as unknown as Terrain;
  const once = terrainShadows(hill);
  assert.ok(once.some((v) => v), "the wall casts");
  let pauses = 0;
  const real = performance.now;
  // Every row takes "10 ms", so it waits after each.
  let clock = 0;
  performance.now = () => (clock += 10);
  try {
    assert.deepEqual(await terrainShadowsInSteps(hill, undefined, async () => { pauses++; return true; }), once);
    assert.ok(pauses > 1);
    await assert.rejects(terrainShadowsInSteps(hill, undefined, async () => false));
  } finally {
    performance.now = real;
  }
});

test("nothing is drawn after the view is closed", async () => {
  let release: (b: Baked) => void = () => {};
  const a = harness({ baked: () => new Promise<Baked>((r) => { release = r; }) });
  const loading = a.shadows.reloadBaked();
  a.shadows.dispose();
  release({ bytes: new Uint8Array(W * W).fill(255) });
  await loading;
  assert.equal(a.maps.length, 0);
});
