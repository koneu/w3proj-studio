import assert from "node:assert/strict";
import { test } from "node:test";
import { isBackdrop } from "../../lib/terrain/area";
import { heightAt, setGroundHeight, type Terrain } from "../../lib/terrain/w3e";
import { groundSlot, setCliffs, setCliffType, setRamp, setUnitChoices, setWater, withCliffTypes, type CliffKind } from "./aitools";

const kinds: CliffKind[] = [{ cliffID: "CLdi", groundTile: "Ldrt" }, { cliffID: "CLgr", groundTile: "Lgrs" }, { cliffID: "CLro", groundTile: "Lrok" }];

/** 32 × 32 tiles from (0, 0), flat grass at level 2, height 0, no cliff type yet (15). */
function flat(): Terrain {
  const width = 33, height = 33, groundTiles = ["Ldrt", "Lgrs", "Lrok"];
  return {
    version: 12, tileset: "L", customTilesets: false, customTilesetsRaw: 0, groundTiles, cliffTiles: ["CLdi", "CLgr", "CLro"],
    width, height, offsetX: 0, offsetY: 0, trailer: new Uint8Array(0),
    corners: Array.from({ length: width * height }, () => {
      const c = {
        height: 0, water: 0, texture: 1, variation: 0, cliffVariation: 0, cliffTexture: 15, layer: 2,
        ramp: false, blight: false, hasWater: false, boundary: false, rawHeight: 0x2000, rawWater: 0x2000, texExtra: 0,
      };
      setGroundHeight(c, 0);
      return c;
    }),
  };
}
const corner = (t: Terrain, x: number, y: number) => t.corners[y * t.width + x];
/** Tiles 8 to 16 both ways. */
const block = { left: 8 * 128, bottom: 8 * 128, right: 16 * 128, top: 16 * 128 };

test("a level lifts the area by whole cliffs, and leaves the rest", () => {
  const t = flat();
  const changed = setCliffs(t, block, "box", { level: 3 }, kinds);
  assert.ok(changed.length >= 81);
  assert.equal(corner(t, 12, 12).layer, 3);
  assert.equal(corner(t, 12, 12).height, 128);
  assert.equal(corner(t, 7, 12).layer, 2);
  assert.equal(heightAt(t, 12 * 128, 12 * 128), 128);
  assert.equal(heightAt(t, 2 * 128, 2 * 128), 0);
});

test("by counts from the middle of the area, and levels end at 0 and 15", () => {
  const t = flat();
  setCliffs(t, block, "box", { by: -2 }, kinds);
  assert.equal(corner(t, 12, 12).layer, 0);
  assert.throws(() => setCliffs(t, block, "box", { by: -1 }, kinds), /from 0 to 15, and this would be -1/);
  assert.throws(() => setCliffs(t, block, "box", { level: 16 }, kinds), /would be 16/);
  assert.deepEqual(setCliffs(t, block, "box", { level: 0 }, kinds), [], "already there");
});

test("an area outside the map says so", () => {
  assert.throws(() => setCliffs(flat(), { left: 9000, bottom: 9000, right: 9500, top: 9500 }, "box", { level: 3 }, kinds), /no ground in the map/);
});

test("cliffs take the look of their ground, or the one asked for", () => {
  const t = flat();
  setCliffs(t, block, "box", { level: 3 }, kinds);
  assert.equal(corner(t, 8, 12).cliffTexture, 1, "grass cliff on grass");
  assert.equal(corner(t, 12, 12).cliffTexture, 15, "flat ground in the middle has none");
  const rock = flat();
  setCliffs(rock, block, "box", { level: 3 }, kinds, "Lrok");
  assert.equal(corner(rock, 8, 12).cliffTexture, 2);
  assert.throws(() => setCliffs(flat(), block, "box", { level: 3 }, kinds, "Ldro"), /"Ldro" has no cliff.*Ldrt, Lgrs, Lrok/);
});

test("existing cliffs can change their look", () => {
  const t = flat();
  setCliffs(t, block, "box", { level: 3 }, kinds);
  assert.equal(corner(t, 8, 12).cliffTexture, 1);
  const changed = setCliffType(t, block, "box", "Ldrt", kinds);
  assert.ok(changed.length > 0);
  assert.equal(corner(t, 8, 12).cliffTexture, 0);
  assert.equal(corner(t, 12, 12).cliffTexture, 15, "flat ground isn't a cliff");
  assert.deepEqual(setCliffType(t, block, "box", "Ldrt", kinds), [], "already so");
});

