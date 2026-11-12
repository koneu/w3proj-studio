import assert from "node:assert/strict";
import { test } from "node:test";
import { doodadStays, newCliffVariation, resizedCameraZoom, resizeProblem, resizeSpecials, resizeTerrain, unitHalf, unitStays } from "./resize";
import { markMapEdge, parseW3e, writeW3e, type Corner, type Terrain } from "./w3e";

/** The header fields of a w3e, for terrains that get written. */
const base = { version: 12, tileset: "L", customTilesets: false, customTilesetsRaw: 0, groundTiles: ["Ldrt", "Lgrs", "Lgrd"], cliffTiles: ["CLdi"], trailer: new Uint8Array() };

function terrain(w: number, h: number): Terrain {
  const corner = (i: number): Corner => ({ height: i, water: 0, texture: i % 3, variation: 5, cliffVariation: 0, cliffTexture: 15, layer: 2, ramp: true, blight: true, hasWater: false, boundary: false, rawHeight: 0, rawWater: 0, texExtra: 0 });
  return { width: w, height: h, offsetX: -64, offsetY: -64, corners: Array.from({ length: w * h }, (_, i) => corner(i)) } as unknown as Terrain;
}

test("corners that stay are untouched; new ones copy the nearest edge corner, with variations of their own", () => {
  const t = terrain(3, 2);
  t.corners.forEach((c, i) => Object.assign(c, { texture: 2 + i, layer: 4, rawHeight: 0x2100 + i, rawWater: 0x2400, hasWater: true, boundary: true, cliffTexture: 1, ramp: false, blight: false }));
  t.corners[2].rawWater = 0x60cb; // the map edge bit comes along; markMapEdge sets it anew afterwards
  const r = resizeTerrain(t, [0, 2, 0, 0], () => 0.99); // randomVariation: 17, never the 5 of the old corners
  assert.equal(r.width, 5);
  assert.equal(r.corners.length, 10);
  assert.deepEqual(r.corners[1], t.corners[1]);
  // we-drive 2026-11-12, Last Refuge grown by 32 left and bottom: all 7232 new corners equal their edge corner (height,
  // water, flags, tile, cliff tile, layer) but for the variations.
  for (const [x, y, from] of [[3, 0, 2], [4, 0, 2], [3, 1, 5], [4, 1, 5]]) {
    const added = r.corners[y * 5 + x];
    assert.deepEqual({ ...added, variation: 0, cliffVariation: 0 }, { ...t.corners[from], variation: 0, cliffVariation: 0 }, `corner ${x},${y}`);
    assert.equal(added.variation, 17);
    assert.equal(added.cliffVariation, 2);
    assert.notEqual(added, t.corners[from], "a copy, not the same object");
  }
  const back = parseW3e(writeW3e({ ...base, ...r }));
  // The test terrain's decoded height and water aren't its words' (terrain()); the words are what is stored.
  assert.deepEqual({ ...back.corners[3], height: 0, water: 0 }, { ...r.corners[3], height: 0, water: 0 }, "it reads back as made");
});

test("growing on the left and bottom copies the left column, the bottom row and the corner", () => {
  const t = terrain(3, 3);
  const r = resizeTerrain(t, [2, 0, 1, 0], () => 0);
  const at = (x: number, y: number) => r.corners[y * r.width + x];
  const same = (a: Corner, b: Corner) => assert.deepEqual({ ...a, variation: 0, cliffVariation: 0 }, { ...b, variation: 0, cliffVariation: 0 });
  same(at(0, 0), t.corners[0]); // the old bottom left corner fills the new bottom left block
  same(at(1, 0), t.corners[0]);
  same(at(0, 3), t.corners[6]); // left of the old top row
  same(at(3, 0), t.corners[1]); // below the old bottom row
  same(at(4, 0), t.corners[2]);
});

test("a cut on one side and growth on another copy the edge that is left", () => {
  const t = terrain(5, 3);
  const r = resizeTerrain(t, [-2, 0, 1, 0], () => 0);
  assert.equal(r.width, 3);
  // New bottom row: below the old corners 2, 3, 4 (those that stay).
  assert.deepEqual([0, 1, 2].map((x) => r.corners[x].height), [2, 3, 4]);
});

