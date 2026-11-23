import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { DecodedImage } from "../../lib/image/index.ts";
import type { Terrain } from "../../lib/terrain/w3e";
import { dotReach, footprintTurned, grainAt, groundColors, minimapFrame, renderMinimap, sharpShare, type MinimapInput, type PathMask, type Rgb } from "./minimap";
import { minimapBase, minimapObjects, modelTextureColor, shownTextureMean, smallestMipColor, textureOrder } from "./minimapgen";
import type { W3Api } from "../../extensions/api";
import { viewOutline } from "./minimappanel";
import { parseIni } from "../../lib/formats/text";
import { artValue } from "../../lib/objects/artset";
import { gameFiles } from "../../lib/testhelpers/gamefiles";
import { skipOrFail } from "../../lib/testhelpers/testutil";

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

test("war3mapMap.blp's picture: a change detector for the whole render (the real oracles are minimapexport.test.ts and the we-compare specs)", () => {
  // Taken from renderMinimap before Export Minimap had options; the saved minimap must not change with them. Taken
  // again when the ground got the World Editor's colours, cliffs and grain (2026-11-11), and when the water did
  // (2026-11-12: its minimap colour at mmAlpha, twice where deep), and when the drawn area, the sampling, one softening
  // pass, bigger dots and cut values came from the editor's exports of seven maps (2026-11-13). Taken again when the
  // dots became tiles and the edges the editor's own smoothing (2026-11-17, branch we-minimap-2: intended).
  assert.equal(digest(renderMinimap(base())), "21f816b2fd4c1424");
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
  // [Removed] Redundant `assert.equal(digest(renderMinimap(base())), digest(renderMinimap(base())))` — line 58 already asserts `digest(renderMinimap(base())) === "21f816b2fd4c1424"`.
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
  // Cut to whole values, as the editor's.
  assert.deepEqual(at(7), once.map(Math.floor));
  assert.deepEqual(at(14), twice.map(Math.floor));
});

/** A flat map of `pw` × `ph` tiles, no margins: texture 1 where `second(x, y)` says (corner coordinates), else 0. */
function flat(pw: number, ph: number, second: (x: number, y: number) => boolean = () => false): Terrain {
  const width = pw + 1, height = ph + 1;
  const corners = Array.from({ length: width * height }, (_, i) => ({ texture: second(i % width, Math.floor(i / width)) ? 1 : 0, layer: 2, height: 0, water: 0, hasWater: false }));
  return { width, height, offsetX: 0, offsetY: 0, corners, groundTiles: ["Ldrt", "Lgrs"], tileset: "L" } as unknown as Terrain;
}
const plain = (terrain: Terrain, params: MinimapInput["params"] = { blurPasses: 0, groundNoise: 0 }) => renderMinimap({
  terrain, margins: [0, 0, 0, 0], tileColor: (id) => (id === "Ldrt" ? [100, 100, 100] : [200, 200, 200]), waterColor: [0, 0, 192], objects: [], params,
});
const pixel = (rgba: Uint8ClampedArray, x: number, y: number) => rgba[(y * 256 + x) * 4];

test("the drawn area as the World Editor's: whole pixels, the larger side filling the picture, the other centred", () => {
  // Measured on the editor's exports (2026-11-13): SnowareBay's 130 × 136 playable tiles fill columns 6–249 (244 px of
  // 244.7), NorthernIsles' 108 × 86 rows 26–228 (203 of 203.9); the rest is black.
  for (const [pw, ph, axis, first, last] of [[130, 136, "x", 6, 249], [108, 86, "y", 26, 228]] as const) {
    const rgba = plain(flat(pw, ph));
    const lit = [...Array(256).keys()].filter((i) => (axis === "x" ? pixel(rgba, i, 128) : pixel(rgba, 128, i)) > 0);
    assert.deepEqual([lit[0], lit.at(-1), lit.length], [first, last, last - first + 1], `${pw} × ${ph}`);
    const f = minimapFrame(flat(pw, ph), [0, 0, 0, 0], 256);
    assert.deepEqual(axis === "x" ? [f.box[0], f.box[2]] : [f.box[1], f.box[3]], [first, last - first + 1]);
  }
  // Softening stays inside: the black band's edge is sharp, the first drawn column keeps the ground's colour.
  const soft = plain(flat(130, 136), { blurPasses: 1, groundNoise: 0 });
  assert.deepEqual([pixel(soft, 5, 128), pixel(soft, 6, 128), pixel(soft, 249, 128), pixel(soft, 250, 128)], [0, 100, 100, 0]);
});

test("a pixel shows the tile under its bottom-left corner: tile edges half a pixel right of and above the centre's", () => {
  // cliff.w3m's 52 playable tiles (4.92 px each): its plateau starting at tile 20 begins at pixel 99 in the editor's
  // export (column 98 is 13 % plateau, softened; 99 is 84 %), where a centre-sampled pixel 98 already is in tile 20.
  const east = plain(flat(52, 52, (x) => x >= 20));
  assert.deepEqual([pixel(east, 98, 100), pixel(east, 99, 100)], [100, 200]);
  // Rows count from the south: tile row 20 begins 98.46 px up, so pixel row 156 (from the top) is its last.
  const north = plain(flat(52, 52, (_x, y) => y >= 20));
  assert.deepEqual([pixel(north, 100, 156), pixel(north, 100, 157)], [200, 100]);
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
      // The ruin's model can't be read: a grey dot, as in the editor.
      modelColor: async (type) => (type === "rock" ? [87, 88, 82] : null),
      footprint: async (path) => { asked.push(path); return path.includes("Large") ? 3 : path.includes("Small") ? 0.5 : 1; },
    });
  assert.deepEqual(objects, [
    { x: 0, y: 64, rgb: [32, 90, 32], size: 1 },
    { x: 128, y: 64, rgb: [87, 88, 82], size: 3 },
    { x: 384, y: 64, rgb: [183, 183, 183], size: 1 },
    // No pathing texture (none, "_"): the one tile it stands in.
    { x: 512, y: 64, rgb: [200, 0, 0], size: 0, cells: [0, 0] },
    { x: 640, y: 64, rgb: [1, 2, 3], size: 0, cells: [0, 0] },
    { x: 768, y: 64, rgb: [87, 88, 82], size: 0.5 },
  ]);
  assert.deepEqual([...new Set(asked)].sort(), ["PathTextures\\4x4Default.tga", "PathTextures\\LargeRockSpire.tga", "PathTextures\\Small.tga"]);
  // A bigger pathing texture draws a bigger dot (whole tiles: 3 tiles' texture reaches 3 or 4 of them, a 1 tile one 1 or 2).
  const dots = (size: number) => {
    const rgba = renderMinimap({ ...base(), objects: [{ x: 0, y: 0, rgb: [255, 0, 255], size }], params: { blurPasses: 0, groundNoise: 0 } });
    let n = 0;
    for (let i = 0; i < rgba.length; i += 4) if (rgba[i] === 255 && rgba[i + 1] === 0) n++;
    return n;
  };
  assert.ok(dots(3) > 3 * dots(1) && dots(1) > 0, `${dots(3)} vs ${dots(1)}`);
});

