import assert from "node:assert/strict";
import { test } from "node:test";
import { isBackdrop } from "../../lib/terrain/area";
import { generatePathing, NO_WALK, NO_WATER } from "../../lib/terrain/pathing";
import { heightAt, setGroundHeight, type Terrain } from "../../lib/terrain/w3e";
import { planCliffs } from "./cliffs";
import { groundSlot, roughenCorners, setCliffs, setCliffType, setRamp, setUnitChoices, setWater, swapTiles, twinOf, whyNoRoom, withCliffTypes, type CliffKind } from "./aitools";

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

test("a ford slopes in on one cliff level, shallow enough to walk", () => {
  const t = flat();
  setWater(t, { left: 8 * 128, bottom: 8 * 128, right: 24 * 128, top: 24 * 128 }, "ellipse", "ford", kinds);
  const middle = corner(t, 16, 16);
  assert.equal(middle.layer, 2, "no cliff level changes");
  assert.equal(middle.hasWater, true);
  assert.ok(Math.abs(middle.water - middle.height - 38) < 1, `${middle.water - middle.height}`);
  assert.ok(t.corners.every((c) => c.layer === 2), "so no cliff anywhere");
  assert.ok(t.corners.every((c) => !c.hasWater || c.water - c.height <= 52), "units can walk all of it");
  assert.equal(corner(t, 2, 2).hasWater, false);
  const inward = [8, 10, 12, 14, 16].map((x) => corner(t, x, 16).height);
  assert.deepEqual(inward, [...inward].sort((a, b) => b - a), "it slopes down towards the middle");
  assert.ok(inward[0] - inward[1] < 47 * 2, "as gently as real banks, measured per tile");
});

test("a lake is deep in the middle and walkable at its edge", () => {
  const t = flat();
  setWater(t, { left: 8 * 128, bottom: 8 * 128, right: 24 * 128, top: 24 * 128 }, "ellipse", "lake", kinds);
  const depth = (x: number, y: number) => corner(t, x, y).water - corner(t, x, y).height;
  assert.ok(depth(16, 16) > 100);
  assert.ok(depth(9, 16) > 0 && depth(9, 16) <= 52, `${depth(9, 16)}`);
  assert.equal(corner(t, 16, 16).layer, 2);
});

test("in the pathing map a lake can't be walked across its middle, and a ford can be walked everywhere", () => {
  const cells = (t: Terrain) => {
    const w = (t.width - 1) * 4, p = generatePathing({ terrain: t, margins: [0, 0, 0, 0], tileRules: new Map() });
    return { w, at: (cx: number, cy: number) => p[16 + cy * w + cx] };
  };
  const area = { left: 8 * 128, bottom: 8 * 128, right: 24 * 128, top: 24 * 128 };
  const lake = flat();
  setWater(lake, area, "ellipse", "lake", kinds);
  const l = cells(lake);
  assert.ok(l.at(64, 64) & NO_WALK, "the deep middle is blocked");
  assert.ok(!(l.at(64, 64) & NO_WATER), "and it is water");
  // Walking in from the west edge: the first wet cells can be walked, then the way ends.
  const row = Array.from({ length: 128 }, (_, i) => l.at(i, 64));
  const wet = row.findIndex((v) => !(v & NO_WATER));
  assert.ok(wet > 0 && !(row[wet] & NO_WALK), "the rim is wet and walkable");
  assert.ok(row.some((v) => v & NO_WALK), "and then the water gets deep");
  const ford = flat();
  setWater(ford, area, "ellipse", "ford", kinds);
  const f = cells(ford);
  const fordRow = Array.from({ length: 128 }, (_, i) => f.at(i, 64));
  assert.ok(fordRow.some((v) => !(v & NO_WATER)), "the ford is water");
  assert.ok(fordRow.every((v) => !(v & NO_WALK)), "and every cell of it can be walked");
});

test("a river runs at any angle", () => {
  const t = flat();
  const changed = setWater(t, { points: [[4 * 128, 4 * 128], [28 * 128, 28 * 128]], width: 512 }, "ellipse", "ford", kinds);
  assert.ok(changed.length > 40);
  assert.equal(corner(t, 16, 16).hasWater, true);
  assert.equal(corner(t, 12, 12).hasWater, true);
  assert.equal(corner(t, 8, 24).hasWater, false);
});

test("widening a ford keeps its surface and doesn't raise the ground", () => {
  const t = flat();
  const first = { left: 8 * 128, bottom: 8 * 128, right: 16 * 128, top: 16 * 128 };
  setWater(t, first, "ellipse", "ford", kinds);
  const surface = corner(t, 12, 12).water, ground = corner(t, 12, 12).height;
  setWater(t, { ...first, right: 22 * 128 }, "ellipse", "ford", kinds);
  assert.equal(corner(t, 12, 12).water, surface);
  assert.ok(corner(t, 12, 12).height <= ground);
});