test("the whole map's size goes in steps of 4 tiles, as the World Editor's, from 32 to 480", () => {
  const t = terrain(97, 97); // 96 × 96 tiles, as Last Refuge
  const none: Sides = [0, 0, 0, 0], border: Sides = [6, 6, 4, 8];
  assert.equal(resizeProblem(t, [4, 0, 0, 0], border), null, "100 × 96, a click in the World Editor");
  assert.equal(resizeProblem(t, [-4, 0, -4, 0], border), null, "92 × 92 (the World Editor saved it)");
  assert.equal(resizeProblem(t, [32, 0, 32, 0], border), null);
  assert.match(resizeProblem(t, [2, 0, 0, 0], border) ?? "", /width must be a multiple of 4/);
  assert.match(resizeProblem(t, [0, 0, 0, -1], border) ?? "", /height must be a multiple of 4/);
  assert.match(resizeProblem(t, [-68, 0, 0, 0], none) ?? "", /width must be 32–480 tiles \(28\)/);
  assert.match(resizeProblem(t, [388, 0, 0, 0], none) ?? "", /484/);
  assert.equal(resizeProblem(t, [384, 0, 0, 0], none), null, "480 is the largest");
  assert.equal(resizeProblem(t, [-64, 0, 0, 0], none), null, "32 the smallest");
});

test("doodads stay only strictly inside the new map, as the World Editor keeps them", () => {
  // Last Refuge cut by 32 left and bottom: the new map runs from -2048 to 6144. The World Editor removed the doodads
  // at x = -2048 and at y = -2048 and kept those 4.7 and 8.5 inside (we-drive, 2026-11-12).
  const rect = { left: -2048, bottom: -2048, right: 6144, top: 6144 };
  assert.equal(doodadStays(-2048, 192, rect), false);
  assert.equal(doodadStays(-768, -2048, rect), false);
  assert.equal(doodadStays(-2039.5, 2106.7, rect), true);
  assert.equal(doodadStays(-1610.9, -2043.3, rect), true);
  assert.equal(doodadStays(6144, 0, rect), false);
  assert.equal(doodadStays(0, 6144, rect), false);
  assert.equal(doodadStays(-3000, 0, rect), false, "past the map");
  // Past the playable area but on the map: the backdrop stays.
  assert.equal(doodadStays(-1900, -1900, rect), true);
});

test("units and items stay with their footprint inside the playable area, as the World Editor keeps them", () => {
  // Last Refuge cut by 4 left and bottom: playable area -4864..5376 by -5120..5120 (we-drive, 2026-11-12).
  const playable = { left: -4864, bottom: -5120, right: 5376, top: 5120 };
  const none: [number, number] = [0, 0], mine: [number, number] = [256, 256], camp: [number, number] = [192, 192];
  assert.equal(unitStays(-4672, 1856, mine, playable), false, "a gold mine 192 inside: its footprint reaches past");
  assert.equal(unitStays(-4608, -4288, mine, playable), true, "one 256 inside stays");
  assert.equal(unitStays(-256, -5120, camp, playable), false, "a mercenary camp on the edge");
  assert.equal(unitStays(-4793.1, 0, none, playable), true, "a creep 70.9 inside");
  assert.equal(unitStays(-4900, 0, none, playable), false, "a creep past the playable area");
  assert.equal(unitStays(5376, 5120, none, playable), true, "on the edge itself: the centre counts");
  assert.equal(unitStays(5377, 0, none, playable), false);
});

