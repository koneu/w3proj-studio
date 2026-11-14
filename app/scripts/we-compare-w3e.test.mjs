// we-compare-w3e.mjs: the w3e reader (corner by corner), the height spread, the unit heights, and the spec files of
// tests/we-compare/ that use them parse. Each "differs" case has its "matches" control next to it.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { heightSpread, readW3e, unitHeights, unitIds, variationSpread, w3eView } from "./we-compare-w3e.mjs";
import { compareFile, parseSpecFile } from "./we-compare-core.mjs";

/** A version 11 w3e of `w`x`h` corners: each corner [ground, water, textureAndFlags, variation, cliffAndLayer]. */
function w3e(w, h, corner) {
  const head = Buffer.alloc(13 + 4 + 4 + 4 + 16);
  head.write("W3E!", 0, "latin1");
  head.writeUInt32LE(11, 4);
  head.write("L", 8, "latin1");
  head.writeUInt32LE(0, 9); // no custom tilesets
  head.writeUInt32LE(1, 13); // one ground tile
  head.write("Ldrt", 17, "latin1");
  head.writeUInt32LE(0, 21); // no cliff tiles
  head.writeUInt32LE(w, 25);
  head.writeUInt32LE(h, 29);
  head.writeFloatLE(-128, 33);
  head.writeFloatLE(-64, 37);
  const body = Buffer.alloc(w * h * 7);
  for (let i = 0; i < w * h; i++) {
    const [g, water, tex, variation, cl] = corner(i % w, Math.floor(i / w));
    body.writeInt16LE(g + 0x2000, i * 7);
    body.writeUInt16LE(water, i * 7 + 2);
    body[i * 7 + 4] = tex;
    body[i * 7 + 5] = variation;
    body[i * 7 + 6] = cl;
  }
  return Buffer.concat([head.subarray(0, 41), body]);
}

test("readW3e: every stored value of a corner, the water word and its edge bits apart", () => {
  const file = w3e(2, 2, (x, y) => [x * 10 - y, 0x4000 | (0x2000 + x), 0x45 + y, 0x25, 0xf3]);
  const { header, corners } = readW3e(file, true);
  assert.deepEqual([header.version, header.tileset, header.ground, header.width, header.height, header.offset], [11, "L", ["Ldrt"], 2, 2, [-128, -64]]);
  assert.deepEqual(corners["1,1"], { ground: 9, water: 0x2001, edge: 1, texture: 6, ramp: 0, blight: 0, wet: 1, boundary: 0, variation: 5, cliffVariation: 1, cliffType: 15, layer: 3 });
  assert.equal("variation" in readW3e(file).corners["1,1"], false, "without the flag the random variations are left out");
});

test("readW3e leaves the variations out (the editor draws them at random) and refuses a file that isn't a w3e", () => {
  const at = (variation, ground = 0) => readW3e(w3e(1, 1, () => [ground, 0, 0, variation, 0]));
  assert.deepEqual(at(0x00), at(0xe1), "the variation byte (ground and cliff variation) isn't compared");
  assert.notDeepEqual(at(0x00), at(0x00, 4), "control: the ground height is");
  assert.throws(() => readW3e(Buffer.from("not a w3e at all")), /missing W3E! header/);
  assert.throws(() => readW3e(w3e(2, 2, () => [0, 0, 0, 0, 0]).subarray(0, 50)), /truncated/);
});

test("a corner compared through compareFile: one differing water word is one difference, with its place", () => {
  const mk = (water) => ({ json: w3eView("w3e", w3e(3, 3, (x, y) => [0, x === 2 && y === 1 ? water : 0x2000, 0, 0, 2])) });
  const same = compareFile("war3map.w3e", "w3e", mk(7), mk(7));
  assert.equal(same.status, "MATCH");
  const r = compareFile("war3map.w3e", "w3e", mk(7), mk(9));
  assert.equal(r.status, "DIFFERS");
  assert.equal(r.count, 1);
  assert.match(r.diffs[0].text, /corners\.2,1\.water: WE 7, Studio 9/);
});

test("heightSpread: the set of offsets from the base, so two random runs of one setting match and two settings don't", () => {
  const run = (offsets) => w3e(4, 4, (x, y) => [offsets[(x + 4 * y) % offsets.length], 0, 0, 0, 2]);
  assert.deepEqual(heightSpread(run([-26, 0, 25, 0])), { count: 3, min: -26, max: 25, values: [-26, 0, 25] });
  assert.deepEqual(heightSpread(run([25, -26, 0, 0, 25])), heightSpread(run([-26, 0, 25])), "the order and the counts don't matter");
  assert.notDeepEqual(heightSpread(run([-26, 0, 25])), heightSpread(run([-52, -26, 0, 25])), "control: another setting");
  assert.deepEqual(heightSpread(run([100, 126]), 100), { count: 2, min: 0, max: 26, values: [0, 26] });
});

