import assert from "node:assert/strict";
import { test } from "node:test";
import { resizeTerrain } from "./resize";
import type { Corner, Terrain } from "./w3e";

function terrain(w: number, h: number): Terrain {
  const corner = (i: number): Corner => ({ height: i, water: 0, texture: i % 3, variation: 5, cliffVariation: 0, cliffTexture: 15, layer: 2, ramp: true, blight: true, hasWater: false, boundary: false, rawHeight: 0, rawWater: 0, texExtra: 0 });
  return { width: w, height: h, offsetX: -64, offsetY: -64, corners: Array.from({ length: w * h }, (_, i) => corner(i)) } as unknown as Terrain;
}

test("corners that stay are untouched; new ones continue the edge with a variation of their own", () => {
  const t = terrain(3, 2);
  const random = Math.random;
  Math.random = () => 0.7; // randomVariation: 17, never the 5 of the old corners
  try {
    const r = resizeTerrain(t, [0, 2, 0, 0]);
    assert.equal(r.width, 5);
    assert.equal(r.corners.length, 10);
    assert.deepEqual(r.corners[1], t.corners[1]);
    const added = r.corners[3], edge = t.corners[2];
    assert.equal(added.texture, edge.texture);
    assert.equal(added.height, edge.height);
    assert.equal(added.variation, 17);
    assert.equal(added.ramp, false);
    assert.equal(added.blight, false);
  } finally { Math.random = random; }
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
