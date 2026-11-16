import assert from "node:assert/strict";
import { test } from "node:test";
import { drawnGroundTiles, GROUND_HEIGHT_MAX, GROUND_HEIGHT_MIN, groundFits, parseW3e, setGroundHeight, setLayer, setWaterLevel, w3eWriteProblem, writeW3e, type Corner, type Terrain } from "./w3e";

/** A 2 × 2-corner terrain of `version`, every field in range. */
function tiny(version = 11): Terrain {
  const corner = (): Corner => ({
    height: 0, water: -89.6, texture: 1, variation: 3, cliffVariation: 2, cliffTexture: 15, layer: 2,
    ramp: false, blight: false, hasWater: false, boundary: false, rawHeight: 0x2000, rawWater: 0x2000, texExtra: 0,
  });
  return {
    version, tileset: "L", customTilesets: false, customTilesetsRaw: 0, groundTiles: ["Ldrt", "Lgrs"], cliffTiles: ["CLdi"],
    width: 2, height: 2, offsetX: -128, offsetY: -128, corners: [corner(), corner(), corner(), corner()], trailer: new Uint8Array(),
  };
}

test("the ground word holds -10240 to 6143.75: groundFits says which heights fit it with no cut-off", () => {
  assert.equal(GROUND_HEIGHT_MIN, -10240);
  assert.equal(GROUND_HEIGHT_MAX, 6143.75);
  for (const g of [GROUND_HEIGHT_MIN, GROUND_HEIGHT_MAX, 0, -2048.1]) assert.ok(groundFits(g), `${g} fits`);
  for (const g of [GROUND_HEIGHT_MIN - 0.25, GROUND_HEIGHT_MAX + 0.25, 1e9, -Infinity, Infinity, NaN]) assert.ok(!groundFits(g), `${g} doesn't fit`);
});

test("setGroundHeight refuses a height that isn't a number; past the word it stops at the end, as the brushes do", () => {
  const c = tiny().corners[0];
  assert.throws(() => setGroundHeight(c, NaN), /must be a number/);
  assert.equal(c.rawHeight, 0x2000, "unchanged");
  setGroundHeight(c, 1e9);
  assert.equal(c.rawHeight, 0x7fff);
  setGroundHeight(c, -Infinity);
  assert.equal(c.rawHeight, -0x8000);
});

test("setWaterLevel refuses a level past the 14 bits instead of wrapping it round (the World Editor wraps)", () => {
  const c = tiny().corners[0];
  c.rawWater = 0x4000 | 0x2000; // the map edge bit stays
  for (const level of [0x4000, -1, 0x3fff + 0.5, 1.5, NaN, Infinity]) {
    assert.throws(() => setWaterLevel(c, level), /14 bits, 0 to 16383/);
    assert.equal(c.rawWater, 0x6000);
    assert.equal(c.hasWater, false);
  }
  setWaterLevel(c, 0x3fff);
  assert.equal(c.rawWater, 0x7fff);
  setWaterLevel(c, 0);
  assert.equal(c.rawWater, 0x4000);
});

test("setLayer keeps the ground and moves the corner to 0-15", () => {
  const c = tiny().corners[0];
  setLayer(c, 15);
  assert.equal(c.layer, 15);
  assert.equal(c.height, 13 * 128);
});

test("writeW3e refuses a corner field past its bits, or not whole, instead of cutting it to them", () => {
  const ok = tiny();
  const bytes = writeW3e(ok);
  assert.deepEqual(writeW3e(parseW3e(bytes)), bytes, "a terrain in range writes and reads back as it was");
  const bad: [keyof Corner, number, number?][] = [
    ["layer", 16], ["layer", -1], ["layer", 2.5], ["variation", 32], ["cliffVariation", 8], ["cliffTexture", 16], ["texture", 16],
    ["rawHeight", 0x8000], ["rawHeight", -0x8001], ["rawHeight", NaN], ["rawWater", 0x10000], ["rawWater", -1], ["texExtra", 1],
    ["texture", 64, 12], ["texExtra", 64, 12],
  ];
  for (const [k, v, version] of bad) {
    const t = tiny(version);
    (t.corners[3] as unknown as Record<string, number>)[k] = v;
    assert.match(w3eWriteProblem(t) ?? "", new RegExp(`corner 1, 1 has ${k} ${v}`), `${k} ${v}`);
    assert.throws(() => writeW3e(t), /war3map\.w3e can't be written/, `${k} ${v}`);
  }
  // In range for version 12: texture up to 63, texExtra up to 63.
  const v12 = tiny(12);
  v12.corners[0].texture = 63;
  v12.corners[0].texExtra = 63;
  assert.equal(w3eWriteProblem(v12), null);
  const ids = tiny();
  ids.groundTiles.push("Ldr");
  assert.match(w3eWriteProblem(ids) ?? "", /ground tile "Ldr" isn't four characters/);
  const short = tiny();
  short.corners.pop();
  assert.match(w3eWriteProblem(short) ?? "", /2 × 2 corners, but 3/);
});

test("drawnGroundTiles: with the custom tilesets flag 0 the tileset's own list is drawn, slot by slot", () => {
  const own = ["Ldrt", "Ldro", "Ldrg", "Lrok", "Lgrs", "Lgrd"];
  const list = (tiles: string[], raw: number) => ({ groundTiles: tiles, customTilesetsRaw: raw });
  // The World Editor (maps custom-tilesets-<list>-0 of tests/fixtures/we-specs): another order, 3 and 9 tiles.
  assert.deepEqual(drawnGroundTiles(list(["Lgrd", "Lgrs", "Lrok", "Ldrg", "Ldro", "Ldrt"], 0), own), own);
  assert.deepEqual(drawnGroundTiles(list(["Lgrs", "Lrok", "Ldrt"], 0), own), ["Ldrt", "Ldro", "Ldrg"]);
  assert.deepEqual(drawnGroundTiles(list(["Lgrd", "Lgrs", "Lrok", "Ldrg", "Ldro", "Ldrt", "Wsnw", "Bdsr", "Ndrt"], 0), own),
    [...own, "Ldrt", "Ldrt", "Ldrt"]);
  // The flag set (any value), or the tileset's list unknown: the file's list; the file's list itself is untouched.
  const file = ["Lgrd", "Lgrs"];
  assert.deepEqual(drawnGroundTiles(list(file, 1), own), file);
  assert.deepEqual(drawnGroundTiles(list(file, 7), own), file);
  assert.deepEqual(drawnGroundTiles(list(file, 0), undefined), file);
  assert.deepEqual(drawnGroundTiles(list(file, 0), []), file);
  const t = list(file, 0);
  assert.notEqual(drawnGroundTiles(t, own), t.groundTiles);
  assert.deepEqual(t.groundTiles, ["Lgrd", "Lgrs"]);
});