test("dotReach: the tiles [u - a, u + a] touches, a = (cells - 2) / 8, as the editor's dots swept over a tile (4x4, 6x6, 8x8, 12x12)", () => {
  // we-drive 2026-11-17 (minimap-dots-sweep.w3x: the centre moved 4 units at a time): 4x4 reaches two tiles within a
  // quarter tile of a tile edge, one otherwise; 6x6 two always (the pair changing at the tile's middle); 8x8 two, three
  // within [.25, .75), two; 12x12 four or three.
  const width = (cells: number, f: number) => { const [a, b] = dotReach(10 + f, cells); return b - a + 1; };
  assert.deepEqual([0, 0.2, 0.25, 0.5, 0.74, 0.75, 0.95].map((f) => width(4, f)), [2, 2, 1, 1, 1, 2, 2]);
  assert.deepEqual([0, 0.49, 0.5, 0.95].map((f) => width(6, f)), [2, 2, 2, 2]);
  assert.deepEqual([0, 0.2, 0.25, 0.74, 0.75].map((f) => width(8, f)), [2, 2, 3, 3, 2]);
  assert.deepEqual([0, 0.5].map((f) => width(12, f)), [4, 3]);
  // Where the tiles are: 6x6 at f below a half reaches the tile before.
  assert.deepEqual([dotReach(10.4, 6), dotReach(10.5, 6)], [[9, 10], [10, 11]]);
  // No pathing texture: the tile it stands in.
  assert.deepEqual(dotReach(10.7, 0), [10, 10]);
});

test("sharpShare and the tile edges: an edge pixel keeps 7/8 of its tile, a lone tile's corner pixel 1/6, a neighbour doubling it", () => {
  // The editor's pixels on a dot of tiles, 4 and 2 pixels a tile (we-drive 2026-11-17).
  assert.equal(sharpShare(0.625), 0.875);
  assert.equal(sharpShare(0.375), 0.125);
  assert.ok(Math.abs(sharpShare(0.5625) - 0.6875) < 1e-9);
  assert.equal(sharpShare(0.2), 0);
  assert.equal(sharpShare(0.9), 1);
  const lone = (blurPasses: number) => {
    // A 4 x 4 tile ground with one dot tile at (2, 2) (a doodad with no pathing width, at its middle): 4 pixels a tile.
    const rgba = renderMinimap({ terrain: flat(4, 4), margins: [0, 0, 0, 0], tileColor: () => [0, 0, 0], waterColor: [0, 0, 192], size: 16, params: { groundNoise: 0, blurPasses },
      objects: [{ x: 2 * 128 + 64, y: 2 * 128 + 64, rgb: [255, 255, 255], size: 0 }] });
    return (x: number, y: number) => rgba[(y * 16 + x) * 4];
  };
  const soft = lone(1), hard = lone(0);
  // The tile (2, 2) is pixels 8..11 across, rows 4..7 from the top (rows count from the south: tile row 2 of 4 is 4..7).
  assert.equal(hard(9, 5), 255, "control: hard tiles have the tile's pixels at full colour");
  assert.equal(hard(7, 5), 0);
  assert.ok(soft(9, 5) === 255 && soft(10, 6) === 255, "inner pixels stay pure");
  assert.ok(Math.abs(soft(8, 5) - 223) <= 1 && Math.abs(soft(7, 5) - 31) <= 1, `edge pixel 7/8 of the tile, the one across 1/8: ${soft(8, 5)} ${soft(7, 5)}`);
  assert.ok(Math.abs(soft(8, 4) - 43) <= 2, `corner pixel: ${soft(8, 4)}`);
});

/** A pathing texture from rows of "#" (a non-black cell) and "." (black), row 0 north. */
const maskOf = (rows: string[]): PathMask => ({ width: rows[0].length, height: rows.length, cells: Uint8Array.from(rows.join(""), (c) => (c === "#" ? 1 : 0)) });
/** PathTextures\Gate1Path.tga (20 × 4, all cells) and StoneWall2Path.tga (10 × 10, a diagonal from the north-west). */
const GATE1 = maskOf(Array(4).fill("#".repeat(20)));
const WALL2 = maskOf(Array.from({ length: 10 }, (_, r) => ".".repeat(r - (r % 2)) + "##" + ".".repeat(8 - (r - (r % 2)))));

test("minimapObjects: a texture with gaps is drawn as its cells, one full rectangle (a gate, a tree) as a dot of tiles", async () => {
  const row = (pathTex: string) => ({ showInMM: "1", useMMColor: "1", MMRed: "9", MMGreen: "8", MMBlue: "7", pathTex });
  const rows = new Map([["gate", row("PathTextures\\Gate1Path.tga")], ["wall", row("PathTextures\\StoneWall2Path.tga")], ["tree", row("PathTextures\\4x4Default.tga")], ["odd", row("PathTextures\\Gone.tga")]]);
  const masks: Record<string, PathMask> = { "PathTextures\\Gate1Path.tga": GATE1, "PathTextures\\StoneWall2Path.tga": WALL2, "PathTextures\\4x4Default.tga": maskOf(Array(4).fill("####")) };
  const objects = await minimapObjects(
    ["gate", "wall", "tree", "odd"].map((id, i) => ({ id, position: [i * 128, 64, 0] as [number, number, number], angle: 4.5 })),
    { rows, bases: new Map(), modelColor: async () => null, footprint: async (path) => (path.includes("Gate") ? 2.2 : 1),
      cells: async (path) => { const m = masks[path]; return m ? [m.width, m.height] : null; }, pathMask: async (path) => masks[path] ?? null });
  assert.deepEqual(objects, [
    // The gate's 20 × 4 cells: five tiles by one or two (see dotReach), not its cells.
    { x: 0, y: 64, rgb: [9, 8, 7], size: 2.2, cells: [20, 4], angle: 4.5 },
    { x: 128, y: 64, rgb: [9, 8, 7], mask: WALL2, angle: 4.5 },
    { x: 256, y: 64, rgb: [9, 8, 7], size: 1, cells: [4, 4], angle: 4.5 },
    { x: 384, y: 64, rgb: [9, 8, 7], size: 1, angle: 4.5 },
  ]);
});