test("asking for the level it's at still changes the look", () => {
  const t = flat();
  setCliffs(t, block, "box", { level: 3 }, kinds);
  setCliffs(t, block, "box", { level: 3 }, kinds, "Ldrt");
  assert.equal(corner(t, 8, 12).cliffTexture, 0);
});

test("another tileset's cliff joins the map, and the numbers in use stay", () => {
  const t = flat();
  setCliffs(t, block, "box", { level: 3 }, kinds);
  const more = [...kinds, { cliffID: "CVgr", groundTile: "Vgrt" }];
  setCliffType(t, { ...block, right: 10 * 128 }, "box", "Vgrt", more);
  assert.ok(t.groundTiles.includes("Vgrt") && t.cliffTiles.includes("CVgr"));
  assert.equal(corner(t, 8, 12).cliffTexture, 3);
  assert.equal(corner(t, 16, 12).cliffTexture, 1, "the far side stays grass");
});

test("a tile without a cliff is refused, and says how to find one", () => {
  assert.throws(() => setCliffType(flat(), block, "box", "Lgrd", kinds), /"Lgrd" has no cliff.*list_ground_tiles/);
  assert.throws(() => setCliffType(flat(), { left: 9000, bottom: 9000, right: 9500, top: 9500 }, "box", "Ldrt", kinds), /no ground in the map/);
});

test("the numbers count only tiles with a cliff of their own", () => {
  const t = flat();
  t.groundTiles = ["Lxxx", "Lgrs"];
  setCliffs(t, block, "box", { level: 3 }, kinds);
  assert.equal(corner(t, 8, 12).cliffTexture, 0, "Lgrs is the first with a cliff, so cliff type 0");
});

test("painting next to a cliff changes the cliff too, and says so", () => {
  const t = flat();
  setCliffs(t, block, "box", { level: 3 }, kinds);
  const i = 12 * t.width + 8;
  t.corners[i].texture = 2;
  const changed = withCliffTypes(t, [i], kinds);
  assert.equal(t.corners[i].cliffTexture, 2);
  assert.ok(changed.includes(i));
});

test("a new tile brings its cliff type along, as the brush does", () => {
  const t = flat();
  t.groundTiles = ["Ldrt"];
  t.cliffTiles = ["CLdi"];
  assert.equal(groundSlot(t, "Lrok", kinds), 1);
  assert.deepEqual(t.cliffTiles, ["CLdi", "CLro"]);
  assert.equal(t.customTilesets, true);
  groundSlot(t, "Lgrd", kinds);
  assert.deepEqual(t.cliffTiles, ["CLdi", "CLro"], "this one has no cliff");
});

test("water drops the ground and sets a surface below where it was", () => {
  const t = flat();
  setWater(t, block, "box", "shallow", kinds);
  const c = corner(t, 12, 12);
  assert.equal(c.layer, 1);
  assert.equal(c.hasWater, true);
  assert.equal(c.water, -89.6);
  assert.equal(c.height, -128);
  assert.equal(corner(t, 7, 12).hasWater, false);
  const deep = flat();
  setWater(deep, block, "box", "deep", kinds);
  assert.equal(corner(deep, 12, 12).layer, 0);
  assert.equal(corner(deep, 12, 12).water, -89.6, "the surface doesn't go down with the ground");
});

test("widening a lake keeps its surface and doesn't dig deeper", () => {
  const t = flat();
  setWater(t, block, "box", "shallow", kinds);
  setWater(t, { ...block, right: 20 * 128 }, "box", "shallow", kinds);
  assert.equal(corner(t, 12, 12).layer, 1);
  assert.equal(corner(t, 18, 12).layer, 1);
  assert.equal(corner(t, 18, 12).water, corner(t, 12, 12).water);
  assert.deepEqual(setWater(t, block, "box", "shallow", kinds), [], "all water already: nothing to do");
});

test("low ground has no room for water", () => {
  const t = flat();
  setCliffs(t, block, "box", { level: 1 }, kinds);
  assert.throws(() => setWater(t, block, "box", "deep", kinds), /cliff level 1, too low for deep water/);
});

test("dry takes the water away and leaves the ground down", () => {
  const t = flat();
  setWater(t, block, "box", "shallow", kinds);
  const changed = setWater(t, block, "box", "dry", kinds);
  assert.ok(changed.length > 0);
  assert.equal(corner(t, 12, 12).hasWater, false);
  assert.equal(corner(t, 12, 12).layer, 1);
  assert.deepEqual(setWater(flat(), block, "box", "dry", kinds), []);
});

