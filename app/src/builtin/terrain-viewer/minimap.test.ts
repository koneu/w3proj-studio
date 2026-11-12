import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { DecodedImage } from "../../lib/image/index.ts";
import type { Terrain } from "../../lib/terrain/w3e";
import { grainAt, groundColors, minimapFrame, renderMinimap, type MinimapInput, type Rgb } from "./minimap";
import { minimapObjects, modelTextureColor, smallestMipColor } from "./minimapgen";
import { viewOutline } from "./minimappanel";

/** A made-up 33×25 corner map: two ground tiles in stripes, a lake in the middle, hills. */
function terrain(): Terrain {
  const width = 33, height = 25;
  const corners = Array.from({ length: width * height }, (_, i) => {
    const x = i % width, y = Math.floor(i / width);
    const lake = Math.hypot(x - 16, y - 12) < 5;
    return { texture: (x >> 2) & 1, hasWater: lake, water: 0, height: lake ? -80 + Math.hypot(x - 16, y - 12) * 10 : (x * y) % 7, layer: 2, boundary: false };
  });
  return { width, height, offsetX: -2048, offsetY: -1536, corners, groundTiles: ["Ldrt", "Lgrs"], tileset: "L" } as unknown as Terrain;
}

const base = (): MinimapInput => ({
  terrain: terrain(), margins: [2, 3, 1, 2],
  tileColor: (id) => (id === "Ldrt" ? [120, 90, 60] : [40, 140, 50]),
  waterColor: [0, 0, 192],
  objects: [{ x: -1000, y: 0, rgb: [10, 200, 10] }, { x: 500, y: 300, rgb: [200, 10, 10] }],
});
const digest = (rgba: Uint8ClampedArray) => createHash("sha256").update(rgba).digest("hex").slice(0, 16);

test("minimapFrame: a unit drawn at a world point is at its pixel, and the pixel leads back to the point", () => {
  const input = base();
  for (const wholeMap of [false, true]) {
    const frame = minimapFrame(input.terrain, input.margins, 256, wholeMap);
    for (const [wx, wy] of [[-1000, 0], [500, 300], [-1700, -1200]]) {
      const rgba = renderMinimap({ ...input, objects: [], units: [{ x: wx, y: wy, rgb: [255, 0, 255] }], params: { blurPasses: 0 }, wholeMap });
      const [px, py] = frame.toPixel(wx, wy);
      const i = (Math.floor(py) * 256 + Math.floor(px)) * 4;
      assert.deepEqual([...rgba.slice(i, i + 3)], [255, 0, 255], `${wx}, ${wy} (whole map ${wholeMap}) at ${px}, ${py}`);
      const [bx, by] = frame.toWorld(px, py);
      assert.ok(Math.abs(bx - wx) < 1e-6 && Math.abs(by - wy) < 1e-6, `${bx}, ${by}`);
    }
  }
  // North is up: a point further north is higher in the picture.
  const f = minimapFrame(input.terrain, input.margins, 256);
  assert.ok(f.toPixel(0, 500)[1] < f.toPixel(0, -500)[1]);
});

test("war3mapMap.blp's picture: what the map's minimap was before the export options came", () => {
  // Taken from renderMinimap before Export Minimap had options; the saved minimap must not change with them. Taken
  // again when the ground got the World Editor's colours, cliffs and grain (2026-11-11), and when the water did
  // (2026-11-12: its minimap colour at mmAlpha, twice where deep).
  assert.equal(digest(renderMinimap(base())), "9625d8fa570b02e8");
});