test("a gate is a strip of its texture's cells, turned by the angle (the textures are drawn for 270 degrees)", () => {
  // SnowareBay's ITx1 gates (20 × 4 cells, angle 270 degrees) are strips 5 tiles wide and one tall in the editor's
  // export, 18 × 2 pixels for two of them side by side at 1.88 px per tile; a grey disc was drawn before.
  const t = flat(20, 20);
  const draw = (object: { size?: number; mask?: PathMask; angle?: number }) => {
    const rgba = renderMinimap({ terrain: t, margins: [0, 0, 0, 0], tileColor: () => [100, 100, 100], waterColor: [0, 0, 192], params: { blurPasses: 0, groundNoise: 0 }, objects: [{ x: 1280, y: 1280, rgb: [255, 0, 255], ...object }] });
    const lit: [number, number][] = [];
    for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) if (rgba[(y * 256 + x) * 4 + 1] === 0 && rgba[(y * 256 + x) * 4] === 255) lit.push([x, y]);
    const xs = lit.map((p) => p[0]), ys = lit.map((p) => p[1]);
    return { n: lit.length, w: Math.max(...xs) - Math.min(...xs) + 1, h: Math.max(...ys) - Math.min(...ys) + 1, lit };
  };
  // 12.8 px per tile: 64 × 13 pixels at 270 degrees, 13 × 64 turned a quarter.
  const flatStrip = draw({ mask: GATE1, angle: (3 * Math.PI) / 2 });
  assert.deepEqual([flatStrip.w, flatStrip.h, flatStrip.n], [64, 13, 64 * 13]);
  const turned = draw({ mask: GATE1, angle: Math.PI });
  assert.deepEqual([turned.w, turned.h], [13, 64]);
  // Control: the dot a texture of that size gave before is no strip.
  const dot = draw({ size: 2.2 });
  assert.ok(Math.abs(dot.w - dot.h) <= 1, `${dot.w} × ${dot.h}`);
  // A diagonal wall (StoneWall2Path: the north-west and the south-east corners): at 270 degrees the picture's top left.
  const wall = draw({ mask: WALL2, angle: (3 * Math.PI) / 2 }).lit;
  const [cx, cy] = [128, 128];
  const in_ = (dx: number, dy: number) => wall.some(([x, y]) => x === cx + dx && y === cy + dy);
  assert.deepEqual([in_(-12, -12), in_(12, 12), in_(12, -12), in_(-12, 12)], [true, true, false, false]);
});

test("textureOrder: a model's colour comes from the texture its geosets' materials show, not a particle texture first", () => {
  // IceGate.mdx: texture 0 is Clouds8x8 (its particles), texture 1 the walls', which its one material's layer shows.
  const gate = { textures: [{}, {}], geosets: [{ materialId: 0 }], materials: [{ layers: [{ textureIds: [1] }] }] };
  assert.deepEqual(textureOrder(gate), [1, 0]);
  assert.deepEqual(textureOrder({ ...gate, geosets: [] }), [0, 1], "no geoset: the file's order");
  assert.deepEqual(textureOrder({ textures: [{}, {}, {}], geosets: [{ materialId: 0 }, { materialId: 3 }], materials: [{ layers: [{ textureIds: [2] }, { textureIds: [2] }] }] }), [2, 0, 1], "once each; a missing material counts for none");
});

test("shownTextureMean: the mean of one colour per material (its first layer's texture), a team colour texture counting black", async () => {
  // The rule is from we-drive 2026-11-17 (dots-more, dots-models): the editor's dot of a goblin shipyard ruin (materials:
  // its own texture twice, team colour first) is 62,46,32, a granary's (one material of its first texture, two of its second)
  // two thirds of the second. The colours below are made up, NOT those
  // maps' texture colours (the means differ from the editor's numbers), so this checks the rule, not the editor's values.
  const colors: Record<string, Rgb> = { own: [93, 70, 49], second: [104, 80, 57], a: [123, 101, 74], b: [66, 49, 38] };
  const color = async (tex: { path: string }) => colors[tex.path] ?? null;
  const textures = [{ replaceableId: 0, path: "own" }, { replaceableId: 1, path: "" }, { replaceableId: 0, path: "second" }, { replaceableId: 0, path: "particle" }];
  const ruin = { textures, geosets: [{ materialId: 2 }, { materialId: 0 }, { materialId: 1 }],
    materials: [{ layers: [{ textureIds: [0] }] }, { layers: [{ textureIds: [0] }] }, { layers: [{ textureIds: [1] }, { textureIds: [2] }] }] };
  const near = (got: Rgb | null, want: number[]) => { assert.ok(got, "a colour"); got.forEach((v, k) => assert.ok(Math.abs(v - want[k]) < 1e-9, `${got} vs ${want}`)); };
  // The materials' first layers: the team colour (black) and the own texture twice (the second layer's texture isn't counted).
  near(await shownTextureMean(ruin, color), [(93 * 2) / 3, (70 * 2) / 3, (49 * 2) / 3]);
  const granary = { textures: [{ replaceableId: 0, path: "a" }, { replaceableId: 0, path: "b" }], geosets: [{ materialId: 0 }, { materialId: 1 }, { materialId: 2 }],
    materials: [{ layers: [{ textureIds: [0] }] }, { layers: [{ textureIds: [1] }] }, { layers: [{ textureIds: [1] }] }] };
  near(await shownTextureMean(granary, color), [(123 + 66 * 2) / 3, (101 + 49 * 2) / 3, (74 + 38 * 2) / 3]);
  // Control: the lower detail levels of an HD model (lod above 0) are copies and don't count.
  near(await shownTextureMean({ ...granary, geosets: [{ materialId: 0, lod: 0 }, { materialId: 1, lod: 0 }, { materialId: 1, lod: 1 }, { materialId: 2, lod: 1 }] }, color), [(123 + 66) / 2, (101 + 49) / 2, (74 + 38) / 2]);
  // Control: a texture that can't be read is left out, not black; nothing readable, or only the team colour: null.
  assert.deepEqual((await shownTextureMean({ ...granary, textures: [{ replaceableId: 0, path: "a" }, { replaceableId: 0, path: "gone" }] }, color))!.map(Math.round), [123, 101, 74]);
  assert.equal(await shownTextureMean({ textures: [{ replaceableId: 1, path: "" }], geosets: [{ materialId: 0 }], materials: [{ layers: [{ textureIds: [0] }] }] }, color), null);
  assert.equal(await shownTextureMean({ ...granary, geosets: [] }, color), null);
});

test("shownTextureMean: a material never seen (first layer alpha 0, no alpha track) doesn't count, as the HD pier ASpr's walk plane", async () => {
  // ASpr (HD): diffuse, a glow (alpha track), the diffuse again at alpha 0 (the walk plane). The editor's dot is the mean
  // of the first two (we-drive 2026-11-18). Colours made up.
  const colors: Record<string, Rgb> = { diffuse: [100, 80, 60], glow: [250, 220, 130] };
  const color = async (tex: { path: string }) => colors[tex.path] ?? null;
  const pier = (walk: { alpha: number; alphaTrack?: unknown }) => ({
    textures: [{ replaceableId: 0, path: "diffuse" }, { replaceableId: 0, path: "glow" }],
    geosets: [{ materialId: 0 }, { materialId: 1 }, { materialId: 2 }],
    materials: [{ layers: [{ textureIds: [0], alpha: 1 }] }, { layers: [{ textureIds: [1], alpha: 1, alphaTrack: {} }] }, { layers: [{ textureIds: [0], ...walk }] }],
  });
  assert.deepEqual(await shownTextureMean(pier({ alpha: 0 }), color), [175, 150, 95]);
  // Controls: the same material seen (alpha 1), or with an alpha track (it may show), counts.
  assert.deepEqual((await shownTextureMean(pier({ alpha: 1 }), color))!.map(Math.round), [150, 127, 83]);
  assert.deepEqual((await shownTextureMean(pier({ alpha: 0, alphaTrack: {} }), color))!.map(Math.round), [150, 127, 83]);
});