test("a ramp goes on a straight edge, and comes off again", () => {
  const t = flat();
  setCliffs(t, block, "box", { level: 3 }, kinds);
  // The west edge of the block: level 3 from x = 8, level 2 at x = 7.
  const edge = [7.5 * 128, 12 * 128] as const;
  const built = setRamp(t, edge[0], edge[1], 2, false);
  assert.equal(built.length, 9, "three corners along the slope, three across");
  assert.equal(corner(t, 8, 12).ramp, true);
  assert.equal(corner(t, 6, 12).ramp, true);
  assert.throws(() => setRamp(t, edge[0], edge[1], 2, false), /already/);
  const removed = setRamp(t, edge[0], edge[1], 2, true);
  assert.equal(removed.length, 9);
  assert.equal(corner(t, 8, 12).ramp, false);
  assert.throws(() => setRamp(t, edge[0], edge[1], 2, true), /no ramp here/);
});

test("a ramp where there's no cliff, or too high a one, says what it needs", () => {
  assert.throws(() => setRamp(flat(), 300, 300, 2, false), /It needs a cliff one level high.*terrain_info/);
  const t = flat();
  setCliffs(t, block, "box", { level: 4 }, kinds);
  assert.throws(() => setRamp(t, 7.5 * 128, 12 * 128, 2, false), /one level high/);
});

test("a ramp wider than the edge is refused in tool words", () => {
  const t = flat();
  setCliffs(t, { left: 8 * 128, bottom: 8 * 128, right: 10 * 128, top: 10 * 128 }, "box", { level: 3 }, kinds);
  assert.throws(() => setRamp(t, 7.5 * 128, 9 * 128, 8, false), (e: Error) => !/Click|Size\b/.test(e.message) && /terrain_info/.test(e.message));
});

test("raising the ground over a ramp removes the ramp", () => {
  const t = flat();
  setCliffs(t, block, "box", { level: 3 }, kinds);
  setRamp(t, 7.5 * 128, 12 * 128, 2, false);
  setCliffs(t, block, "box", { level: 4 }, kinds);
  assert.equal(corner(t, 8, 12).ramp, false);
  assert.equal(corner(t, 6, 12).ramp, true, "outside the area it stays: set_ramp remove takes that away");
});

test("a unit takes camp mode, gold and random drops", () => {
  const e = { targetAcquisition: -1, gold: 0, itemSets: [] };
  setUnitChoices({ camp: true, gold: 9000, drops: [{ level: 2, kind: "powerup" }, { level: 3, kind: "permanent" }, { level: 1 }] }, e);
  assert.equal(e.targetAcquisition, -2);
  assert.equal(e.gold, 9000);
  assert.deepEqual(e.itemSets, [[{ id: "YkI2", chance: 100 }], [{ id: "YiI3", chance: 100 }], [{ id: "YYI1", chance: 100 }]]);
  setUnitChoices({ camp: false }, e);
  assert.equal(e.targetAcquisition, -1);
});

test("wrong unit choices are refused before anything changes", () => {
  assert.throws(() => setUnitChoices({ camp: "yes" }), /camp must be/);
  assert.throws(() => setUnitChoices({ gold: -5 }), /gold must be/);
  assert.throws(() => setUnitChoices({ drops: [{ level: 9 }] }), /level goes from 1 to 8/);
  assert.throws(() => setUnitChoices({ drops: [{ level: 2, kind: "epic" }] }), /kind is one of any, permanent/);
  assert.throws(() => setUnitChoices({ drops: "YiI2" }), /must be a list/);
});

test("trees and doodads may stand in the border, units and items may not", () => {
  const playable = { left: 0, bottom: 0, right: 1000, top: 1000 }, whole = { left: -500, bottom: -500, right: 1500, top: 1500 };
  assert.equal(isBackdrop("w3b", -100, 500, playable, whole), true);
  assert.equal(isBackdrop("w3d", 1200, 1200, playable, whole), true);
  assert.equal(isBackdrop("w3u", -100, 500, playable, whole), false);
  assert.equal(isBackdrop("w3t", -100, 500, playable, whole), false);
  assert.equal(isBackdrop("w3b", 500, 500, playable, whole), false, "inside, the ground still decides");
  assert.equal(isBackdrop("w3b", -900, 500, playable, whole), false, "off the map altogether");
  assert.equal(isBackdrop("w3b", -100, 500, null, whole), false, "bounds unknown: no exception");
});
