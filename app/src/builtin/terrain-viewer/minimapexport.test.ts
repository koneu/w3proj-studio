import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { inflateSync } from "node:zlib";
import { test } from "node:test";
import type { W3Api } from "../../extensions/api";
import { decodeImage } from "../../lib/image/index.ts";
import { NO_BUILD, NO_WALK, NO_WATER } from "../../lib/terrain/pathing";
import { parseW3e, type Terrain } from "../../lib/terrain/w3e";
import { w3eFromText } from "../../lib/terrain/w3etext";
import type { MinimapInput, Rgb } from "./minimap";
import { DEFAULT_EXPORT, exportMinimap, exportPicture, pathingOverlay, type ExportOptions, type ExportSource } from "./minimapexport";
import type { Placed } from "./objects";

/** 17×17 corners, all one tile, no water; the playable area is the inner 8×8 tiles (margins 4). */
function source(opts: { units?: Placed[]; regions?: Awaited<ReturnType<ExportSource["regions"]>> } = {}): ExportSource & { asked: string[] } {
  const width = 17, height = 17;
  const corners = Array.from({ length: width * height }, () => ({ texture: 0, hasWater: false, water: 0, height: 0, layer: 2, boundary: false }));
  const terrain = { width, height, offsetX: -1024, offsetY: -1024, corners, groundTiles: ["Lgrs"], tileset: "L" } as unknown as Terrain;
  const asked: string[] = [];
  const icon = { width: 2, height: 2, rgba: Uint8Array.from([255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255]) };
  return {
    asked,
    base: { terrain, margins: [4, 4, 4, 4], tileColor: () => [100, 200, 100], waterColor: [0, 0, 192], objects: [{ x: 0, y: 0, rgb: [250, 0, 250] }] },
    terrain, units: opts.units ?? [],
    pathing: async () => { asked.push("pathing"); const cells = new Uint8Array(64 * 64).fill(NO_WATER); cells.fill(NO_WATER | NO_WALK, 0, 64 * 32); return { cells, width: 64, height: 64 }; },
    regions: async () => { asked.push("regions"); return opts.regions ?? []; },
    iconKind: async () => { asked.push("icons"); return (u) => (u.id === "ngol" ? 0 : null); },
    iconImage: async () => icon,
    // Flat colours: the grain would scatter the pixels these tests look at.
    params: { groundNoise: 0 },
  };
}
const px = (rgba: Uint8ClampedArray, size: number, x: number, y: number) => [...rgba.subarray((y * size + x) * 4, (y * size + x) * 4 + 3)];
const opts = (o: Partial<ExportOptions> = {}): ExportOptions => ({ ...DEFAULT_EXPORT, smooth: false, ...o });
const unit = (id: string, x: number, y: number, player = 0): Placed => ({ id, variation: 0, position: [x, y, 0], angle: 0, scale: [1, 1, 1], player });

test("the picture has the chosen size, and the playable area fills it unless the whole map is asked for", async () => {
  const s = source();
  const playable = await exportPicture(s, opts({ size: 64, doodads: false }));
  assert.equal(playable.length, 64 * 64 * 4);
  // The corner of the playable area is ground; of the whole map (border 4 of 16 tiles) still ground, both green.
  assert.deepEqual(px(playable, 64, 0, 0), [100, 200, 100]);
  const whole = await exportPicture(s, opts({ size: 64, doodads: false, playableOnly: false }));
  assert.deepEqual(px(whole, 64, 0, 0), [100, 200, 100]);
  // The doodad at the centre is bigger on the playable picture (it covers fewer tiles).
  const dot = (rgba: Uint8ClampedArray) => { let n = 0; for (let i = 0; i < 64 * 64; i++) if (rgba[i * 4] === 250) n++; return n; };
  const a = await exportPicture(s, opts({ size: 64 })), b = await exportPicture(s, opts({ size: 64, playableOnly: false }));
  assert.ok(dot(a) > dot(b) && dot(b) > 0, `${dot(a)} vs ${dot(b)}`);
  assert.equal(dot(await exportPicture(s, opts({ size: 64, doodads: false }))), 0);
});