test("groundColors: a tile point colours its tile, a point next to a cliff its cliff type, no cliff type its ground", () => {
  // 4 × 3 points: texture 1 in the east column, layer 3 at point (1, 1), cliff type 0 except at point (2, 0) (none)
  // and (0, 2) (type 1, whose colour isn't known).
  const width = 4, height = 3;
  const corners = Array.from({ length: width * height }, (_, i) => {
    const x = i % width, y = Math.floor(i / width);
    return { texture: x === 3 ? 1 : 0, layer: x === 1 && y === 1 ? 3 : 2, cliffTexture: x === 2 && y === 0 ? 15 : x === 0 && y === 2 ? 1 : 0 };
  });
  const t = { width, height, corners, groundTiles: ["Ldrt", "Lgrs"], cliffTiles: ["CLdi", "CLgr"] } as unknown as Terrain;
  const tile = (id: string): Rgb => (id === "Ldrt" ? [1, 1, 1] : [2, 2, 2]);
  const colors = groundColors(t, tile, (id) => (id === "CLdi" ? [9, 9, 9] : null));
  const at = (x: number, y: number) => colors[(y * width + x) * 3];
  // Every point within one of (1, 1) is next to the cliff; (2, 0) and (0, 2) keep their ground.
  assert.deepEqual([0, 1, 2].map((y) => [0, 1, 2, 3].map((x) => at(x, y))), [[9, 9, 1, 2], [9, 9, 9, 2], [1, 9, 9, 2]]);
  // Without cliff colours (as before them) every point shows its ground.
  const plain = groundColors(t, tile);
  assert.deepEqual([...Array(width * height).keys()].map((i) => plain[i * 3]), corners.map((c) => (c.texture ? 2 : 1)));
});

test("the grain: even between 0 and 1, the same on every drawing, different from pixel to pixel", () => {
  const values = [...Array(256 * 64).keys()].map((i) => grainAt(i % 256, Math.floor(i / 256)));
  assert.ok(values.every((v) => v >= 0 && v < 1));
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  assert.ok(Math.abs(mean - 0.5) < 0.01, String(mean));
  const low = values.filter((v) => v < 0.1).length / values.length;
  assert.ok(Math.abs(low - 0.1) < 0.01, String(low));
  assert.equal(grainAt(17, 33), grainAt(17, 33));
  assert.ok(new Set(values.slice(0, 1000)).size > 990);
  // Two drawings of a map are the same picture (a saved minimap doesn't change without an edit).
  assert.equal(digest(renderMinimap(base())), digest(renderMinimap(base())));
});

test("smallestMipColor: the file's smallest mip level, averaged by alpha, not the full-size picture's average", () => {
  const level = (w: number, h: number, px: number[][]) => ({ width: w, height: h, rgba: Uint8ClampedArray.from(px.flat()) });
  const mips = [level(2, 1, [[0, 0, 0, 255], [100, 100, 100, 255]]), level(1, 1, [[40, 108, 27, 200]])];
  const image = { mipCount: 2, mip: (l: number) => mips[l] } as unknown as DecodedImage;
  assert.deepEqual(smallestMipColor(image), [40, 108, 27]);
  // A file whose smallest level isn't 1 × 1: averaged, transparent pixels left out; all transparent: none.
  const two = { mipCount: 1, mip: () => level(2, 1, [[10, 20, 30, 255], [250, 250, 250, 0]]) } as unknown as DecodedImage;
  assert.deepEqual(smallestMipColor(two), [10, 20, 30]);
  const clear = { mipCount: 1, mip: () => level(1, 1, [[10, 20, 30, 0]]) } as unknown as DecodedImage;
  assert.equal(smallestMipColor(clear), null);
});

test("water: its minimap colour a quarter (mmAlpha) over the ground, twice where too deep to walk", () => {
  // 9 × 3 points of one ground colour: dry in the west, 30 deep in the middle, 100 deep in the east.
  const width = 9, height = 3;
  const corners = Array.from({ length: width * height }, (_, i) => {
    const x = i % width;
    return { texture: 0, layer: 2, height: -[0, 30, 100][Math.floor(x / 3)], water: 0, hasWater: x >= 3 };
  });
  const t = { width, height, offsetX: 0, offsetY: 0, corners, groundTiles: ["Ldrt"], cliffTiles: [] } as unknown as Terrain;
  const rgba = renderMinimap({ terrain: t, margins: [0, 0, 0, 0], tileColor: () => [100, 120, 80], waterColor: [0, 0, 192], waterAlpha: 64 / 255,
    objects: [], size: 16, params: { blurPasses: 0, groundNoise: 0 } });
  // The middle row of the picture (8 × 2 tiles over 16 pixels: 2 per tile), one pixel inside each part.
  const at = (x: number) => [...rgba.subarray((8 * 16 + x) * 4, (8 * 16 + x) * 4 + 3)];
  const a = 64 / 255, once = [100, 120, 80].map((g, k) => g * (1 - a) + [0, 0, 192][k] * a);
  const twice = once.map((g, k) => g * (1 - a) + [0, 0, 192][k] * a);
  assert.deepEqual(at(1), [100, 120, 80]);
  assert.deepEqual(at(7), once.map(Math.round));
  assert.deepEqual(at(14), twice.map(Math.round));
});