test("units stay with their collision size inside the playable area, as the World Editor's cuts of Last Refuge kept them", () => {
  // The World Editor's saves (we-drive 2026-11-12; collision from UnitBalance.slk): units it removed and kept nearest
  // the new playable area's edges. Cut by 4 left and bottom: playable -4864..5376 by -5120..5120.
  const small = { left: -4864, bottom: -5120, right: 5376, top: 5120 };
  assert.equal(unitStays(-1802.7, -5049.1, unitHalf(null, 32), small), true, "a creep (nftt, collision 32) 70.9 inside");
  assert.equal(unitStays(-435.2, -5029.6, unitHalf(null, 31), small), true, "nfsh, collision 31, 90.4 inside");
  assert.equal(unitStays(-4672, 1856, unitHalf([16, 16], 50), small), false, "a gold mine 192 inside: its footprint reaches past");
  // Its camera bounds were -4352..4864 by -4864..4864: units past them but inside the playable area stayed.
  assert.equal(unitStays(-4640, 3936, unitHalf(null, 32), small), true, "nmh1 288 past the camera bounds");
  // Cut by 32 right and top: playable -5376..1280 by -5632..1024, camera bounds right and top 768.
  const shrunk = { left: -5376, bottom: -5632, right: 1280, top: 1024 };
  assert.equal(unitStays(1258.013, -1071.863, unitHalf(null, 32), shrunk), false, "a gnoll warden (collision 32) 22 inside the right edge");
  assert.equal(unitStays(1258.013, -1071.863, unitHalf(null, null), shrunk), true, "control: its centre alone is inside");
  assert.equal(unitStays(592.1, -3408.5, unitHalf(null, 32), shrunk), true, "nshe, the easternmost unit kept");
  assert.equal(unitStays(-1720, 615.9, unitHalf(null, 32), shrunk), true, "ngnv, the northernmost unit kept");
  // Cut by 64 left: playable 2816..5376; necr (collision 16) 95.2 inside stayed.
  assert.equal(unitStays(2911.2, 269, unitHalf(null, 16), { left: 2816, bottom: -5632, right: 5376, top: 5120 }), true);
});

test("what a unit type takes up: a building its footprint, another unit its collision, an item nothing", () => {
  assert.deepEqual(unitHalf([16, 12], 50), [256, 192]);
  assert.deepEqual(unitHalf(null, 32), [32, 32]);
  assert.deepEqual(unitHalf(undefined, undefined), [0, 0]);
  assert.deepEqual(unitHalf(null, Number.NaN), [0, 0]);
  assert.deepEqual(unitHalf(null, -5), [0, 0]);
});

test("Map Size growth on the left and bottom, playable area grown: edge bits as the World Editor sets them", () => {
  // cliff.w3m (64x64 tiles, borders 6 6 4 8) grown by 8 tiles left and bottom with Modify Camera Bounds on: 72x72,
  // borders 6 6 4 8 again, 60x60 playable (we-drive, 2026-11-11).
  const t: Terrain = { ...base, width: 65, height: 65, offsetX: -4096, offsetY: -4096, corners: terrain(65, 65).corners };
  markMapEdge(t, [6, 6, 4, 8]);
  const r = resizeTerrain(t, [8, 0, 8, 0]);
  markMapEdge(r, [6, 6, 4, 8]);
  assert.deepEqual([r.width, r.height, r.offsetX, r.offsetY], [73, 73, -5120, -5120]);
  const edge = (x: number, y: number) => (r.corners[y * 73 + x].rawWater & 0x4000) !== 0;
  for (let y = 0; y < 73; y++) for (let x = 0; x < 73; x++) {
    const want = x < 72 && y < 72 && (y <= 3 || y >= 64 || x <= 5 || x >= 66);
    if (edge(x, y) !== want) assert.fail(`corner ${x},${y}: edge ${edge(x, y)}`);
  }
  // Old corners that were edge and are inside now lose the bit: the WE's 544 (old rows 0-3 and cols 0-5, within the
  // new playable area).
  let lost = 0;
  for (let y = 0; y < 65; y++) for (let x = 0; x < 65; x++) if ((t.corners[y * 65 + x].rawWater & 0x4000) && !edge(x + 8, y + 8)) lost++;
  assert.equal(lost, 544);
});

test("new corners get a cliff variation of 0, 1 or 2 at random, as the World Editor gives them; old ones keep theirs", () => {
  const t = terrain(3, 3);
  t.corners[4].cliffVariation = 5;
  let n = 0;
  const random = () => [0.1, 0.5, 0.9][n++ % 3];
  const r = resizeTerrain(t, [0, 30, 0, 30], random);
  const added = r.corners.filter((_, i) => i % r.width >= 3 || Math.floor(i / r.width) >= 3);
  const counts = [0, 1, 2].map((v) => added.filter((c) => c.cliffVariation === v).length);
  assert.ok(counts.every((c) => c > added.length / 6), `each of 0, 1 and 2 is given: ${counts}`);
  assert.equal(counts.reduce((a, b) => a + b, 0), added.length, "nothing else");
  assert.equal(r.corners[1 * r.width + 1].cliffVariation, 5, "a corner that stays keeps its cliff variation");
});