test("without terrain the ground is black; pathing, units, regions and icons are drawn when asked", async () => {
  const s = source({ units: [unit("hfoo", -256, 256, 1), unit("ngol", 256, 256), unit("sloc", 256, -256, 0)], regions: [{ left: -512, bottom: -512, right: -256, top: -256, color: { red: 255, green: 0, blue: 0 } }] });
  const bare = await exportPicture(s, opts({ size: 64, terrain: false, doodads: false, units: false, icons: false }));
  assert.deepEqual(px(bare, 64, 10, 10), [0, 0, 0]);
  assert.deepEqual(s.asked, []);
  // Pathing: the south half unwalkable (red over the ground), the north half free.
  const paths = await exportPicture(s, opts({ size: 64, doodads: false, units: false, icons: false, pathing: true }));
  assert.ok(px(paths, 64, 32, 60)[0] > 150 && px(paths, 64, 32, 60)[1] < 120, String(px(paths, 64, 32, 60)));
  assert.deepEqual(px(paths, 64, 32, 4), [100, 200, 100]);
  // A unit in its owner's colour (blue for player 2), start locations aren't units.
  const units = await exportPicture(s, opts({ size: 64, doodads: false, units: true, icons: false }));
  assert.deepEqual(px(units, 64, 16, 16), [0, 66, 255]);
  assert.deepEqual(px(units, 64, 48, 48), [100, 200, 100]);
  // Regions: outlined in their colour.
  const regions = await exportPicture(s, opts({ size: 64, doodads: false, units: false, icons: false, regions: true }));
  assert.deepEqual(px(regions, 64, 0, 63), [255, 0, 0]);
  // Icons: the gold mine white, the start location in its player's colour; the footman has none.
  const icons = await exportPicture(s, opts({ size: 64, doodads: false, units: false, icons: true }));
  assert.deepEqual(px(icons, 64, 48, 16), [255, 255, 255]);
  assert.deepEqual(px(icons, 64, 48, 48), [255, 3, 3]);
  assert.deepEqual(px(icons, 64, 16, 16), [100, 200, 100]);
  assert.deepEqual(s.asked, ["pathing", "regions", "icons"]);
});

test("the options start as the World Editor's", () => {
  // World Editor 7003 (2026-11-12): terrain, water, doodads and Playable Area Only on; the rest off.
  const on = Object.entries(DEFAULT_EXPORT).filter(([, v]) => v === true).map(([k]) => k).sort();
  assert.deepEqual(on, ["doodads", "playableOnly", "smooth", "terrain", "water"]);
  assert.equal(DEFAULT_EXPORT.size, 256);
});

test("Playable Area Only cuts doodads past the playable area, as the editor's export", async () => {
  // A square map (8 × 8 playable tiles) made wide: margins 4 left and right, 6 at the bottom and top, so the picture
  // has black bands above and below. A tree just past the top edge and one just past the bottom.
  const s = source();
  s.base = { ...s.base, margins: [4, 4, 6, 6], objects: [{ x: 0, y: 2 * 128 + 40, rgb: [250, 0, 250] }, { x: 0, y: -2 * 128 - 40, rgb: [250, 0, 250] }] };
  const rgba = await exportPicture(s, opts({ size: 64 }));
  let past = 0, inside = 0;
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) if (px(rgba, 64, x, y)[0] === 250) (y < 16 || y >= 48 ? past++ : inside++);
  assert.equal(past, 0, "nothing in the black bands");
  assert.ok(inside > 0, "control: the trees' dots reach into the playable area");
});