test("a ford leaves ground on other cliff levels alone", () => {
  const t = flat();
  setCliffs(t, { left: 0, bottom: 0, right: 12 * 128, top: 32 * 128 }, "box", { level: 3 }, kinds);
  setWater(t, { left: 8 * 128, bottom: 8 * 128, right: 24 * 128, top: 24 * 128 }, "ellipse", "ford", kinds);
  assert.equal(corner(t, 10, 16).hasWater, false);
  assert.equal(corner(t, 16, 16).hasWater, true);
});

test("the reason something can't stand somewhere names the cause", () => {
  const p = { cells: new Uint8Array(132 * 132), width: 132, height: 132 };
  const open = flat();
  assert.match(whyNoRoom(open, p, { id: "LTlt", position: [320, 300, 0] }, 300, 300), /LTlt stands there, at 320, 300/);
  assert.match(whyNoRoom(open, p, null, 300, 300), /footprint/);
  const cliffs = flat();
  setCliffs(cliffs, block, "box", { level: 3 }, kinds);
  assert.match(whyNoRoom(cliffs, p, null, 7.5 * 128, 12 * 128), /cliff/);
  const wet = flat();
  setWater(wet, { ...block, right: 24 * 128, top: 24 * 128 }, "ellipse", "ford", kinds);
  assert.match(whyNoRoom(wet, p, null, 16 * 128 + 20, 16 * 128 + 20), /water/);
  const blocked = { ...p, cells: new Uint8Array(132 * 132).fill(0x02) };
  assert.match(whyNoRoom(open, blocked, null, 300, 300), /can't be walked/);
  assert.match(whyNoRoom(open, { ...p, cells: new Uint8Array(132 * 132).fill(0x08) }, null, 300, 300), /can't be built on/);
});

test("a unit refused on painted Boundary is told so, not that its footprint reaches something", () => {
  // Round 3 (B10, 2026-11-12): a footman refused on a tile with a Boundary corner got the footprint text.
  const p = { cells: new Uint8Array(132 * 132), width: 132, height: 132 };
  const edge = flat();
  edge.corners[2 * edge.width + 3].boundary = true;
  const x = edge.offsetX + 2.5 * 128, y = edge.offsetY + 2.5 * 128;
  assert.match(whyNoRoom(edge, p, null, x, y, { kind: "w3u", id: "hfoo" }), /boundary/i);
  assert.match(whyNoRoom(edge, p, null, x, y, { kind: "w3t", id: "ratc" }), /boundary/i, "an item too");
  // It comes before an object nearby: the boundary refuses first.
  assert.match(whyNoRoom(edge, p, { id: "LTlt", position: [x + 40, y, 0] }, x, y, { kind: "w3u", id: "hfoo" }), /boundary/i);
  // A doodad and a start location can stand there, so it isn't their reason; nor is it a tile further off.
  assert.doesNotMatch(whyNoRoom(edge, p, null, x, y, { kind: "w3d", id: "LTlt" }), /boundary/i);
  assert.doesNotMatch(whyNoRoom(edge, p, null, x, y, { kind: "w3u", id: "sloc" }), /boundary/i);
  assert.doesNotMatch(whyNoRoom(edge, p, null, x + 3 * 128, y, { kind: "w3u", id: "hfoo" }), /boundary/i);
});

test("a twin stands turned 180° around the middle of the map", () => {
  assert.deepEqual(twinOf(1000, -500, { left: -4096, bottom: -4096, right: 4096, top: 4096 }), [-1000, 500]);
  assert.deepEqual(twinOf(1000, 500, { left: 0, bottom: 0, right: 8192, top: 4096 }), [7192, 3596]);
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

test("in the pathing map a ramp can be walked up, and the cliff beside it can't", () => {
  const t = flat();
  setCliffs(t, block, "box", { level: 3 }, kinds);
  const walk = () => {
    const w = (t.width - 1) * 4, p = generatePathing({ terrain: t, margins: [0, 0, 0, 0], tileRules: new Map() });
    // The middle cell of each tile along row 12 from tile 6 (low ground) to tile 8 (the top), and of tile (7, 10):
    // the ramp's flags run over corners 11..13, so that tile has two flagged corners and two not.
    // Tile (6, 10) is low ground beside the ramp's foot, taken in by the ramp side piece (rampSides).
    const at = (x: number, y: number) => !(p[16 + (y * 4 + 2) * w + x * 4 + 2] & NO_WALK);
    return { up: [6, 7, 8].map((x) => at(x, 12)), side: at(7, 10), foot: at(6, 10) };
  };
  assert.deepEqual(walk(), { up: [true, false, true], side: false, foot: true }, "the edge is a cliff");
  setRamp(t, 7.5 * 128, 12 * 128, 2, false);
  assert.deepEqual(walk(), { up: [true, true, true], side: false, foot: false }, "the ramp is walked up; the cliff further along and its side piece stay");
});

test("the view draws a ramp's side pieces on the tiles the pathing map blocks beside it", () => {
  const t = flat();
  setCliffs(t, block, "box", { level: 3 }, kinds);
  setRamp(t, 7.5 * 128, 12 * 128, 2, false);
  const types = new Map(kinds.map((k) => [k.cliffID, { ...k, cliffModelDir: "Cliffs", rampModelDir: "CliffTrans", texDir: "TerrainArt\\Cliffs", texFile: "Cliffs0" }]));
  const tw = t.width - 1;
  const sides = (exists: (path: string) => boolean) => planCliffs(t, types, exists).requests
    .filter((r) => r.path.includes("CliffTrans")).flatMap((r) => r.tiles).sort((a, b) => a - b).map((i) => [i % tw, Math.floor(i / tw)]);
  // The foot of the ramp at tiles (6, 10) and (6, 13), with the cliff tiles next to them.
  assert.deepEqual(sides(() => true), [[6, 10], [7, 10], [6, 13], [7, 13]]);
  assert.deepEqual(sides((p) => !p.includes("CliffTrans")), [], "no ramp models: ordinary cliffs");
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

test("changing the ground under part of a ramp removes all of it", () => {
  const t = flat();
  setCliffs(t, block, "box", { level: 3 }, kinds);
  setRamp(t, 7.5 * 128, 12 * 128, 2, false);
  const elsewhere = flat();
  setCliffs(t, block, "box", { level: 4 }, kinds);
  assert.equal(t.corners.filter((c) => c.ramp).length, 0, "no half ramp stays behind");
  assert.equal(elsewhere.corners.filter((c) => c.ramp).length, 0);
  const wet = flat();
  setCliffs(wet, block, "box", { level: 3 }, kinds);
  setRamp(wet, 7.5 * 128, 12 * 128, 2, false);
  const changed = setWater(wet, { left: 2 * 128, bottom: 11 * 128, right: 7 * 128, top: 13 * 128 }, "box", "ford", kinds);
  assert.equal(wet.corners.filter((c) => c.ramp).length, 0);
  assert.ok(changed.length > 0);
});

test("two ramps apart: only the one touched goes", () => {
  const t = flat();
  setCliffs(t, block, "box", { level: 3 }, kinds);
  setRamp(t, 7.5 * 128, 10 * 128, 2, false);
  setRamp(t, 7.5 * 128, 14 * 128, 2, false);
  setCliffs(t, { left: 8 * 128, bottom: 9 * 128, right: 8 * 128 + 1, top: 11 * 128 }, "box", { level: 4 }, kinds);
  assert.equal(corner(t, 8, 10).ramp, false);
  assert.equal(corner(t, 8, 14).ramp, true);
});

test("roughen makes ground uneven, gently, and repeats by seed", () => {
  const random = (seed: number) => () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const whole = { left: 0, bottom: 0, right: 32 * 128, top: 32 * 128 };
  const t = flat(), again = flat(), other = flat();
  const changed = roughenCorners(t, whole, "box", 24, random(7));
  roughenCorners(again, whole, "box", 24, random(7));
  roughenCorners(other, whole, "box", 24, random(8));
  assert.ok(changed.length > 900, String(changed.length));
  assert.deepEqual(t.corners.map((c) => c.rawHeight), again.corners.map((c) => c.rawHeight));
  assert.notDeepEqual(t.corners.map((c) => c.rawHeight), other.corners.map((c) => c.rawHeight));
  const heights = t.corners.map((c) => c.height);
  assert.ok(Math.max(...heights.map(Math.abs)) <= 24);
  assert.ok(t.corners.every((c) => c.layer === 2), "no cliffs");
  let step = 0;
  for (let y = 0; y < t.height; y++) for (let x = 0; x + 1 < t.width; x++) step = Math.max(step, Math.abs(corner(t, x, y).height - corner(t, x + 1, y).height));
  assert.ok(step < 16, `neighbours stay close: ${step}`);
});

test("roughen leaves ramps and water alone", () => {
  const t = flat();
  setCliffs(t, block, "box", { level: 3 }, kinds);
  setRamp(t, 7.5 * 128, 12 * 128, 2, false);
  setWater(t, { left: 20 * 128, bottom: 20 * 128, right: 30 * 128, top: 30 * 128 }, "ellipse", "ford", kinds);
  const ramp = corner(t, 7, 12).rawHeight, water = corner(t, 25, 25).rawHeight;
  roughenCorners(t, { left: 0, bottom: 0, right: 32 * 128, top: 32 * 128 }, "box", 40, () => 0.9);
  assert.equal(corner(t, 7, 12).rawHeight, ramp);
  assert.equal(corner(t, 25, 25).rawHeight, water);
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

test("a tile that stays doesn't get a second slot when a tileset changes", () => {
  const { tiles, kept } = swapTiles(["Ldrt", "Lgrs", "Alvd", "Lrok"], ["Ldrt", "Lgrs", "Lrok"], ["Alvd", "Adrt", "Agrs", "Arok"]);
  assert.deepEqual(kept, ["Alvd"]);
  assert.equal(new Set(tiles).size, tiles.length, tiles.join());
  assert.equal(tiles[2], "Alvd", "it stays in its slot");
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