test("newCliffVariation covers 0 to 2 and nothing past", () => {
  assert.equal(newCliffVariation(() => 0), 0);
  assert.equal(newCliffVariation(() => 0.5), 1);
  assert.equal(newCliffVariation(() => 0.999999), 2);
});

test("Map Size gives a map without a camera zoom the World Editor's 1250; one set keeps its own", () => {
  assert.deepEqual(resizedCameraZoom({ default: 0, max: 0, min: 0 }), { default: 1250, max: 1250, min: 1250 });
  assert.deepEqual(resizedCameraZoom({ default: 0, max: 0 }), { default: 1250, max: 1250 }, "a file without the minimum gets none");
  assert.equal(resizedCameraZoom({ default: 1650, max: 3000, min: 0 }), null);
  assert.equal(resizedCameraZoom({ default: 0, max: 0, min: 400 }), null);
  assert.equal(resizedCameraZoom(undefined), null, "an older w3i has no camera zoom");
});

test("adding on the left and bottom moves the offset, not the world position", () => {
  const r = resizeTerrain(terrain(3, 3), [1, 0, 1, 0]);
  assert.equal(r.offsetX, -64 - 128);
  assert.equal(r.offsetY, -64 - 128);
  assert.deepEqual(r.corners[r.width + 1], terrain(3, 3).corners[0]);
});

import { overridesForSize, applyPathingOverrides, applyResizePathing, pathingOverridesText, planPathingOverrides, resizePathingOverrides, type PathingOverrides, type Sides } from "./resize";

// A 64×64-tile map is 256×256 pathing cells.
const file = (t: Terrain, cells: PathingOverrides["cells"]): PathingOverrides => ({ format: "w3proj.pathing/1", width: (t.width - 1) * 4, height: (t.height - 1) * 4, cells });
const big = () => terrain(65, 65);

test("pathing overrides: growing left/bottom shifts them, growing right/top leaves them", () => {
  const t = big(), f = file(t, [[0, 0, 1, 0], [10, 20, 2, 4]]);
  const l = resizePathingOverrides(f, t, [32, 0, 0, 0]);
  assert.equal(l.width, 384);
  assert.deepEqual(l.cells, [[128, 0, 1, 0], [138, 20, 2, 4]]);
  const b = resizePathingOverrides(f, t, [0, 0, 32, 0]);
  assert.equal(b.height, 384);
  assert.deepEqual(b.cells, [[0, 128, 1, 0], [10, 148, 2, 4]]);
  const rt = resizePathingOverrides(f, t, [0, 32, 0, 32]);
  assert.deepEqual([rt.width, rt.height], [384, 384]);
  assert.deepEqual(rt.cells, f.cells);
});

test("pathing overrides: shrinking each side keeps the same ground cell and drops removed cells", () => {
  const t = big(); // 256 cells a side; 32 tiles are 128 cells
  const A: [number, number, number, number] = [2, 100, 1, 0], B: [number, number, number, number] = [253, 100, 1, 0];
  const C: [number, number, number, number] = [100, 2, 1, 0], D: [number, number, number, number] = [100, 253, 1, 0], E: [number, number, number, number] = [100, 100, 8, 0];
  const f = file(t, [A, B, C, D, E]);
  const text = (r: PathingOverrides) => r.cells.map((c) => c.join(" "));
  const left = resizePathingOverrides(f, t, [-32, 0, 0, 0]);
  assert.equal(left.width, 128);
  assert.deepEqual(text(left), ["125 100 1 0"]);
  const right = resizePathingOverrides(f, t, [0, -32, 0, 0]);
  assert.equal(right.width, 128);
  assert.deepEqual(text(right), ["100 2 1 0", "2 100 1 0", "100 100 8 0", "100 253 1 0"]);
  const bottom = resizePathingOverrides(f, t, [0, 0, -32, 0]);
  assert.equal(bottom.height, 128);
  assert.deepEqual(text(bottom), ["100 125 1 0"]);
  const top = resizePathingOverrides(f, t, [0, 0, 0, -32]);
  assert.equal(top.height, 128);
  assert.deepEqual(text(top), ["100 2 1 0", "2 100 1 0", "100 100 8 0", "253 100 1 0"]);
});