test("Include Blight colours blighted ground in the tileset's blight colour", async () => {
  const s = source();
  s.terrain.corners.forEach((c, i) => { (c as { blight?: boolean }).blight = i % 17 < 8; });
  s.base = { ...s.base, blightColor: [60, 50, 40] };
  const west = (o: Partial<ExportOptions>) => exportPicture(s, opts({ size: 64, doodads: false, ...o })).then((p) => px(p, 64, 4, 32));
  assert.deepEqual(await west({ blight: true }), [60, 50, 40]);
  assert.deepEqual(await west({}), [100, 200, 100], "off by default");
  const east = px(await exportPicture(s, opts({ size: 64, doodads: false, blight: true })), 64, 60, 32);
  assert.deepEqual(east, [100, 200, 100], "unblighted ground keeps its colour");
});

test("smoothing softens the edges", async () => {
  const s = source();
  const sharp = await exportPicture(s, opts({ size: 64 })), soft = await exportPicture(s, opts({ size: 64, smooth: true }));
  // The doodad's dot (radius 4.8 pixels here) at its edge: sharp, its colour or the ground's; smoothed, a mix.
  const edge = [...Array(10).keys()].map((d) => px(sharp, 64, 32 + d, 32));
  const last = edge.map((c) => c[0] === 250).lastIndexOf(true);
  assert.ok(last > 0 && last < 9, String(last));
  assert.deepEqual(px(sharp, 64, 33 + last, 32), [100, 200, 100]);
  const mixed = px(soft, 64, 32 + last, 32);
  assert.ok(mixed[0] > 100 && mixed[0] < 250 && mixed[1] > 0 && mixed[1] < 200, String(mixed));
});

test("the pathing map's colours", () => {
  const rgba = pathingOverlay(Uint8Array.from([NO_WATER, NO_WATER | NO_WALK, NO_WALK, 0, NO_WATER | NO_BUILD]));
  assert.deepEqual([...rgba.subarray(0, 4)], [0, 0, 0, 0]);
  assert.deepEqual([...rgba.subarray(4, 8)], [230, 30, 30, 170]);
  assert.deepEqual([...rgba.subarray(8, 12)], [30, 90, 240, 170]);
  assert.equal(rgba[15], 110);
  assert.deepEqual([...rgba.subarray(16, 20)], [230, 200, 40, 110]);
});

function pixels(png: Uint8Array) {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const width = view.getUint32(16), height = view.getUint32(20);
  const raw = inflateSync(Buffer.from(png.subarray(41, png.length - 12)));
  return { width, height, at: (x: number, y: number) => [...raw.subarray(y * (1 + width * 4) + 1 + x * 4, y * (1 + width * 4) + 1 + x * 4 + 3)] };
}

function fake(pick: string | null = "C:\\out\\mini") {
  const written: { path: string; bytes: Uint8Array }[] = [];
  const picked: unknown[] = [];
  const w3 = {
    workspace: { project: () => ({ name: "My Map", root: "C:\\p" }) },
    window: { pickSaveFile: async (o: unknown) => { picked.push(o); return pick; }, showInfo: async () => undefined },
    backend: { writeBytes: async (path: string, bytes: Uint8Array) => { written.push({ path, bytes }); } },
  } as unknown as W3Api;
  return { w3, written, picked };
}

test("Export Minimap writes the picture as a PNG to the chosen file, adding .png", async () => {
  const { w3, written, picked } = fake();
  let sourced = 0;
  assert.equal(await exportMinimap(w3, async () => { sourced++; return source(); }, { size: 128, smooth: false }), "C:\\out\\mini.png");
  assert.equal(sourced, 1);
  assert.equal(written.length, 1);
  assert.equal(written[0].path, "C:\\out\\mini.png");
  const png = pixels(written[0].bytes);
  assert.deepEqual([png.width, png.height], [128, 128]);
  assert.deepEqual(png.at(0, 0), [100, 200, 100]);
  assert.deepEqual(png.at(64, 64), [250, 0, 250]);
  assert.equal((picked[0] as { defaultPath: string }).defaultPath, "My Map minimap.png");
});

