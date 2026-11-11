import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { CornerUndo } from "./cliffs";
import { adjustCliffLevels, cliffShiftRange, resetHeightField, TOP_LEVEL } from "./wholemap";
import { parseW3e, setGroundHeight, setWaterLevel, writeW3e, type Corner, type Terrain } from "./w3e";

/** A strip like map 03's: land on level 4, a lake on level 2 with a dipped bed and water, a river dip on the land, a
 *  ramp corner, and one corner with the map edge bit in its water word. */
const make = (): Terrain => ({
  version: 12, tileset: "L", customTilesets: false, customTilesetsRaw: 0, groundTiles: ["Ldrt", "Lgrs"], cliffTiles: ["CLdi", "CLgr"],
  width: 4, height: 2, offsetX: -256, offsetY: -256, trailer: new Uint8Array([1, 2, 3]),
  corners: Array.from({ length: 8 }, (_, i) => {
    const lake = i === 2 || i === 3 || i === 6;
    const c: Corner = {
      height: 0, water: -89.6, texture: i % 2, variation: i, cliffVariation: i % 8, cliffTexture: i % 2,
      layer: lake ? 2 : 4, ramp: i === 5, blight: false, hasWater: lake || i === 1, boundary: false,
      rawHeight: 0x2000, rawWater: i === 7 ? 0x6000 : 0x2000, texExtra: 0,
    };
    setGroundHeight(c, lake ? -110 : i === 1 ? -46 : 0);
    if (lake) setWaterLevel(c, 0x2400);
    if (i === 1) setWaterLevel(c, 0x2546);
    return c;
  }),
});

test("Reset Height Field flattens every corner over its cliff level and leaves the rest", () => {
  const before = make(), t = make(), undo = new CornerUndo();
  const n = resetHeightField(t, undo);
  assert.equal(n, 4, "the lake's three corners and the river's");
  t.corners.forEach((c, i) => {
    assert.equal(c.rawHeight, 0x2000);
    assert.equal(c.height, (c.layer - 2) * 128, "flat over its level");
    const { rawHeight: _r, height: _h, ...rest } = c;
    const { rawHeight: _r2, height: _h2, ...was } = before.corners[i];
    assert.deepEqual(rest, was, `corner ${i}: only the ground height changes`);
  });
  const step = undo.step(t);
  assert.equal(step.corners.length, 4, "only the changed corners are in the step");
  step.undo();
  assert.deepEqual(t.corners, before.corners);
  step.redo();
  assert.equal(t.corners[2].rawHeight, 0x2000);
  assert.equal(resetHeightField(t, new CornerUndo()), 0, "flat already: nothing to do");
});

test("Adjust Cliff Levels moves every corner by the levels and leaves the water where it is, as the World Editor does", () => {
  const before = make(), t = make(), undo = new CornerUndo();
  assert.equal(adjustCliffLevels(t, 1, undo), 8);
  t.corners.forEach((c, i) => {
    const b = before.corners[i];
    assert.equal(c.layer, b.layer + 1);
    assert.equal(c.rawHeight, b.rawHeight, "the ground over its level stays");
    assert.equal(c.height, b.height + 128);
    // we-drive, 4v4_SnowareBay by +1 (2026-11-11): every water word and water flag as it was.
    assert.equal(c.rawWater, b.rawWater, "the stored water level stays, high bits and all");
    assert.equal(c.water, b.water, "the surface stays");
    assert.equal(c.hasWater, b.hasWater);
    assert.equal(c.ramp, b.ramp);
  });
  // What it writes reads back the same.
  const again = parseW3e(writeW3e(t));
  assert.deepEqual(again.corners.map((c) => [c.layer, c.rawWater, c.water]), t.corners.map((c) => [c.layer, c.rawWater, c.water]));
  const step = undo.step(t);
  step.undo();
  assert.deepEqual(t.corners, before.corners, "one step undoes it all");
});