test("pathing overrides: a shrink and a grow together move them by the net offset", () => {
  const t = big(), f = file(t, [[200, 50, 1, 0], [10, 50, 1, 0]]);
  const r = resizePathingOverrides(f, t, [-32, 64, 0, 0]);
  assert.deepEqual([r.width, r.height], [384, 256]);
  assert.deepEqual(r.cells, [[72, 50, 1, 0]]);
});

test("pathing overrides: growing and shrinking back brings them back", () => {
  const t = big(), f = file(t, [[3, 4, 1, 0], [250, 255, 2, 1]]);
  const grown = resizePathingOverrides(f, t, [32, 32, 32, 32]);
  const t2 = terrain(129, 129);
  const back = resizePathingOverrides(grown, t2, [-32, -32, -32, -32]);
  assert.deepEqual(back, f);
});

test("pathing overrides: a file for another size is left alone", () => {
  const t = big(), f = { ...file(t, [[1, 1, 1, 0]]), width: 100 };
  assert.deepEqual(resizePathingOverrides(f, t, [32, 0, 0, 0]), f);
});

test("pathing overrides: malformed cells leave the file untouched instead of throwing", () => {
  const t = big();
  for (const cells of [[null], [5], [[1, 2, 3]], [[1, 2, "a", 0]], "x"]) {
    const f = { format: "w3proj.pathing/1", width: 256, height: 256, cells } as unknown as PathingOverrides;
    assert.equal(resizePathingOverrides(f, t, [32, 0, 0, 0]), f);
    assert.equal(applyPathingOverrides(new Uint8Array(16 + 256 * 256), f, t), false);
  }
});

test("pathing overrides: the text parses back, even with a format that needs escaping", () => {
  const f = { format: 'a"b\c', width: 4, height: 4, cells: [[1, 2, 3, 4]] } as PathingOverrides;
  assert.deepEqual(JSON.parse(pathingOverridesText(f)), f);
  assert.deepEqual(JSON.parse(pathingOverridesText({ ...f, cells: [] })).cells, []);
});

test("pathing overrides: the cell under a fixed world point follows the real offset", () => {
  const changes: Sides[] = [[32, 0, 0, 0], [0, 0, 32, 0], [-32, 0, 0, 0], [0, 0, -32, 0], [32, -32, 0, 0], [-32, 64, 32, -32]];
  for (const change of changes) {
    const t = big(), after = resizeTerrain(t, change);
    // World point of the middle of old cell (cx, cy); it must stay in the cell the file moved it to.
    const [cx, cy] = [150, 140];
    const wx = t.offsetX + cx * 32 + 16, wy = t.offsetY + cy * 32 + 16;
    const nx = Math.floor((wx - after.offsetX) / 32), ny = Math.floor((wy - after.offsetY) / 32);
    const r = resizePathingOverrides(file(t, [[cx, cy, 1, 0]]), t, change);
    const inside = nx >= 0 && ny >= 0 && nx < (after.width - 1) * 4 && ny < (after.height - 1) * 4;
    assert.deepEqual(r.cells, inside ? [[nx, ny, 1, 0]] : [], change.join());
  }
});

test("applying moved overrides to the new wpm: only the new terrain's size matches", () => {
  const t = big(), change: Sides = [32, 0, 0, 0], next = resizeTerrain(t, change);
  const moved = resizePathingOverrides(file(t, [[3, 4, 8, 0]]), t, change);
  const wpm = new Uint8Array(16 + 384 * 256);
  assert.equal(applyPathingOverrides(wpm, moved, t), false, "the old terrain doesn't match the moved file");
  assert.ok(wpm.every((b) => b === 0));
  assert.equal(applyPathingOverrides(wpm, moved, next), true);
  assert.equal(wpm[16 + 4 * 384 + 131], 8);
  assert.equal(wpm.reduce((n, b) => n + (b ? 1 : 0), 0), 1);
});