test("another project opened while the file was chosen: nothing is written", async () => {
  const { w3, written } = fake();
  let root = "C:\\p";
  (w3.workspace as { project: () => unknown }).project = () => ({ name: "My Map", root });
  await assert.rejects(exportMinimap(w3, async () => { root = "C:\\other"; return source(); }, {}), /Another project/);
  assert.equal(written.length, 0);
});

test("a chosen .PNG name stays; cancelling writes nothing and draws nothing; a bad size is refused", async () => {
  const a = fake("D:\\x\\Mini.PNG");
  assert.equal(await exportMinimap(a.w3, async () => source(), {}), "D:\\x\\Mini.PNG");
  const b = fake(null);
  assert.equal(await exportMinimap(b.w3, async () => { throw new Error("not drawn"); }, {}), null);
  assert.equal(b.written.length, 0);
  const c = fake();
  await assert.rejects(exportMinimap(c.w3, async () => source(), { size: 0 }), /image size/);
  assert.equal(c.picked.length, 0);
});

/** A file of tests/fixtures/minimap-we, found from where the tests run (app/ or the repository). */
function fixture(name: string): Uint8Array {
  for (let dir = process.cwd(); ; dir = dirname(dir)) {
    const p = join(dir, "tests", "fixtures", "minimap-we", name);
    if (existsSync(p)) return new Uint8Array(readFileSync(p));
    if (dirname(dir) === dir) throw new Error(`tests/fixtures/minimap-we/${name} not found`);
  }
}

// cliff.w3m (smoketest_maps): Lordaeron dirt with a grass patch and a raised plateau of grass cliffs. The colours are
// the smallest mip levels of Lords_Dirt, Lords_Grass and Lords_Cliff1 (Classic, the game's 2.0 files), which is what
// minimapBase reads (smallestMipColor). The editor's picture: its Export Minimap (256 px TGA, playable area, terrain,
// water and doodads on; 2026-11-11), the part at 80, 40 of 128 × 96 pixels with the plateau and an edge of the grass.
const CLIFF_TILES: Record<string, Rgb> = { Ldrt: [145, 104, 60], Lgrs: [44, 108, 27] };
const CLIFF_CLIFFS: Record<string, Rgb> = { CLgr: [96, 124, 66] };
const CROP = { x: 80, y: 40, width: 128, height: 96 };

/** cliff.w3m exported with Export Minimap's defaults (as the editor's picture was). */
function cliffExport(params: MinimapInput["params"] = {}) {
  const terrain = parseW3e(w3eFromText(new TextDecoder().decode(fixture("cliff.w3e.txt"))));
  const src: ExportSource = {
    base: {
      terrain, margins: [6, 6, 4, 8], waterColor: [0, 0, 192], objects: [],
      tileColor: (id) => CLIFF_TILES[id] ?? [255, 0, 255],
      cliffColor: (id) => CLIFF_CLIFFS[id] ?? [255, 0, 255],
    },
    terrain, units: [], params,
    pathing: async () => { throw new Error("not asked"); },
    regions: async () => [],
    iconKind: async () => () => null,
    iconImage: async () => null,
  };
  return exportPicture(src, DEFAULT_EXPORT);
}

/** Per channel over the crop: the mean of both pictures; the mean absolute difference of their pixels, and of the
 *  means of `block` × `block` squares (the grain is random in both, so pixels can't agree closer than it). */