test("minimapObjects: a model's colour is asked for as a mean for a dot and as the first texture's for a drawn shape", async () => {
  const row = (pathTex: string) => ({ showInMM: "1", useMMColor: "0", MMRed: "0", MMGreen: "0", MMBlue: "0", pathTex });
  // A shape is a texture with gaps (a diagonal wall); a full rectangle (a gate, a tree) is a dot.
  const rows = new Map([["wall", row("PathTextures\\StoneWall2Path.tga")], ["gate", row("PathTextures\\Gate1Path.tga")], ["tree", row("PathTextures\\4x4Default.tga")], ["bare", row("_")]]);
  const masks: Record<string, PathMask> = { "PathTextures\\StoneWall2Path.tga": WALL2, "PathTextures\\Gate1Path.tga": GATE1, "PathTextures\\4x4Default.tga": maskOf(Array(4).fill("####")) };
  const asked: string[] = [];
  await minimapObjects(["wall", "gate", "tree", "bare"].map((id, i) => ({ id, position: [i * 128, 64, 0] as [number, number, number] })),
    { rows, bases: new Map(), modelColor: async (type, mean) => { asked.push(`${type}:${mean}`); return [1, 2, 3]; }, footprint: async () => 1, pathMask: async (p) => masks[p] ?? null });
  assert.deepEqual(asked, ["wall:false", "gate:true", "tree:true", "bare:true"]);
});

test("modelTextureColor: with `mean` a model whose geosets show no texture still gives its first texture's colour", async () => {
  const files = new Map<string, Uint8Array>([["Doodads\\Rock\\Rock0.mdx", mdxOfTextures([[0, "Textures\\RockWall.blp"]])], ["Textures\\RockWall.blp", tgaOf([87, 88, 82])]]);
  const read = async (p: string) => { const f = files.get(p); if (!f) throw new Error(`no ${p}`); return f; };
  const skin = { file: "Doodads\\Rock\\Rock", numVar: 10, texId: -1, texFile: "" };
  assert.deepEqual(await modelTextureColor(skin, read, true), [87, 88, 82]);
  assert.deepEqual(await modelTextureColor(skin, read, false), [87, 88, 82]);
});

test("minimapObjects: a destructable placed dead (life 0) is a dot of its row's pathTexDeath, the tile it stands in without one", async () => {
  // SnowareBay's 205 Northrend tree walls are placed dead (pathTexDeath "_"): the editor draws each as a one tile dot,
  // which at 1.6 pixels a tile only shows next to other dots (we-drive 2026-11-18: the same walls alive give the same
  // dots; with this rule Studio's set equals the editor's on a map of nothing but them).
  const tex = "PathTextures\\4x4Default.tga";
  const rows = new Map([
    ["NTtw", { showInMM: "1", useMMColor: "1", MMRed: "32", MMGreen: "48", MMBlue: "32", pathTex: tex, pathTexDeath: "_" }],
    ["rock", { showInMM: "1", useMMColor: "1", MMRed: "1", MMGreen: "2", MMBlue: "3", pathTex: tex, pathTexDeath: tex }],
  ]);
  const objects = await minimapObjects([
    { id: "NTtw", position: [0, 0, 0], life: 0 },
    { id: "NTtw", position: [128, 0, 0], life: 100 },
    { id: "NTtw", position: [256, 0, 0] },
    { id: "rock", position: [384, 0, 0], life: 0 },
  ], { rows, bases: new Map(), modelColor: async () => null, footprint: async () => 4, cells: async () => [4, 4] });
  assert.deepEqual(objects.map((o) => o.x), [0, 128, 256, 384]);
  assert.deepEqual(objects.map((o) => o.size), [0, 4, 4, 4]);
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
    // An HD model names its texture .tif; the game stores only the .dds (we-drive 2026-11-17: the editor's HD export draws the
    // rock, Studio's drew no dot while its colour came back null).
    ["Doodads\\Hd\\Hd.mdx", mdxOfTextures([[0, "Doodads\\Hd\\Rocks_Diffuse.tif"]])],
    ["Doodads/Hd/Rocks_Diffuse.dds", tgaOf([63, 46, 32])],
  ]);
  const read = async (p: string) => files.get(p) ?? assert.fail(`no ${p}`);
  const skin = (file: string, numVar: number, texId = -1, texFile = "") => ({ file, numVar, texId, texFile });
  // Team colour (replaceable 1) isn't the type's: the first plain texture counts.
  assert.deepEqual(await modelTextureColor(skin("Doodads\\Rock\\Rock", 10), read), [87, 88, 82]);
  // Two variations, but only the file without a number is stored; the type's replaceable texture (doodad skins give no
  // extension).
  assert.deepEqual(await modelTextureColor(skin("Doodads\\Tree\\Tree", 2, 31, "ReplaceableTextures\\Trees\\Bark"), read), [110, 60, 10]);
  assert.deepEqual(await modelTextureColor(skin("Doodads\\Hd\\Hd", 1), read), [63, 46, 32]);
  assert.equal(await modelTextureColor(skin("Doodads\\Bad\\Bad", 1), read), null);
  assert.equal(await modelTextureColor(skin("Doodads\\None\\None", 1), read), null);
});