test("minimapObjects: shown types in their minimap colour or their model's, as big as their pathing texture", async () => {
  const row = (showInMM: string, useMMColor: string, rgb: number[], pathTex: string) =>
    ({ showInMM, useMMColor, MMRed: String(rgb[0]), MMGreen: String(rgb[1]), MMBlue: String(rgb[2]), pathTex });
  const rows = new Map([
    ["tree", row("1", "1", [32, 90, 32], "PathTextures\\4x4Default.tga")],
    ["rock", row("1", "0", [0, 0, 0], "PathTextures\\LargeRockSpire.tga")],
    ["weed", row("0", "1", [9, 9, 9], "PathTextures\\4x4Default.tga")],
    ["ruin", row("1", "0", [0, 0, 0], "PathTextures\\4x4Default.tga")],
    ["pole", row("1", "1", [200, 0, 0], "none")],
    ["wall", row("1", "1", [1, 2, 3], "_")],
  ]);
  const asked: string[] = [];
  const objects = await minimapObjects(
    ["tree", "rock", "weed", "ruin", "pole", "wall", "X000", "nope"].map((id, i) => ({ id, position: [i * 128, 64, 0] as [number, number, number] })),
    {
      rows,
      // A custom rock with a pathing texture of its own (no extension: a .tga).
      bases: new Map([["X000", { base: "rock", pathTex: "PathTextures\\Small" }]]),
      // The ruin's model can't be read: it isn't drawn.
      modelColor: async (type) => (type === "rock" ? [87, 88, 82] : null),
      footprint: async (path) => { asked.push(path); return path.includes("Large") ? 3 : path.includes("Small") ? 0.5 : 1; },
    });
  assert.deepEqual(objects, [
    { x: 0, y: 64, rgb: [32, 90, 32], size: 1 },
    { x: 128, y: 64, rgb: [87, 88, 82], size: 3 },
    { x: 512, y: 64, rgb: [200, 0, 0], size: 1 },
    { x: 640, y: 64, rgb: [1, 2, 3], size: 1 },
    { x: 768, y: 64, rgb: [87, 88, 82], size: 0.5 },
  ]);
  assert.deepEqual([...new Set(asked)].sort(), ["PathTextures\\4x4Default.tga", "PathTextures\\LargeRockSpire.tga", "PathTextures\\Small.tga"]);
  // A bigger pathing texture draws a bigger dot.
  const dots = (size: number) => {
    const rgba = renderMinimap({ ...base(), objects: [{ x: 0, y: 0, rgb: [255, 0, 255], size }], params: { blurPasses: 0, groundNoise: 0 } });
    let n = 0;
    for (let i = 0; i < rgba.length; i += 4) if (rgba[i] === 255 && rgba[i + 1] === 0) n++;
    return n;
  };
  assert.ok(dots(3) > 6 * dots(1) && dots(1) > 0, `${dots(3)} vs ${dots(1)}`);
});