test("pathing plan: a file whose size equals the NEW size is applied to the wpm (the editor adopts it) but not rewritten", () => {
  const t = big(), change: Sides = [32, 0, 0, 0], next = resizeTerrain(t, change);
  const adopted = file(next, [[3, 4, 8, 0]]);
  const wpm = new Uint8Array(16 + 384 * 256);
  const plan = planPathingOverrides(adopted, t, change);
  assert.equal(plan?.write, false);
  assert.equal(applyResizePathing(wpm, plan, next, change), null);
  assert.equal(wpm[16 + 4 * 384 + 3], 8, "the same cell the editor will show");
  // another size, or a malformed file with the new size, is neither applied nor rewritten
  assert.equal(planPathingOverrides({ ...adopted, width: 999 }, t, change), null);
  assert.equal(planPathingOverrides({ ...adopted, cells: [[1, 2, 3]] }, t, change), null);
});

test("overridesForSize: the shared validity test", () => {
  const t = big(), f = file(t, [[1, 1, 1, 0]]);
  assert.equal(overridesForSize(f, 256, 256), f);
  assert.equal(overridesForSize(f, 256, 128), null);
  assert.equal(overridesForSize({ ...f, cells: "x" }, 256, 256), null);
});

test("pathing plan: a camera-bounds-only change keeps the file; a move or a dropped cell rewrites it", () => {
  const t = big();
  const same = planPathingOverrides(file(t, [[3, 4, 8, 0], [9, 9, 1, 2]]), t, [0, 0, 0, 0]);
  assert.ok(same && !same.write);
  assert.deepEqual(same.file.cells, [[3, 4, 8, 0], [9, 9, 1, 2]]);
  assert.equal(planPathingOverrides(file(t, [[3, 4, 8, 0]]), t, [32, 0, 0, 0])?.write, true);
  assert.equal(planPathingOverrides(file(t, [[255, 4, 8, 0]]), t, [0, -32, 0, 0])?.write, true);
  assert.equal(planPathingOverrides(file(t, []), t, [32, 0, 0, 0])?.write, true, "the size changed");
  // Hand-written order is kept when nothing changes.
  const unsorted = planPathingOverrides(file(t, [[9, 9, 1, 0], [3, 4, 8, 0]]), t, [0, 0, 0, 0]);
  assert.ok(unsorted && !unsorted.write);
});

test("pathing plan: a malformed file is left alone", () => {
  const t = big();
  for (const bad of [null, "x", 5, {}, { width: 256, height: 256 }, { width: 256, height: 256, cells: [[1, 2, 3]] }, { width: 256, height: 256, cells: [[1, 2, 3, "4"]] }, { width: 1.5, height: 256, cells: [] }])
    assert.equal(planPathingOverrides(bad, t, [32, 0, 0, 0]), null, JSON.stringify(bad));
});

test("pathing plan: a shift with growth on one side and shrink on another moves cells and rewrites", () => {
  const t = big();
  const plan = planPathingOverrides(file(t, [[10, 20, 8, 0]]), t, [32, -32, 0, 0]);
  assert.equal(plan?.write, true);
  assert.equal(plan?.file.width, 256, "32 tiles added left, 32 removed right");
  assert.deepEqual(plan?.file.cells, [[138, 20, 8, 0]]);
});

test("pathing plan: a real shift of a hand-ordered file rewrites it sorted; duplicates survive a no-op", () => {
  const t = big();
  const shifted = planPathingOverrides(file(t, [[9, 9, 1, 0], [3, 4, 8, 0]]), t, [32, 0, 0, 0]);
  assert.equal(shifted?.write, true);
  assert.deepEqual(shifted?.file.cells, [[131, 4, 8, 0], [137, 9, 1, 0]]);
  const dup = planPathingOverrides(file(t, [[3, 4, 8, 0], [3, 4, 8, 0]]), t, [0, 0, 0, 0]);
  assert.ok(dup && !dup.write);
  assert.equal(dup.file.cells.length, 2);
});

