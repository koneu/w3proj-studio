import assert from "node:assert/strict";
import { test } from "node:test";
import { drawnGroundTiles, drawnSlot, paintSlot, GROUND_HEIGHT_MAX, GROUND_HEIGHT_MIN, groundFits, parseW3e, savedTerrain, settleDrawnList, setGroundHeight, setLayer, setWaterLevel, w3eWriteProblem, writeW3e, type Corner, type Terrain } from "./w3e";

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

const OWN_L = ["Ldrt", "Ldro", "Ldrg", "Lrok", "Lgrs", "Lgrd"];

test("drawnSlot and settleDrawnList: with the flag 0 a tile's slot is the one drawn so, and adding keeps the look", () => {
  const t = { groundTiles: ["Lgrs", "Lrok", "Ldrt"], customTilesetsRaw: 0 };
  assert.equal(drawnSlot(t, "Ldro", OWN_L), 1);
  assert.equal(drawnSlot(t, "Lgrs", OWN_L), -1, "in the file's list, but no slot is drawn with it");
  assert.equal(drawnSlot({ ...t, customTilesetsRaw: 1 }, "Lgrs", OWN_L), 0, "the flag set: the file's list");
  assert.equal(drawnSlot(t, "Lgrs", undefined), 0, "the own list unknown: the file's list");
  const held = t.groundTiles;
  settleDrawnList(t, OWN_L);
  assert.equal(t.groundTiles, held, "the same array");
  assert.deepEqual(t.groundTiles, ["Ldrt", "Ldro", "Ldrg"]);
  const set = { groundTiles: ["Lgrs"], customTilesetsRaw: 1 };
  settleDrawnList(set, OWN_L);
  assert.deepEqual(set.groundTiles, ["Lgrs"], "the flag set: unchanged");
});

test("paintSlot: with the flag 0 an own tile past the file's list grows it to that slot; another tileset's needs adding", () => {
  const few = { groundTiles: ["Lgrs", "Lrok", "Ldrt"], customTilesetsRaw: 0 };
  assert.equal(paintSlot(few, "Ldrg", OWN_L), 2, "drawn already");
  assert.deepEqual(few.groundTiles, ["Lgrs", "Lrok", "Ldrt"]);
  assert.equal(paintSlot(few, "Lgrd", OWN_L), 5);
  assert.deepEqual([few.groundTiles, few.customTilesetsRaw], [["Lgrs", "Lrok", "Ldrt", "Lrok", "Lgrs", "Lgrd"], 0]);
  assert.deepEqual(drawnGroundTiles(few, OWN_L), OWN_L);
  assert.equal(paintSlot(few, "Wsnw", OWN_L), -1, "not the tileset's");
  const set = { groundTiles: ["Lgrs"], customTilesetsRaw: 1 };
  assert.equal(paintSlot(set, "Ldrt", OWN_L), -1, "the flag set: the file's list, nothing grown");
  assert.deepEqual(set.groundTiles, ["Lgrs"]);
});

test("savedTerrain: with the flag 0 the save writes the tileset's own list, corners past it on slot 0, as the World Editor's", () => {
  const terrain = (tiles: string[], textures: number[], raw = 0): Terrain => {
    const t = tiny(12);
    t.groundTiles = tiles;
    t.customTilesetsRaw = raw;
    t.customTilesets = raw !== 0;
    textures.forEach((x, i) => { t.corners[i].texture = x; });
    return t;
  };
  // we-compare ct0-save-rev6-0, few3-0, more9-0: the list written is the own one, whole, and slots 6 to 8 become 0.
  const rev6 = terrain([...OWN_L].reverse(), [0, 1, 4, 5]);
  const out = savedTerrain(rev6, OWN_L);
  assert.deepEqual([out.groundTiles, out.corners.map((c) => c.texture), out.cliffTiles, out.customTilesetsRaw], [OWN_L, [0, 1, 4, 5], ["CLdi"], 0]);
  assert.deepEqual(savedTerrain(terrain(["Lgrs", "Lrok", "Ldrt"], [0, 1, 2, 2]), OWN_L).groundTiles, OWN_L);
  const more9 = terrain([...OWN_L].reverse().concat("Wsnw", "Bdsr", "Ndrt"), [5, 6, 7, 8]);
  const nine = savedTerrain(more9, OWN_L);
  assert.deepEqual([nine.groundTiles, nine.corners.map((c) => c.texture)], [OWN_L, [5, 0, 0, 0]]);
  // Each slot is drawn with what it was drawn with before.
  assert.deepEqual(nine.corners.map((c) => drawnGroundTiles(nine, OWN_L)[c.texture]), more9.corners.map((c) => drawnGroundTiles(more9, OWN_L)[c.texture]));
  // The terrain itself is not changed, and the written bytes read back as the saved form.
  assert.deepEqual([more9.groundTiles.length, more9.corners[1].texture], [9, 6]);
  assert.deepEqual(parseW3e(writeW3e(nine)).groundTiles, OWN_L);
  // Nothing to do: the same object (the flag set, the own list unknown, the own list already with no corner past it).
  for (const [t, own] of [[terrain(["Lgrd", "Lgrs"], [0, 1], 1), OWN_L], [rev6, undefined], [rev6, []], [terrain([...OWN_L], [0, 5]), OWN_L]] as const) {
    assert.equal(savedTerrain(t, own), t);
  }
});
