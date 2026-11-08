import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";
import { test } from "node:test";
import type { W3Api } from "../../extensions/api";
import { NO_BUILD, NO_WALK, NO_WATER } from "../../lib/terrain/pathing";
import type { Terrain } from "../../lib/terrain/w3e";
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
    params: {},
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
  assert.deepEqual(px(playable, 64, 0, 0), [90, 180, 90]);
  const whole = await exportPicture(s, opts({ size: 64, doodads: false, playableOnly: false }));
  assert.deepEqual(px(whole, 64, 0, 0), [90, 180, 90]);
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
  assert.deepEqual(px(paths, 64, 32, 4), [90, 180, 90]);
  // A unit in its owner's colour (blue for player 2), start locations aren't units.
  const units = await exportPicture(s, opts({ size: 64, doodads: false, icons: false }));
  assert.deepEqual(px(units, 64, 16, 16), [0, 66, 255]);
  assert.deepEqual(px(units, 64, 48, 48), [90, 180, 90]);
  // Regions: outlined in their colour.
  const regions = await exportPicture(s, opts({ size: 64, doodads: false, units: false, icons: false, regions: true }));
  assert.deepEqual(px(regions, 64, 0, 63), [255, 0, 0]);
  // Icons: the gold mine white, the start location in its player's colour; the footman has none.
  const icons = await exportPicture(s, opts({ size: 64, doodads: false, units: false }));
  assert.deepEqual(px(icons, 64, 48, 16), [255, 255, 255]);
  assert.deepEqual(px(icons, 64, 48, 48), [255, 3, 3]);
  assert.deepEqual(px(icons, 64, 16, 16), [90, 180, 90]);
  assert.deepEqual(s.asked, ["pathing", "regions", "icons"]);
});

test("smoothing softens the edges", async () => {
  const s = source();
  const sharp = await exportPicture(s, opts({ size: 64 })), soft = await exportPicture(s, opts({ size: 64, smooth: true }));
  // The doodad's dot (radius 4.8 pixels here) at its edge: sharp, its colour or the ground's; smoothed, a mix.
  const edge = [...Array(10).keys()].map((d) => px(sharp, 64, 32 + d, 32));
  const last = edge.map((c) => c[0] === 250).lastIndexOf(true);
  assert.ok(last > 0 && last < 9, String(last));
  assert.deepEqual(px(sharp, 64, 33 + last, 32), [90, 180, 90]);
  const mixed = px(soft, 64, 32 + last, 32);
  assert.ok(mixed[0] > 90 && mixed[0] < 250 && mixed[1] > 0 && mixed[1] < 180, String(mixed));
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
  assert.deepEqual(png.at(0, 0), [90, 180, 90]);
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
