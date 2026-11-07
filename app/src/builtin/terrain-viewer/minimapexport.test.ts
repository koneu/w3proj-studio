import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";
import { test } from "node:test";
import type { W3Api } from "../../extensions/api";
import { encodeBlp1Jpeg } from "../../lib/image/encode";
import { decodeImage } from "../../lib/image/index";
import { exportMinimap, minimapPng } from "./minimapexport";

/** A smooth 64×64 picture: JPEG keeps it close. */
const picture = () => Uint8Array.from({ length: 64 * 64 * 4 }, (_, i) => (i % 4 === 3 ? 255 : [40, 90, 160][i % 4] + (i >> 8)));
const blp = () => encodeBlp1Jpeg(64, 64, picture(), 95);

function pixels(png: Uint8Array) {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const width = view.getUint32(16), height = view.getUint32(20);
  const idat = Buffer.from(png.subarray(41, png.length - 12));
  const raw = inflateSync(idat);
  return { width, height, row: (y: number) => raw.subarray(y * (1 + width * 4) + 1, (y + 1) * (1 + width * 4)) };
}

test("the PNG has the minimap's pixels, as the BLP decodes", async () => {
  const bytes = blp();
  const { png, width, height } = await minimapPng(bytes);
  assert.deepEqual([width, height], [64, 64]);
  const back = pixels(png), want = decodeImage(bytes).mip(0).rgba;
  assert.deepEqual([back.width, back.height], [64, 64]);
  for (const y of [0, 17, 63]) assert.deepEqual([...back.row(y)], [...want.subarray(y * 256, (y + 1) * 256)], `row ${y}`);
  // The picture is not blank: the test could tell.
  assert.ok(back.row(0)[0] > 30 && back.row(63)[0] > back.row(0)[0] - 1);
});

function fake(opts: { blp?: Uint8Array | null; pick?: string | null } = {}) {
  const written: { path: string; bytes: Uint8Array }[] = [];
  const picked: unknown[] = [];
  const w3 = {
    workspace: {
      project: () => ({ name: "My Map", root: "C:\\p" }),
      readBytes: async () => { if (!opts.blp) throw new Error("gone"); return opts.blp; },
    },
    window: { pickSaveFile: async (o: unknown) => { picked.push(o); return opts.pick === undefined ? "C:\\out\\mini" : opts.pick; }, showInfo: async () => undefined },
    backend: { writeBytes: async (path: string, bytes: Uint8Array) => { written.push({ path, bytes }); } },
  } as unknown as W3Api;
  return { w3, written, picked };
}

test("Export Minimap writes a PNG to the chosen file, adding .png", async () => {
  const { w3, written, picked } = fake({ blp: blp() });
  assert.equal(await exportMinimap(w3), "C:\\out\\mini.png");
  assert.equal(written.length, 1);
  assert.equal(written[0].path, "C:\\out\\mini.png");
  assert.deepEqual([...written[0].bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal((picked[0] as { defaultPath: string }).defaultPath, "My Map minimap.png");
});

test("a chosen .PNG name stays; cancelling writes nothing; no minimap says so", async () => {
  const a = fake({ blp: blp(), pick: "D:\\x\\Mini.PNG" });
  assert.equal(await exportMinimap(a.w3), "D:\\x\\Mini.PNG");
  const b = fake({ blp: blp(), pick: null });
  assert.equal(await exportMinimap(b.w3), null);
  assert.equal(b.written.length, 0);
  const c = fake({ blp: null });
  await assert.rejects(exportMinimap(c.w3), /no minimap/);
  assert.equal(c.picked.length, 0);
});