test("minimapBase: in HD and DE the ground and cliff colours are the Reforged _Diffuse textures', in SD the classic ones", async () => {
  // Measured (we-drive 2026-11-13): the World Editor's HD export of HillsbradCreek colours its grass 23, 119, 16
  // (Lords_Grass_Diffuse's smallest mip), its SD export 44, 108, 27 (Lords_Grass's).
  const slk = (rows: string[][]) => ["ID;PWXL;N;E", ...rows.flatMap((row, y) => row.map((v, x) => `C;X${x + 1};Y${y + 1};K"${v}"`)), "E"].join("\r\n");
  const tables: Record<string, string> = {
    "TerrainArt\\Terrain.slk": slk([["tileID", "dir", "file"], ["Hgrs", "TerrainArt\\Test", "Test_Grass"], ["Hdrt", "TerrainArt\\Test", "Test_Dirt"]]),
    "TerrainArt\\CliffTypes.slk": slk([["cliffID", "texDir", "texFile"], ["CHgr", "TerrainArt\\Test", "Test_Cliff"]]),
    "TerrainArt\\Water.slk": slk([["waterID", "height", "mmAlpha", "mmRed", "mmGreen", "mmBlue"], ["HSha", "-0.7", "64", "0", "0", "192"]]),
    "Doodads\\Doodads.slk": slk([["doodID"]]),
    "Units\\DestructableData.slk": slk([["DestructableID"]]),
  };
  const files = new Map<string, Uint8Array>([
    ["TerrainArt\\Test\\Test_Grass.blp", tgaOf([44, 108, 27])], ["TerrainArt\\Test\\Test_Grass_Diffuse.blp", tgaOf([23, 119, 16])],
    ["TerrainArt\\Test\\Test_Cliff.blp", tgaOf([96, 124, 66])], ["TerrainArt\\Test\\Test_Cliff_Diffuse.blp", tgaOf([80, 90, 70])],
    // No Reforged dirt: the classic one stands in.
    ["TerrainArt\\Test\\Test_Dirt.blp", tgaOf([145, 104, 60])],
  ]);
  // The read stub only records and rejects (the code under test catches a failed read, so assert.fail in it would be lost).
  let reads: string[] = [];
  const read = async (p: string) => { reads.push(p); const f = files.get(p); if (!f) throw new Error(`no ${p}`); return f; };
  const t = { ...flat(2, 2), tileset: "H", groundTiles: ["Hgrs", "Hdrt"], cliffTiles: ["CHgr"] } as unknown as Terrain;
  const colours = async (mode: string) => {
    reads = [];
    const w3 = { settings: { get: (k: string) => (k === "game.graphicsMode" ? mode : undefined) },
      game: { readText: async (p: string) => tables[p] ?? assert.fail(`no ${p}`) }, workspace: { files: () => [] } } as unknown as W3Api;
    const b = await minimapBase(w3, t, [], read);
    return [b.tileColor("Hgrs"), b.tileColor("Hdrt"), b.cliffColor?.("CHgr")];
  };
  assert.deepEqual(await colours("hd"), [[23, 119, 16], [145, 104, 60], [80, 90, 70]]);
  assert.ok(reads.some((p) => p.includes("Test_Grass_Diffuse")), `HD reads the _Diffuse: ${reads}`);
  assert.deepEqual(await colours("de"), [[23, 119, 16], [145, 104, 60], [80, 90, 70]]);
  assert.deepEqual(await colours("sd"), [[44, 108, 27], [145, 104, 60], [96, 124, 66]]);
  assert.deepEqual(reads.filter((p) => p.includes("_Diffuse")), [], "SD never reads a _Diffuse texture");
  assert.ok(reads.length >= 3, `SD read the classic ones: ${reads}`);
});

test("minimapBase: under custom-tilesets 0 the slots show the tileset's own tiles, as the World Editor's minimap", async () => {
  // we-compare custom-tilesets-0 (2026-11-16): the editor's saved minimap of a reversed list with the flag 0 has the
  // tileset's order (Dirt west), with the flag 1 the file's (Grass west).
  const slk = (rows: string[][]) => ["ID;PWXL;N;E", ...rows.flatMap((row, y) => row.map((v, x) => `C;X${x + 1};Y${y + 1};K"${v}"`)), "E"].join("\r\n");
  const tables: Record<string, string> = {
    "TerrainArt\\Terrain.slk": slk([["tileID", "dir", "file"], ["Hdrt", "TerrainArt\\Test", "Test_Dirt"], ["Hgrs", "TerrainArt\\Test", "Test_Grass"], ["Xgrs", "TerrainArt\\Test", "Test_Other"]]),
    "TerrainArt\\CliffTypes.slk": slk([["cliffID", "texDir", "texFile"]]),
    "TerrainArt\\Water.slk": slk([["waterID", "height", "mmAlpha", "mmRed", "mmGreen", "mmBlue"]]),
    "Doodads\\Doodads.slk": slk([["doodID"]]),
    "Units\\DestructableData.slk": slk([["DestructableID"]]),
  };
  const files = new Map<string, Uint8Array>([["TerrainArt\\Test\\Test_Dirt.blp", tgaOf([145, 104, 60])], ["TerrainArt\\Test\\Test_Grass.blp", tgaOf([44, 108, 27])],
    ["TerrainArt\\Test\\Test_Other.blp", tgaOf([1, 2, 3])]]);
  const w3 = { settings: { get: (k: string) => (k === "game.graphicsMode" ? "sd" : undefined) },
    game: { readText: async (p: string) => tables[p] ?? assert.fail(`no ${p}`) }, workspace: { files: () => [] } } as unknown as W3Api;
  const read = async (p: string) => { const f = files.get(p); if (!f) throw new Error(`no ${p}`); return f; };
  // One row of points, west to east, point i painted with slot i.
  const map = (raw: number, groundTiles: string[]) => ({
    width: groundTiles.length, height: 1, offsetX: 0, offsetY: 0, tileset: "H", groundTiles, cliffTiles: [], customTilesetsRaw: raw,
    corners: groundTiles.map((_, i) => ({ texture: i, layer: 2, height: 0, water: 0, hasWater: false })),
  }) as unknown as Terrain;
  const westToEast = async (t: Terrain) => {
    const b = await minimapBase(w3, t, [], read);
    const g = groundColors(t, b.tileColor, b.cliffColor, null, b.drawnTiles);
    return t.groundTiles.map((_, i) => [...g.slice(i * 3, i * 3 + 3)]);
  };
  const dirt = [145, 104, 60], grass = [44, 108, 27];
  const reversed = map(0, ["Hgrs", "Hdrt"]);
  assert.deepEqual(await westToEast(reversed), [dirt, grass], "flag 0: the tileset's own order");
  assert.deepEqual(reversed.groundTiles, ["Hgrs", "Hdrt"], "the file's list stays as it is");
  assert.deepEqual(await westToEast(map(1, ["Hgrs", "Hdrt"])), [grass, dirt], "control: flag 1, the file's order");
  // A slot past the tileset's two shows its first tile; Xgrs, another tileset's, isn't the tileset's own.
  assert.deepEqual(await westToEast(map(0, ["Xgrs", "Hgrs", "Hdrt"])), [dirt, grass, dirt]);
  assert.deepEqual(await westToEast(map(1, ["Xgrs", "Hgrs", "Hdrt"])), [[1, 2, 3], grass, dirt], "control: flag 1");
});