test("Adjust Cliff Levels stops corners at level 0 and cuts a raise at +10 or the top, as the World Editor does", () => {
  // Levels 2 and 4: down to -2 without squeezing, up to +10, the dialog's most (TOP_LEVEL - 4 is as much).
  assert.deepEqual(cliffShiftRange(make()), { min: -2, max: Math.min(10, TOP_LEVEL - 4) });
  // map 03 by -3 (we-drive, 2026-11-09): level 4 went to 1, the lake's 2 to 0.
  let t = make(), before = make(), undo = new CornerUndo();
  assert.equal(adjustCliffLevels(t, -3, undo), 8);
  t.corners.forEach((c, i) => {
    assert.equal(c.layer, Math.max(0, before.corners[i].layer - 3), `corner ${i}`);
    assert.equal(c.rawHeight, before.corners[i].rawHeight);
    assert.equal(c.rawWater, before.corners[i].rawWater);
  });
  undo.step(t).undo();
  assert.deepEqual(t.corners, before.corners, "one step undoes the squeeze");
  // Far down: all at 0. Once there, nothing more changes.
  assert.equal(adjustCliffLevels(t, -20, new CornerUndo()), 8);
  assert.ok(t.corners.every((c) => c.layer === 0));
  undo = new CornerUndo();
  assert.equal(adjustCliffLevels(t, -1, undo), 0, "nothing left to lower");
  assert.equal(undo.step(t).corners.length, 0, "and nothing logged");
  // Up: +12 is +10, as the dialog caps it (map 03, levels 2 and 4: +10 and +12 both gave 12 and 14).
  t = make();
  assert.equal(adjustCliffLevels(t, 12, new CornerUndo()), 8);
  assert.deepEqual([...new Set(t.corners.map((c) => c.layer))].sort((a, b) => a - b), [12, 14]);
  assert.equal(adjustCliffLevels(t, 1, new CornerUndo()), 0, "the top corner is at the top: nothing moves");
  assert.equal(typeof adjustCliffLevels(t, 1.5, new CornerUndo()), "string", "half a level isn't one");
  assert.equal(typeof adjustCliffLevels(t, Number.NaN, new CornerUndo()), "string");
  assert.equal(adjustCliffLevels(t, 0, new CornerUndo()), 0, "nothing to do");
});

/** The w3e of a real map, through the release CLI; null when the map or the CLI isn't there. */
function realW3e(name: string): Uint8Array | null {
  // The test runs bundled elsewhere (scripts/test.mjs), so the checkout is found from where it was started.
  const git = (arg: string) => { const r = spawnSync("git", ["rev-parse", arg], { encoding: "utf8" }); return r.status === 0 ? r.stdout.trim() : null; };
  const repo = git("--show-toplevel"), common = git("--git-common-dir");
  if (!repo) return null;
  const main = common ? dirname(resolve(common)) : repo;
  const exe = `w3proj${process.platform === "win32" ? ".exe" : ""}`;
  const bin = [process.env.W3PROJ_BIN, join(repo, "target", "release", exe), join(main, "target", "release", exe)].find((p) => p && existsSync(p));
  const map = join(process.env.W3PROJ_CORPUS ?? join(main, "smoketest_maps"), name);
  if (!bin || !existsSync(map)) return null;
  const r = spawnSync(bin, ["cat", map, "war3map.w3e"], { maxBuffer: 1 << 26 });
  return r.status === 0 ? new Uint8Array(r.stdout) : null;
}

test("Adjust Cliff Levels on real maps: +1 changes only each corner's layer nibble, -1 then gives the file back", (ctx) => {
  const maps = ["cliff.w3m", "4v4_SnowareBay_w3c_260125_1357_5658.w3x", "6_w3c_251104_0950_TwistedMeadows_v1.9.w3x"];
  let tried = 0;
  for (const name of maps) {
    const original = realW3e(name);
    if (!original) continue;
    tried++;
    const t = parseW3e(original);
    const per = t.version === 12 ? 8 : 7, head = original.length - t.trailer.length - t.corners.length * per;
    assert.ok(cliffShiftRange(t).max >= 1, `${name} has room to go up`);
    assert.equal(adjustCliffLevels(t, 1, new CornerUndo()), t.corners.length, name);
    const up = writeW3e(t);
    assert.equal(up.length, original.length, name);
    for (let p = 0; p < original.length; p++) {
      const k = p - head;
      const layerByte = k >= 0 && p < head + t.corners.length * per && k % per === per - 1;
      if (!layerByte) { if (up[p] !== original[p]) assert.fail(`${name}: byte ${p} changed (${original[p]} to ${up[p]})`); continue; }
      if ((up[p] & 0xf0) !== (original[p] & 0xf0) || (up[p] & 0xf) !== (original[p] & 0xf) + 1) assert.fail(`${name}: corner ${k / per | 0}'s byte ${original[p]} became ${up[p]}`);
    }
    const back = parseW3e(up);
    assert.equal(adjustCliffLevels(back, -1, new CornerUndo()), back.corners.length);
    assert.deepEqual(writeW3e(back), original, `${name}: -1 after +1 gives the original file`);
  }
  if (!tried) ctx.skip("no real map or release CLI (smoketest_maps, target/release/w3proj)");
});

test("the water words don't limit the shift, as they don't move", () => {
  const t = make();
  setWaterLevel(t.corners[2], 0x3fff - 300);
  assert.equal(cliffShiftRange(t).max, TOP_LEVEL - 4);
  assert.equal(adjustCliffLevels(t, 1, new CornerUndo()), 8);
  assert.equal(t.corners[2].rawWater & 0x3fff, 0x3fff - 300, "a water word near the top of its 14 bits stays");
  setWaterLevel(t.corners[2], 400);
  assert.equal(cliffShiftRange(t).min, -3, "nor near the bottom");
});