test("pathing file: fields other than format, width, height and cells are kept on rewrite", () => {
  const t = big();
  const extra = { note: "hand written", tool: { name: "x", list: [1, "two", { three: 3 }] }, flag: false };
  const f = { ...file(t, [[1, 1, 1, 0]]), ...extra } as PathingOverrides;
  // A resize that moves the cells, and a camera-bounds-only change that drops a hand-written cell outside the map,
  // both rewrite it.
  for (const change of [[32, 0, 0, 0], [0, 0, 0, 0]] as Sides[]) {
    const stray = change[0] === 0;
    const plan = planPathingOverrides(stray ? { ...f, cells: [...f.cells, [300, 4, 8, 0]] } : f, t, change);
    assert.ok(plan?.write);
    const next = resizeTerrain(t, change);
    const text = applyResizePathing(new Uint8Array(16 + (next.width - 1) * 4 * (next.height - 1) * 4), plan, next, change)!;
    const back = JSON.parse(text);
    for (const [k, v] of Object.entries(extra)) assert.deepEqual(back[k], v, `${k} after ${change.join()}`);
    // Control: the overrides themselves were rewritten.
    assert.deepEqual(back.cells, stray ? [[1, 1, 1, 0]] : [[129, 1, 1, 0]]);
  }
});

test("pathing file: the text keeps the fields of its own that the Pathing Editor's save passes along", () => {
  const read = { format: "w3proj.pathing/1", width: 8, height: 8, cells: [[1, 1, 1, 0]], note: "keep me", nested: { a: [1, 2] } };
  const saved = JSON.parse(pathingOverridesText({ ...read, cells: [[2, 3, 4, 0]] } as PathingOverrides));
  assert.deepEqual(saved, { format: "w3proj.pathing/1", width: 8, height: 8, cells: [[2, 3, 4, 0]], note: "keep me", nested: { a: [1, 2] } });
  // Control: without fields of its own, just the overrides, as before.
  assert.deepEqual(JSON.parse(pathingOverridesText({ format: "f", width: 4, height: 4, cells: [] })), { format: "f", width: 4, height: 4, cells: [] });
});

test("applyResizePathing: what resizeMap applies and writes", () => {
  const t = big(), change: Sides = [32, 0, 0, 0], next = resizeTerrain(t, change);
  const wpm = () => new Uint8Array(16 + 384 * 256);
  // stale (another size) / malformed: nothing applied, nothing written
  let w = wpm();
  assert.equal(applyResizePathing(w, planPathingOverrides({ ...file(next, [[3, 4, 8, 0]]), width: 999 }, t, change), next, change), null);
  assert.ok(w.every((b) => b === 0));
  // real move: applied and written
  w = wpm();
  const text = applyResizePathing(w, planPathingOverrides(file(t, [[3, 4, 8, 0]]), t, change), next, change);
  assert.deepEqual(JSON.parse(text!).cells, [[131, 4, 8, 0]]);
  assert.equal(w[16 + 4 * 384 + 131], 8);
  // same-size: file untouched, not applied here (filterPathing path)
  w = wpm();
  assert.equal(applyResizePathing(w, planPathingOverrides(file(t, [[3, 4, 8, 0]]), t, [0, 0, 0, 0]), t, [0, 0, 0, 0]), null);
  assert.ok(w.every((b) => b === 0));
});

test("special doodads stay on their ground: their tiles shift by the left and bottom change, those cut off go", () => {
  const t = terrain(33, 33); // 32 × 32 tiles
  const list = [{ id: "YCx7", z: 0, x: 13, y: 24 }, { id: "LCc0", z: 0, x: 0, y: 31 }, { id: "LCc2", z: 0, x: 31, y: 0 }];
  // Grown by 32 on the left and bottom: everything 32 tiles further in, nothing lost.
  assert.deepEqual(resizeSpecials(list, t, [32, 0, 32, 0]), { kept: [{ id: "YCx7", z: 0, x: 45, y: 56 }, { id: "LCc0", z: 0, x: 32, y: 63 }, { id: "LCc2", z: 0, x: 63, y: 32 }], removed: 0 });
  // Grown on the right and top: tiles stay.
  assert.deepEqual(resizeSpecials(list, t, [0, 32, 0, 32]).kept, list);
  // Cut by 1 on the left and the top: the one on column 0, row 31 goes; the left cut moves the rest one tile left.
  const cut = resizeSpecials(list, t, [-1, 0, 0, -1]);
  assert.deepEqual(cut, { kept: [{ id: "YCx7", z: 0, x: 12, y: 24 }, { id: "LCc2", z: 0, x: 30, y: 0 }], removed: 1 });
  assert.deepEqual(list[0], { id: "YCx7", z: 0, x: 13, y: 24 }, "the list given isn't changed");
});