test("unitHeights keeps id, x, y and z, in file order, and drops the rest of a unit", () => {
  const unit = (id, z, extra = {}) => ({ id, position: [1, 2, z], subversion: 11, itemTable: 5, ...extra });
  const a = unitHeights({ units: [unit("hfoo", 256), unit("hgry", 0)] });
  assert.deepEqual(a, { units: [{ id: "hfoo", x: 1, y: 2, z: 256 }, { id: "hgry", x: 1, y: 2, z: 0 }] });
  assert.deepEqual(unitHeights({ units: [unit("hfoo", 256, { player: 3 }), unit("hgry", 0)] }), a, "other fields are not compared");
  assert.notDeepEqual(unitHeights({ units: [unit("hfoo", 500), unit("hgry", 0)] }), a, "control: the height is");
});

test("unitIds: editor ids unique and in order, and the kinds of object, whatever their number and places", () => {
  const sloc = { id: "sloc", randomType: 0, editorId: 0, position: [0, 0, 0] };
  const group = (editorId, x = 0) => ({ id: "uDNR", randomType: 1, randomGroup: 0, randomPosition: 0, editorId, position: [x, 0, 0] });
  const we = unitIds({ units: [sloc, group(1), group(2), group(3), group(4)] });
  assert.deepEqual(we, { editorIdsUnique: true, editorIdsInOrder: true, kinds: ["sloc", "uDNR group 0 position 0"] });
  assert.deepEqual(unitIds({ units: [sloc, group(1, 64), group(2, 128)] }), we, "the count and the places don't matter");
  const dup = unitIds({ units: [sloc, group(1), group(1), group(2)] });
  assert.equal(dup.editorIdsUnique, false, "control: a number given twice");
  assert.equal(dup.editorIdsInOrder, false);
  assert.equal(unitIds({ units: [sloc, group(2), group(1)] }).editorIdsInOrder, false, "control: out of order");
  assert.deepEqual(unitIds({ units: [sloc, { ...group(1), randomType: 0 }] }).kinds, ["sloc", "uDNR random type 0"], "control: by level isn't a group");
});

test("the spec files in tests/we-compare/ that use these kinds parse", () => {
  // The tests run from a copy of the scripts: the folder is found from where they run (app/ or the repository).
  let dir = process.cwd();
  while (!existsSync(join(dir, "tests", "we-compare"))) {
    if (dirname(dir) === dir) throw new Error("tests/we-compare not found");
    dir = dirname(dir);
  }
  dir = join(dir, "tests", "we-compare");
  const names = ["cliff-adjust-dry.json", "unit-heights.json", "water-brush-slope.json", "height-random-stops.json", "painted-cliff-type.json", "random-group-scatter.json"];
  let parsed = 0;
  for (const f of readdirSync(dir).filter((f) => names.includes(f))) {
    const specs = parseSpecFile(readFileSync(join(dir, f), "utf8"), join(dir, f), { MAIN: "/main", REPO: "/repo" });
    assert.ok(specs.length > 0, f);
    parsed += specs.length;
  }
  assert.ok(parsed >= 6, `${parsed} specs parsed`);
});

test("variationSpread: the ground variations by texture, counted; w3e-variation compares the main values, not the counts", () => {
  const run = (vars) => w3e(vars.length, 1, (x) => [0, 0, 0, vars[x], 0]);
  assert.deepEqual(variationSpread(run([3, 3, 0x25])), { Ldrt: { corners: 3, ground: { 3: 2, 5: 1 }, cliff: { 0: 2, 1: 1 } } });
  assert.deepEqual(w3eView("w3e-variation", run([3, 3, 5])), w3eView("w3e-variation", run([5, 3, 3])), "the order doesn't matter");
  assert.deepEqual(w3eView("w3e-variation", run([3, 5, 5])), { Ldrt: { corners: 3, ground: [3, 5] } }, "the view: corners and the main values");
  const many = (rare) => run([...Array(10).fill(4), ...Array(10).fill(8), rare]);
  assert.deepEqual(w3eView("w3e-variation", many(1)).Ldrt.ground, [4, 8], "a value under 5% of the corners is left out");
  assert.deepEqual(w3eView("w3e-variation", many(1)), w3eView("w3e-variation", many(2)), "so which rare value was drawn doesn't matter");
  assert.notDeepEqual(w3eView("w3e-variation", run([3, 5])), w3eView("w3e-variation", run([3, 6])), "control: another set of values");
});