test("minimapBase: a pathing texture is read once for its cells and its size, however many doodads have it", async () => {
  const slk = (rows: string[][]) => ["ID;PWXL;N;E", ...rows.flatMap((row, y) => row.map((v, x) => `C;X${x + 1};Y${y + 1};K"${v}"`)), "E"].join("\r\n");
  const doodRow = ["Y", "1", "1", "9", "8", "7"];
  const tables: Record<string, string> = {
    "TerrainArt\\Terrain.slk": slk([["tileID", "dir", "file"], ["Ypth", "TerrainArt\\Test", "Test_Path"]]),
    "TerrainArt\\CliffTypes.slk": slk([["cliffID", "texDir", "texFile"]]),
    "TerrainArt\\Water.slk": slk([["waterID", "height", "mmAlpha", "mmRed", "mmGreen", "mmBlue"]]),
    "Doodads\\Doodads.slk": slk([["doodID", "showInMM", "useMMColor", "MMRed", "MMGreen", "MMBlue", "pathTex"],
      ["Ytre", ...doodRow.slice(1), "PathTextures\\Square"], ["Ygat", ...doodRow.slice(1), "PathTextures\\Strip"]]),
    "Units\\DestructableData.slk": slk([["DestructableID"]]),
  };
  // A pathing texture of w × h cells, all of them blocking.
  const pathTga = (w: number, h: number) => {
    const t = new Uint8Array(18 + w * h * 4);
    t[2] = 2; t[12] = w; t[14] = h; t[16] = 32; t[17] = 0x28;
    t.fill(255, 18);
    return t;
  };
  const files = new Map<string, Uint8Array>([
    ["TerrainArt\\Test\\Test_Path.blp", tgaOf([50, 60, 70])], ["PathTextures\\Square.tga", pathTga(4, 4)], ["PathTextures\\Strip.tga", pathTga(8, 2)],
  ]);
  const reads = new Map<string, number>();
  const unexpected: string[] = [];
  const read = async (p: string) => {
    reads.set(p, (reads.get(p) ?? 0) + 1);
    const f = files.get(p);
    if (!f) { unexpected.push(p); throw new Error(`no ${p}`); }
    return f;
  };
  const w3 = { settings: { get: (k: string) => (k === "game.graphicsMode" ? "sd" : undefined) },
    game: { readText: async (p: string) => tables[p] ?? assert.fail(`no ${p}`) }, workspace: { files: () => [] } } as unknown as W3Api;
  const t = { ...flat(2, 2), tileset: "Y", groundTiles: ["Ypth"], cliffTiles: [] } as unknown as Terrain;
  const placed = ["Ytre", "Ytre", "Ygat", "Ytre", "Ygat"].map((id, i) => ({ id, position: [i * 64, 64, 0], angle: 0 }));
  const b = await minimapBase(w3, t, placed as unknown as Parameters<typeof minimapBase>[2], read);
  // The control: both textures were used, as dots of their cells' width and height (a full strip is a dot too).
  assert.deepEqual(b.objects.map((o) => `cells ${o.cells}`), ["cells 4,4", "cells 4,4", "cells 8,2", "cells 4,4", "cells 8,2"]);
  assert.deepEqual([reads.get("PathTextures\\Square.tga"), reads.get("PathTextures\\Strip.tga")], [1, 1]);
  assert.deepEqual(unexpected, [], "no other file was asked for");
});

test("minimapBase: in HD a doodad whose model only the _DE layer stores gets the grey dot, in the saved minimap as in Export Minimap", async () => {
  // we-compare mmsave-dots-models-hd and we-drive --export-minimap (branch we-compare-12, 2026-11-19): the World Editor in HD
  // draws EOcr, LCpa, LRsr, UO*, YO* … (56 types) as the grey 183 dot in its export and in the war3mapMap.blp its save writes;
  // Studio's save (buildMinimap) drew their models' colours.
  const slk = (rows: string[][]) => ["ID;PWXL;N;E", ...rows.flatMap((row, y) => row.map((v, x) => `C;X${x + 1};Y${y + 1};K"${v}"`)), "E"].join("\r\n");
  const tables: Record<string, string> = {
    "TerrainArt\\Terrain.slk": slk([["tileID", "dir", "file"], ["Ypth", "TerrainArt\\Test", "Test_Path"]]),
    "TerrainArt\\CliffTypes.slk": slk([["cliffID", "texDir", "texFile"]]),
    "TerrainArt\\Water.slk": slk([["waterID", "height", "mmAlpha", "mmRed", "mmGreen", "mmBlue"]]),
    "Doodads\\Doodads.slk": slk([["doodID", "showInMM", "useMMColor", "pathTex"], ["Ydeo", "1", "0", "none"], ["Ybas", "1", "0", "none"]]),
    "Units\\DestructableData.slk": slk([["DestructableID"]]),
    "Doodads\\DoodadSkins.txt": "[Ydeo]\r\nfile=Doodads\\De\\De\r\n[Ybas]\r\nfile=Doodads\\Base\\Base\r\n",
  };
  const files = new Map<string, Uint8Array>([
    ["TerrainArt\\Test\\Test_Path.blp", tgaOf([50, 60, 70])],
    ["Doodads\\De\\De.mdx", mdxOfTextures([[0, "Doodads\\De\\De.blp"]])], ["Doodads\\De\\De.blp", tgaOf([90, 30, 20])],
    ["Doodads\\Base\\Base.mdx", mdxOfTextures([[0, "Doodads\\Base\\Base.blp"]])], ["Doodads\\Base\\Base.blp", tgaOf([20, 40, 90])],
  ]);
  const read = async (p: string) => { const f = files.get(p); if (!f) throw new Error(`no ${p}`); return f; };
  // Where the game stores a file: the Ydeo model only in the 3.0 art layer.
  const resolve = async (p: string) => (/De[\\/]De\.mdx$/i.test(p) ? "War3.w3mod:_de.w3mod:Doodads/De/De.mdx" : `War3.w3mod:${p}`);
  const t = { ...flat(2, 2), tileset: "Y", groundTiles: ["Ypth"], cliffTiles: [] } as unknown as Terrain;
  const placed = [{ id: "Ydeo", position: [0, 64, 0], angle: 0 }, { id: "Ybas", position: [128, 64, 0], angle: 0 }];
  const dots = async (mode: string) => {
    const w3 = { settings: { get: (k: string) => (k === "game.graphicsMode" ? mode : undefined) },
      game: { readText: async (p: string) => tables[p] ?? "", resolve }, workspace: { files: () => [] } } as unknown as W3Api;
    // As buildMinimap (the save, rebuild_map, the CLI's rebuild) calls it.
    const b = await minimapBase(w3, t, placed as unknown as Parameters<typeof minimapBase>[2], read);
    return b.objects.map((o) => o.rgb);
  };
  assert.deepEqual(await dots("hd"), [[183, 183, 183], [20, 40, 90]]);
  // Control: SD reads the model (the base layer's files), and so does the other doodad in HD.
  assert.deepEqual(await dots("sd"), [[90, 30, 20], [20, 40, 90]]);
});

test("viewOutline: the view's corners on the ground, and far along a ray over the horizon", () => {
  type V = [number, number, number];
  const norm = (v: V): V => { const l = Math.hypot(...v); return [v[0] / l, v[1] / l, v[2] / l]; };
  // Straight down from 1000 over (100, 200), 90° across a 2:1 view: the ground 2000 × 1000 below.
  const down = (px: number, py: number) => ({ origin: [100, 200, 1000] as V, dir: norm([(px / 400 * 2 - 1) * 2, 1 - py / 200 * 2, -1]) });
  const pts = viewOutline(down, 400, 200, 0, 1e5);
  const want = [[-1900, 1200], [2100, 1200], [2100, -800], [-1900, -800]];
  assert.equal(pts.length, 4);
  pts.forEach((p, i) => assert.ok(Math.hypot(p[0] - want[i][0], p[1] - want[i][1]) < 1e-6, `${i}: ${p}`));
  // Looking level: the top corners look over the horizon and go to the far distance; the bottom ones meet the ground.
  const level = (px: number, py: number) => ({ origin: [0, 0, 100] as V, dir: norm([px / 400 * 2 - 1, 1, (1 - py / 200 * 2) * 0.5]) });
  const far = viewOutline(level, 400, 200, 0, 5000);
  assert.equal(far.length, 4);
  assert.ok(Math.abs(Math.hypot(far[0][0], far[0][1]) - 5000 * Math.hypot(1, 1) / Math.hypot(1, 1, 0.5)) < 1e-6);
  assert.ok(far[2][1] > 0 && far[2][1] < 5000, "a bottom corner meets the ground in front");
});