function compare(ours: Uint8ClampedArray, editor: { width: number; rgba: ArrayLike<number> }, block: number) {
  const mine = (x: number, y: number, k: number) => ours[((CROP.y + y) * 256 + CROP.x + x) * 4 + k];
  const theirs = (x: number, y: number, k: number) => editor.rgba[(y * editor.width + x) * 4 + k];
  const mean = [[0, 0, 0], [0, 0, 0]];
  let mad = 0, blockMad = 0, blocks = 0;
  for (let y = 0; y < CROP.height; y++) for (let x = 0; x < CROP.width; x++) for (let k = 0; k < 3; k++) {
    mean[0][k] += mine(x, y, k); mean[1][k] += theirs(x, y, k);
    mad += Math.abs(mine(x, y, k) - theirs(x, y, k));
  }
  for (let by = 0; by + block <= CROP.height; by += block) for (let bx = 0; bx + block <= CROP.width; bx += block) for (let k = 0; k < 3; k++) {
    let d = 0;
    for (let y = by; y < by + block; y++) for (let x = bx; x < bx + block; x++) d += mine(x, y, k) - theirs(x, y, k);
    blockMad += Math.abs(d) / (block * block);
    blocks++;
  }
  const n = CROP.width * CROP.height;
  return { ours: mean[0].map((s) => s / n), editor: mean[1].map((s) => s / n), mad: mad / (n * 3), blockMad: blockMad / blocks };
}

/** Mean colour of an area (x, y, w, h) of a picture `width` pixels wide. */
function meanOf(rgba: ArrayLike<number>, width: number, [x0, y0, w, h]: number[]): number[] {
  const s = [0, 0, 0];
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) for (let k = 0; k < 3; k++) s[k] += rgba[(y * width + x) * 4 + k];
  return s.map((v) => v / (w * h));
}

/** How far the green channel scatters around its mean in a flat area (x, y, w, h), relative to it. */
function grainOf(rgba: ArrayLike<number>, width: number, [x0, y0, w, h]: number[]): number {
  const g: number[] = [];
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) g.push(rgba[(y * width + x) * 4 + 1]);
  const m = g.reduce((s, v) => s + v, 0) / g.length;
  return Math.sqrt(g.reduce((s, v) => s + (v - m) ** 2, 0) / g.length) / m;
}

test("cliff.w3m against the World Editor's Export Minimap: colours, the lighter cliffs, the grain", async (t) => {
  const editor = decodeImage(fixture("export-crop.tga"), "export-crop.tga").mip(0);
  assert.deepEqual([editor.width, editor.height], [CROP.width, CROP.height]);
  const ours = await cliffExport();
  const c = compare(ours, editor, 4);
  const report = `ours ${c.ours.map((v) => v.toFixed(1))}, the editor's ${c.editor.map((v) => v.toFixed(1))}, pixels ${c.mad.toFixed(2)} apart, 4 × 4 squares ${c.blockMad.toFixed(2)}`;
  t.diagnostic(report);
  for (let k = 0; k < 3; k++) assert.ok(Math.abs(c.ours[k] - c.editor[k]) < 2, `channel ${k}: ${report}`);
  assert.ok(c.blockMad < 4, report);
  // The plateau (grass cliffs and the ground around them) is lighter than the grass, in both.
  const plateau = [40, 36, 20, 8], grass = [5, 60, 20, 30];
  const inOurs = (r: number[]) => [r[0] + CROP.x, r[1] + CROP.y, r[2], r[3]];
  for (const [name, p, g] of [
    ["the editor's", meanOf(editor.rgba, CROP.width, plateau), meanOf(editor.rgba, CROP.width, grass)],
    ["ours", meanOf(ours, 256, inOurs(plateau)), meanOf(ours, 256, inOurs(grass))],
  ] as const) {
    assert.ok(p[0] > g[0] + 30 && p[2] > g[2] + 20, `${name}: plateau ${p.map(Math.round)}, grass ${g.map(Math.round)}`);
  }
  // The grain: about ±10 % on the editor's grass (control) and on ours; none when it is turned off.
  const editorGrain = grainOf(editor.rgba, CROP.width, grass);
  assert.ok(editorGrain > 0.045 && editorGrain < 0.07, `the editor's grain ${editorGrain}`);
  const ourGrain = grainOf(ours, 256, inOurs(grass));
  assert.ok(ourGrain > 0.045 && ourGrain < 0.07, `our grain ${ourGrain}`);
  assert.ok(grainOf(await cliffExport({ groundNoise: 0 }), 256, inOurs(grass)) < 0.01);
});
