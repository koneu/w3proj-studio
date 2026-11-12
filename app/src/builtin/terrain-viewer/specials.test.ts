import assert from "node:assert/strict";
import { test } from "node:test";
import { modelPath, type Skin } from "./objects";
import { SPECIAL_FACING, specialPlacements } from "./specials";

const skin = (file: string): Skin => ({
  kind: "w3d", file, numVar: 1, texId: -1, texFile: "", modelScale: 1, minScale: 1, maxScale: 1.2, randScale: false, fixedRot: null, uberSplat: "",
});
const skins = new Map([["YCl2", skin("Doodads\\Terrain\\CliffDoodad\\Collapse\\Collapse")]]);
const offset = { x: -1024, y: -512 };

test("a special doodad stands in the middle of its pathing footprint, whose bottom left is its tile's, on the ground", () => {
  const out = specialPlacements([{ id: "YCl2", x: 3, y: 2 }], skins, () => ({ width: 4, height: 8 }), offset, (x, y) => x + y);
  assert.equal(out.length, 1);
  // Tile (3, 2): corner (-1024 + 384, -512 + 256); half the footprint (4 x 8 cells of 32) on.
  assert.deepEqual(out[0].position, [-1024 + 384 + 64, -512 + 256 + 128, -1024 + 384 + 64 - 512 + 256 + 128]);
  assert.equal(out[0].angle, SPECIAL_FACING);
  assert.deepEqual(out[0].scale, [1, 1, 1]);
  assert.equal(modelPath(skins.get(out[0].id)!, out[0].variation), "Doodads\\Terrain\\CliffDoodad\\Collapse\\Collapse.mdx");
});

test("a special doodad without a model is left out, one without a footprint stands in its tile's middle", () => {
  const out = specialPlacements([{ id: "ZZZZ", x: 0, y: 0 }, { id: "YCl2", x: 1, y: 1 }], skins, () => undefined, offset, () => 5);
  assert.deepEqual(out.map((p) => p.id), ["YCl2"]);
  assert.deepEqual(out[0].position, [-1024 + 128 + 64, -512 + 128 + 64, 5]);
});

test("the control: a footprint of another size moves the middle", () => {
  const at = (w: number) => specialPlacements([{ id: "YCl2", x: 0, y: 0 }], skins, () => ({ width: w, height: w }), offset, () => 0)[0].position[0];
  assert.notEqual(at(4), at(8));
});