/** An MDX model holding nothing but these textures (replaceable id, path). */
function mdxOfTextures(textures: [number, string][]): Uint8Array {
  const buf = new Uint8Array(4 + 12 + 8 + 268 * textures.length);
  const dv = new DataView(buf.buffer);
  const tag = (p: number, s: string) => { for (let i = 0; i < 4; i++) buf[p + i] = s.charCodeAt(i); };
  tag(0, "MDLX");
  tag(4, "VERS"); dv.setUint32(8, 4, true); dv.setUint32(12, 800, true);
  tag(16, "TEXS"); dv.setUint32(20, 268 * textures.length, true);
  textures.forEach(([id, path], i) => {
    const p = 24 + 268 * i;
    dv.setUint32(p, id, true);
    for (let k = 0; k < path.length; k++) buf[p + 4 + k] = path.charCodeAt(k);
  });
  return buf;
}

/** A 1 × 1 uncompressed TGA of one colour. */
function tgaOf([r, g, b]: number[]): Uint8Array {
  const t = new Uint8Array(18 + 4);
  t[2] = 2; t[12] = 1; t[14] = 1; t[16] = 32; t[17] = 0x28;
  t.set([b, g, r, 255], 18);
  return t;
}

test("modelTextureColor: the model's first texture, its replaceable one where it asks for the type's, null when unreadable", async () => {
  const files = new Map<string, Uint8Array>([
    ["Doodads\\Rock\\Rock0.mdx", mdxOfTextures([[1, ""], [0, "Textures\\RockWall.blp"], [0, "Textures\\Moss.blp"]])],
    ["Textures\\RockWall.blp", tgaOf([87, 88, 82])],
    ["Doodads\\Tree\\Tree.mdx", mdxOfTextures([[31, ""]])],
    ["ReplaceableTextures\\Trees\\Bark.blp", tgaOf([110, 60, 10])],
    ["Doodads\\Bad\\Bad.mdx", mdxOfTextures([[0, "Textures\\Missing.blp"]])],
  ]);
  const read = async (p: string) => files.get(p) ?? assert.fail(`no ${p}`);
  const skin = (file: string, numVar: number, texId = -1, texFile = "") => ({ file, numVar, texId, texFile });
  // Team colour (replaceable 1) isn't the type's: the first plain texture counts.
  assert.deepEqual(await modelTextureColor(skin("Doodads\\Rock\\Rock", 10), read), [87, 88, 82]);
  // Two variations, but only the file without a number is stored; the type's replaceable texture (doodad skins give no
  // extension).
  assert.deepEqual(await modelTextureColor(skin("Doodads\\Tree\\Tree", 2, 31, "ReplaceableTextures\\Trees\\Bark"), read), [110, 60, 10]);
  assert.equal(await modelTextureColor(skin("Doodads\\Bad\\Bad", 1), read), null);
  assert.equal(await modelTextureColor(skin("Doodads\\None\\None", 1), read), null);
});

test("viewOutline: the view's corners on the ground, and far along a ray over the horizon", () => {
  type V = [number, number, number];
  const norm = (v: V): V => { const l = Math.hypot(...v); return [v[0] / l, v[1] / l, v[2] / l]; };
  // Straight down from 1000 over (100, 200), 90° across a 2:1 view: the ground 2000 × 1000 below.
  const down = (px: number, py: number) => ({ origin: [100, 200, 1000] as V, dir: norm([(px / 400 * 2 - 1) * 2, 1 - py / 200 * 2, -1]) });
  const pts = viewOutline(down, 400, 200, 0, 1e5);
  const want = [[-1900, 1200], [2100, 1200], [2100, -800], [-1900, -800]];
  pts.forEach((p, i) => assert.ok(Math.hypot(p[0] - want[i][0], p[1] - want[i][1]) < 1e-6, `${i}: ${p}`));
  // Looking level: the top corners look over the horizon and go to the far distance; the bottom ones meet the ground.
  const level = (px: number, py: number) => ({ origin: [0, 0, 100] as V, dir: norm([px / 400 * 2 - 1, 1, (1 - py / 200 * 2) * 0.5]) });
  const far = viewOutline(level, 400, 200, 0, 5000);
  assert.ok(Math.abs(Math.hypot(far[0][0], far[0][1]) - 5000 * Math.hypot(1, 1) / Math.hypot(1, 1, 0.5)) < 1e-6);
  assert.ok(far[2][1] > 0 && far[2][1] < 5000, "a bottom corner meets the ground in front");
});