test("footprintTurned: the editor's turn of a dot's footprint (we-drive 2026-11-17, 8x6 and 4x6 at 40 to 50, 130 to 140, 220 to 230, 310 to 320 degrees and exact multiples of 45)", () => {
  const rad = (d: number) => Math.fround((d * Math.PI) / 180); // a file holds single precision angles
  // Measured in the editor: true = drawn as the texture is (the 270 degree side).
  const measured: [number, boolean][] = [[0, false], [40, false], [44, false], [45, true], [46, true], [90, true], [134, true], [135, false], [140, false], [180, false],
    [224, false], [225, true], [226, true], [270, true], [314, true], [315, true], [316, false], [360, false], [-45, false], [-90, true], [405, false]];
  for (const [deg, want] of measured) assert.equal(footprintTurned(rad(deg)), want, `${deg} degrees`);
  assert.equal(footprintTurned(NaN), false);
  // Control: the earlier rule (|cos| above 0.71 turns it) gets 225, -45 and 405 wrong, so this test can fail.
  const old = (deg: number) => !(Math.abs(Math.cos(rad(deg))) > Math.SQRT1_2);
  assert.ok([225, -45, 405].some((d) => old(d) !== measured.find((m) => m[0] === d)![1]));
});
test("modelTextureColor on the game's own models and textures: each dot the colour of the World Editor's export", async (ctx) => {
  // The editor's Export Minimap of minimap-dots-models.w3x, minimap-dots-more.w3x and minimap-dots-dests.w3x (we-drive,
  // branch we-compare-13, 2026-11-19; make-minimap-dots.mjs): the mean of each dot's middle 4 x 4 pixels (a dot is
  // 8 x 8 there, of one colour). The colour is the mean of the textures the model's materials show (shownTextureMean),
  // each texture's smallest mip, read from the game here as the app reads it.
  const skinFiles = gameFiles(["War3.w3mod:Doodads/DoodadSkins.txt", "War3.w3mod:Units/DestructableSkin.txt"]);
  if (skinFiles.length < 2) return skipOrFail(ctx, "no game or release CLI (.game-path, target/release/w3proj)");
  const sections = new Map<string, Map<string, string>>();
  for (const f of skinFiles) for (const [id, sec] of parseIni(new TextDecoder().decode(f.bytes), { firstWins: true })) sections.set(id, new Map([...sec].map(([k, v]) => [k.toLowerCase(), v])));
  // The mode's keys first (file:hd, texID:hd), as the app reads the skins (objects.ts parseSkins).
  const skinOf = (id: string, mode: string) => {
    const s = sections.get(id);
    const get = (k: string) => (s ? artValue((key) => s.get(key.toLowerCase()), k, mode) : undefined);
    assert.ok(get("file"), `${id}: no skin`);
    return { file: get("file")!, numVar: Number(get("numvar") ?? 1) || 1, texId: Number(get("texid") ?? -1), texFile: get("texfile") ?? "" };
  };
  // id: [SD, HD] as the editor drew them. The SD shipyard ruin's three materials show its texture twice and team colour
  // (black) once; the SD granary's three show two textures, one of them twice. Shipyard and granary were the open
  // point's numbers (63, 46, 32 and 90, 70, 53 then; this export's 61, 45, 32 and 83, 64, 49).
  const editor: [string, Rgb, Rgb][] = [
    ["LSrg", [61, 45, 32], [82, 70, 64]], ["LSgr", [83, 64, 49], [91, 80, 71]], ["LSeb", [135, 122, 76], [115, 93, 77]], ["LSsf", [66, 49, 38], [71, 59, 54]],
    ["LTcr", [123, 105, 94], [88, 58, 39]], ["LTba", [125, 106, 95], [127, 94, 73]], ["ITcr", [102, 154, 170], [135, 167, 196]], ["BTs2", [113, 59, 33], [80, 75, 70]],
    ["DTrc", [156, 69, 66], [75, 40, 38]], ["NTbd", [160, 147, 126], [106, 87, 70]],
  ];
  for (const [mode, layers] of [["sd", ["War3.w3mod:"]], ["hd", ["War3.w3mod:_HD.w3mod:", "War3.w3mod:"]]] as const) {
    // [Refactored] Cache gameFiles lookups per mode and batch-prefetch model paths in one CLI call instead of spawning a subprocess per read.
    const cache = new Map<string, Uint8Array | null>();
    const modelCandidates = editor.flatMap(([id]) => {
      const s = skinOf(id, mode);
      const base = s.file.replace(/\\/g, "/");
      return layers.flatMap((l) => (s.numVar > 1 ? [`${l}${base}0.mdx`, `${l}${base}.mdx`] : [`${l}${base}.mdx`]));
    });
    for (const hit of gameFiles(modelCandidates)) cache.set(hit.name.toLowerCase(), hit.bytes);
    for (const c of modelCandidates) if (!cache.has(c.toLowerCase())) cache.set(c.toLowerCase(), null);

    const read = async (path: string) => {
      const norm = path.replace(/\\/g, "/");
      const specs = layers.map((l) => l + norm);
      const uncached = specs.filter((s) => !cache.has(s.toLowerCase()));
      if (uncached.length > 0) {
        for (const hit of gameFiles(uncached)) cache.set(hit.name.toLowerCase(), hit.bytes);
        for (const s of uncached) if (!cache.has(s.toLowerCase())) cache.set(s.toLowerCase(), null);
      }
      for (const s of specs) {
        const bytes = cache.get(s.toLowerCase());
        if (bytes) return bytes;
      }
      throw new Error(`not stored: ${path}`);
    };
    for (const [id, sd, hd] of editor) {
      const want = mode === "sd" ? sd : hd;
      const got = await modelTextureColor(skinOf(id, mode), read, true);
      assert.ok(got && got.every((v, k) => Math.abs(v - want[k]) <= 6), `${mode} ${id}: ${got?.map(Math.round)} against the editor's ${want}`);
    }
    // Control: in SD the first texture alone (the rule before shownTextureMean) is far from the shipyard ruin's dot
    // (in HD its model shows that texture alone: 85, 73, 66 either way).
    if (mode === "sd") {
      const first = await modelTextureColor(skinOf("LSrg", mode), read, false);
      assert.ok(first && first.some((v, k) => Math.abs(v - editor[0][1][k]) > 10), `control: ${first?.map(Math.round)}`);
    }
  }
});

test("minimapObjects: a doodad whose model can't be read is a grey dot whatever its pathing texture (a palisade has none)", async () => {
  const row = (pathTex: string) => ({ showInMM: "1", useMMColor: "0", pathTex });
  const objects = await minimapObjects(
    ["a", "b"].map((id, i) => ({ id, position: [i * 128, 64, 0] as [number, number, number] })),
    { rows: new Map([["a", row("PathTextures\\4x4Default.tga")], ["b", row("none")]]), bases: new Map(), modelColor: async () => null, footprint: async () => 1,
      cells: async () => [4, 4], pathMask: async () => maskOf(Array(4).fill("####")) });
  assert.deepEqual(objects.map((o) => o.rgb), [[183, 183, 183], [183, 183, 183]]);
});

test("modelTextureColor: a model the map only has as .mdl gives the colour the same model gives as .mdx, the .mdx asked for first", async () => {
  const mdl = new TextEncoder().encode([
    "Version { FormatVersion 800, }",
    "Model \"OnlyMdl\" { NumGeosets 0, BlendTime 150, }",
    "Textures 3 {",
    "\tBitmap { Image \"\", ReplaceableId 1, }",
    "\tBitmap { Image \"Textures\\RockWall.blp\", }",
    "\tBitmap { Image \"Textures\\Moss.blp\", }",
    "}",
  ].join("\n"));
  const mdx = mdxOfTextures([[1, ""], [0, "Textures\\RockWall.blp"], [0, "Textures\\Moss.blp"]]);
  const textures: [string, Uint8Array][] = [["Textures\\RockWall.blp", tgaOf([87, 88, 82])], ["Textures\\Moss.blp", tgaOf([20, 90, 30])]];
  const asked: string[] = [];
  const reader = (files: Map<string, Uint8Array>) => async (p: string) => { asked.push(p); const f = files.get(p); if (!f) throw new Error(`not found: ${p}`); return f; };
  const asMdl = reader(new Map([["Doodads\\Imp\\Imp0.mdl", mdl], ...textures]));
  const asMdx = reader(new Map([["Doodads\\Imp\\Imp0.mdx", mdx], ...textures]));
  const skin = { file: "Doodads\\Imp\\Imp.mdl", numVar: 2, texId: -1, texFile: "" };
  for (const mean of [false, true]) {
    const want = await modelTextureColor(skin, asMdx, mean);
    assert.deepEqual(want, [87, 88, 82], `the .mdx's colour (mean ${mean})`);
    asked.length = 0;
    assert.deepEqual(await modelTextureColor(skin, asMdl, mean), want, `the .mdl's is the same (mean ${mean})`);
    assert.equal(asked[0], "Doodads\\Imp\\Imp0.mdx", "the .mdx first");
    assert.ok(asked.indexOf("Doodads\\Imp\\Imp0.mdl") > asked.indexOf("Doodads\\Imp\\Imp.mdx"), "the .mdl names after all the .mdx ones");
  }
  // Control: with neither, no colour.
  assert.equal(await modelTextureColor(skin, reader(new Map(textures))), null);
});

test("modelTextureColor and minimapBase in DE fall back to the HD model when the plain Classic file isn't stored (EW00, ET00, EMt0)", async () => {
  const slk = (rows: string[][]) => ["ID;PWXL;N;E", ...rows.flatMap((row, y) => row.map((v, x) => `C;X${x + 1};Y${y + 1};K"${v}"`)), "E"].join("\r\n");
  const tables: Record<string, string> = {
    "TerrainArt\\Terrain.slk": slk([["tileID", "dir", "file"], ["Zdrt", "TerrainArt\\Test", "Test_Dirt"]]),
    "TerrainArt\\CliffTypes.slk": slk([["cliffID", "texDir", "texFile"]]),
    "TerrainArt\\Water.slk": slk([["waterID", "height", "mmAlpha", "mmRed", "mmGreen", "mmBlue"]]),
    "Doodads\\Doodads.slk": slk([["doodID", "showInMM", "useMMColor", "pathTex"], ["EW00", "1", "0", "none"], ["ET00", "1", "0", "none"]]),
    "Units\\DestructableData.slk": slk([["DestructableID"]]),
    "Doodads\\DoodadSkins.txt": [
      "[EW00]", "numVar=1", "file=Doodads\\Ruins\\Terrain\\RuinsWall0\\RuinsWall0", "file:hd=Doodads\\RuinTomb\\Structures\\ExteriorWall\\ExteriorWall",
      "[ET00]", "numVar=1", "file=Doodads\\Ruins\\Terrain\\RuinsWall0\\RuinsWall0", "file:hd=Doodads\\RuinTomb\\Structures\\ExteriorTower\\ExteriorTower",
    ].join("\r\n"),
  };
  const files = new Map<string, Uint8Array>([
    ["TerrainArt\\Test\\Test_Dirt.blp", tgaOf([50, 60, 70])],
    ["Doodads\\RuinTomb\\Structures\\ExteriorWall\\ExteriorWall.mdx", mdxOfTextures([[0, "Doodads\\RuinTomb\\Wall.blp"]])],
    ["Doodads\\RuinTomb\\Wall.blp", tgaOf([120, 40, 30])],
    ["Doodads\\RuinTomb\\Structures\\ExteriorTower\\ExteriorTower.mdx", mdxOfTextures([[0, "Doodads\\RuinTomb\\Tower.blp"]])],
    ["Doodads\\RuinTomb\\Tower.blp", tgaOf([30, 80, 140])],
  ]);
  const read = async (p: string) => { const f = files.get(p); if (!f) throw new Error(`no ${p}`); return f; };
  assert.deepEqual(await modelTextureColor({
    file: "Doodads\\Ruins\\Terrain\\RuinsWall0\\RuinsWall0",
    reforgedFile: "Doodads\\RuinTomb\\Structures\\ExteriorWall\\ExteriorWall",
    numVar: 1, texId: -1, texFile: "",
  }, read, true), [120, 40, 30]);
  assert.equal(await modelTextureColor({
    file: "Doodads\\Ruins\\Terrain\\RuinsWall0\\RuinsWall0",
    numVar: 1, texId: -1, texFile: "",
  }, read, true), null, "control: without reforgedFile it stays unread");

  const t = { ...flat(2, 2), tileset: "Z", groundTiles: ["Zdrt"], cliffTiles: [] } as unknown as Terrain;
  const placed = [{ id: "EW00", position: [0, 64, 0], angle: 0 }, { id: "ET00", position: [128, 64, 0], angle: 0 }];
  const colorsIn = async (mode: string) => {
    const w3 = { settings: { get: (k: string) => (k === "game.graphicsMode" ? mode : undefined) },
      game: { readText: async (p: string) => tables[p] ?? "", resolve: async (p: string) => `War3.w3mod:${p}` }, workspace: { files: () => [] } } as unknown as W3Api;
    const b = await minimapBase(w3, t, placed as unknown as Parameters<typeof minimapBase>[2], read);
    return b.objects.map((o) => o.rgb);
  };
  assert.deepEqual(await colorsIn("de"), [[120, 40, 30], [30, 80, 140]]);
  assert.deepEqual(await colorsIn("sd"), [[183, 183, 183], [183, 183, 183]], "control: SD has no HD fallback");
});
