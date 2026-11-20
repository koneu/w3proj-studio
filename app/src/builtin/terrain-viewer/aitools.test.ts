import assert from "node:assert/strict";
import { test } from "node:test";
import { NO_BUILD, NO_WALK, NO_WATER } from "../../lib/terrain/pathing";
import { drawnGroundTiles, floatingLevelAt, groundHeight, heightAt, type Corner, type Terrain } from "../../lib/terrain/w3e";
import * as aitools from "./aitools";
import { replaceByType, entryLook, restoreEntry, replaceableBy, replaceableKinds, dress, followGround, groundSlot, heightColors, heightGrid, hiddenInPicture, lineSpots, paintCorners, paintPath, pathingColors, replacePlaced, roughenCorners, rowSpots, seededRandom, setCliffType, setWater, swapTiles, scatterSpots, sculptCorners, spotsAround, terrainSummary, textMap, viewOfArea } from "./aitools";
import { beyondPlayable, distanceToLine, isKeptClear, parseArea, playableArea } from "../../lib/terrain/area";
import { mulberry32 } from "../../lib/testhelpers/testutil";

/** Repeatable numbers in 0..1. */
const seeded = (seed = 1) => mulberry32(seed);
const box = { left: 0, bottom: 0, right: 1024, top: 1024 };

test("an area is a region by name, or a rectangle, or none", () => {
  const regions = [{ name: "Grove", left: 1, bottom: 2, right: 3, top: 4 }];
  assert.deepEqual(parseArea({ region: "grove" }, regions), regions[0]);
  assert.deepEqual(parseArea({ left: 0, bottom: 0, right: 8, top: 8 }, regions), { left: 0, bottom: 0, right: 8, top: 8 });
  assert.equal(parseArea({}, regions), null);
  assert.throws(() => parseArea({ region: "Nowhere" }, regions), /no region/);
  assert.throws(() => parseArea({ left: 0 }, regions), /all of left/);
  assert.throws(() => parseArea({ left: 9, bottom: 0, right: 1, top: 8 }, regions), /below right/);
});

test("scattered spots stay inside, sit on the pathing grid and spread over the area", () => {
  const spots = scatterSpots(box, 128, "box", seeded());
  assert.ok(spots.length > 40, `${spots.length}`);
  for (const s of spots) {
    assert.ok(s.x >= 0 && s.x <= 1024 && s.y >= 0 && s.y <= 1024);
    assert.equal(s.x % 32, 0);
    assert.equal(s.y % 32, 0);
  }
  assert.ok(spots.some((s) => s.x < 256 && s.y < 256) && spots.some((s) => s.x > 768 && s.y > 768));
});

test("an ellipse has no corners and thins out at its edge", () => {
  const spots = scatterSpots(box, 64, "ellipse", seeded());
  const r = (s: { x: number; y: number }) => Math.hypot(s.x - 512, s.y - 512) / 512;
  assert.ok(spots.every((s) => r(s) <= 1));
  const density = (a: number, b: number) => spots.filter((s) => r(s) >= a && r(s) < b).length / (b * b - a * a);
  assert.ok(density(0.85, 1) < density(0, 0.5) / 2);
});

const tree = { numVar: 5, randScale: true, minScale: 0.8, maxScale: 1.2, fixedRot: null };

/** 16 × 16 tiles from (0, 0), flat at level 2, height 0. */
function field(): Terrain {
  const c = { height: 0, water: 0, texture: 0, variation: 0, layer: 2, ramp: false, blight: false, hasWater: false, boundary: false, rawHeight: 0x2000, rawWater: 0 } as Corner;
  return { tileset: "A", groundTiles: ["Adrt", "Agrs"], width: 17, height: 17, offsetX: 0, offsetY: 0, corners: Array.from({ length: 289 }, () => ({ ...c })) } as unknown as Terrain;
}
const hill = { left: 0, bottom: 0, right: 2048, top: 2048 };
const at = (t: Terrain, x: number, y: number) => groundHeight(t.corners[y * t.width + x]);

test("a hill is highest in the middle and fades to nothing, so it has no step", () => {
  const t = field();
  const changed = sculptCorners(t, hill, "ellipse", "raise", 100);
  assert.equal(at(t, 8, 8), 100);
  assert.equal(at(t, 0, 0), 0);
  assert.equal(at(t, 0, 8), 0, "the edge itself");
  assert.ok(at(t, 4, 8) > 30 && at(t, 4, 8) < 70);
  for (let x = 0; x < 16; x++) assert.ok(Math.abs(at(t, x + 1, 8) - at(t, x, 8)) < 25, "steep steps would need a cliff");
  assert.ok(changed.length > 100 && changed.includes(8 * 17 + 8));
});

test("lowering, flattening and smoothing", () => {
  const t = field();
  sculptCorners(t, hill, "ellipse", "lower", 50);
  assert.equal(at(t, 8, 8), -50);
  sculptCorners(t, hill, "ellipse", "flatten", 0);
  assert.equal(at(t, 8, 8), 0);
  const bumpy = field();
  bumpy.corners[8 * 17 + 8].rawHeight += 400;
  sculptCorners(bumpy, hill, "ellipse", "smooth", undefined);
  assert.ok(at(bumpy, 8, 8) < 20, "a spike goes");
});

/** A field whose ground is `raw` (the stored word) everywhere. */
function fieldAt(raw: number): Terrain {
  const t = field();
  for (const c of t.corners) { c.rawHeight = raw; c.height = (raw - 0x2000) / 4; }
  return t;
}
const same = (t: Terrain) => JSON.stringify(t.corners);

test("a tool's ground past the stored word is refused whole, with nothing changed, not cut off there", () => {
  const top = fieldAt(0x7fff - 40), bottom = fieldAt(-0x8000 + 40);
  const cases: [string, Terrain, (t: Terrain) => unknown][] = [
    ["raise", top, (t) => sculptCorners(t, hill, "ellipse", "raise", 100)],
    ["lower", bottom, (t) => sculptCorners(t, hill, "ellipse", "lower", 100)],
    ["flatten above", field(), (t) => sculptCorners(t, hill, "ellipse", "flatten", 7000)],
    ["flatten below", field(), (t) => sculptCorners(t, hill, "box", "flatten", -20000)],
    ["roughen", top, (t) => roughenCorners(t, hill, "box", 1000, seeded())],
    ["lake", bottom, (t) => setWater(t, hill, "ellipse", "lake", [])],
  ];
  for (const [what, t, edit] of cases) {
    const was = same(t);
    assert.throws(() => edit(t), /^Error: Not done: the ground at \d+ corners? would go past the lowest or highest ground height a map can store \(-10240 to 6143\.75/, what);
    assert.equal(same(t), was, `${what}: nothing changed`);
  }
  // Up to the word's end is fine.
  const t = field();
  sculptCorners(t, hill, "box", "flatten", 6143.75);
  assert.equal(at(t, 8, 8), 6143.75);
});

test("a levelled path whose ground would pass the stored word is refused whole", () => {
  // Column 8 on cliff level 15, column 9 on level 0, both high: levelling column 9 towards the path between them
  // would lift it past 6143.75.
  const t = fieldAt(0x2000 + 6100 * 4);
  for (let y = 0; y < 17; y++) { t.corners[y * 17 + 8].layer = 15; t.corners[y * 17 + 9].layer = 0; }
  for (const c of t.corners) c.height = (c.rawHeight - 0x2000) / 4 + (c.layer - 2) * 128;
  const was = same(t);
  assert.throws(() => paintPath(t, [[8 * 128 + 64, 0], [8 * 128 + 64, 2048]], 256, 1, 0, true, seeded()), /Not done: the ground at \d+ corners/);
  assert.equal(same(t), was);
});

test("smoothing doesn't pull heights across a cliff", () => {
  const t = field();
  for (let y = 0; y < 17; y++) for (let x = 9; x < 17; x++) { t.corners[y * 17 + x].layer = 4; t.corners[y * 17 + x].rawHeight += 400; }
  sculptCorners(t, hill, "ellipse", "smooth", undefined);
  assert.equal(at(t, 8, 8), 0);
});

test("the map's boundary stays as it is", () => {
  const t = field();
  t.corners[8 * 17 + 8].boundary = true;
  sculptCorners(t, hill, "ellipse", "raise", 100);
  assert.equal(at(t, 8, 8), 0);
  assert.ok(at(t, 7, 8) > 0, "control: its neighbour is raised");
});

test("a seed repeats a painted patch, tile variations included", () => {
  const paint = (seed: number) => { const t = field(); paintCorners(t, hill, "ellipse", 1, 0.3, seededRandom(seed)); return t.corners.map((c) => [c.texture, c.variation]); };
  assert.deepEqual(paint(5), paint(5));
  assert.notDeepEqual(paint(5), paint(6));
});

test("painting a patch: its middle is solid and its edge frays", () => {
  const t = field();
  const changed = paintCorners(t, hill, "ellipse", 1, 0.4, seeded());
  assert.equal(t.corners[8 * 17 + 8].texture, 1);
  assert.equal(t.corners[8 * 17 + 7].texture, 1);
  assert.equal(t.corners[0].texture, 0);
  const n = t.corners.filter((c) => c.texture === 1).length;
  assert.equal(changed.length, n);
  const solid = field();
  assert.ok(paintCorners(solid, hill, "ellipse", 1, 0, seeded()).length > n, "edge 0 paints all of it");
  assert.equal(paintCorners(solid, hill, "ellipse", 1, 0, seeded()).length, 0, "what has the tile doesn't change");
});

test("a tile not in the map's list gets a slot, while there's room", () => {
  const t = field();
  const own = [t.customTilesets, t.customTilesetsRaw];
  assert.equal(groundSlot(t, "Agrs"), 1);
  assert.deepEqual(t.groundTiles, ["Adrt", "Agrs"], "a tile it has changes nothing");
  assert.deepEqual([t.customTilesets, t.customTilesetsRaw], own);
  assert.equal(groundSlot(t, "Lgrs"), 2);
  assert.deepEqual([t.customTilesets, t.customTilesetsRaw], [true, 1]);
  t.groundTiles = Array.from({ length: 16 }, (_, i) => `T${i}`);
  assert.throws(() => groundSlot(t, "Lgrs"), /already has 16/);
});

test("custom tilesets 0: the paint tools' slot is the one drawn as the tile (the tileset's own list, not the file's)", () => {
  // The we-spec map custom-tilesets-rev6-0: the file's list the own one reversed, drawn as the own one.
  const own = ["Ldrt", "Ldro", "Ldrg", "Lrok", "Lgrs", "Lgrd"];
  const rev6 = () => { const t = field(); t.tileset = "L"; t.groundTiles = [...own].reverse(); t.customTilesetsRaw = 0; t.customTilesets = false; return t; };
  for (const tile of own) {
    const t = rev6(), slot = groundSlot(t, tile, [], own);
    assert.equal(drawnGroundTiles(t, own)[slot], tile, `${tile}: the slot painted is drawn as ${tile}`);
    assert.deepEqual([t.groundTiles, t.customTilesetsRaw], [[...own].reverse(), 0], "a tile drawn already changes nothing");
  }
  // few3 (Lgrs Lrok Ldrt, drawn Ldrt Ldro Ldrg): Lgrs is in the file's list but no slot is drawn with it. It is the
  // own list's fifth: the list grows with the own tiles up to it, the flag stays 0 (the World Editor's slot 4).
  const few = field();
  Object.assign(few, { tileset: "L", groundTiles: ["Lgrs", "Lrok", "Ldrt"], customTilesetsRaw: 0, customTilesets: false });
  const before = drawnGroundTiles(few, own);
  const slot = groundSlot(few, "Lgrs", [], own);
  assert.equal(slot, 4);
  assert.deepEqual(drawnGroundTiles(few, own).slice(0, 3), before, "the other slots keep their look");
  assert.deepEqual([few.groundTiles, few.customTilesetsRaw], [["Lgrs", "Lrok", "Ldrt", "Lrok", "Lgrs"], 0]);
  // painted with it: the corners are drawn as the tile asked
  paintCorners(few, hill, "box", slot, 0, seeded());
  assert.equal(drawnGroundTiles(few, own)[few.corners[8 * 17 + 8].texture], "Lgrs");
  // A tile not of the tileset: the file's list becomes the one drawn, then the tile is added (the flag 1), each slot
  // drawn as before.
  const other = rev6(), was = drawnGroundTiles(other, own);
  const snow = groundSlot(other, "Wsnw", [], own);
  assert.deepEqual([snow, other.customTilesetsRaw, drawnGroundTiles(other, own)], [6, 1, [...was, "Wsnw"]]);
  // The cliff type tools look the tile up the same way: Ldrt's cliff on a map whose file's list lacks Ldrt but whose
  // slot 0 is drawn with it adds no tile, and the flag stays 0.
  const cliffy = field();
  Object.assign(cliffy, { tileset: "L", groundTiles: ["Lgrd", "Lgrs", "Lrok"], cliffTiles: ["CLgr"], customTilesetsRaw: 0, customTilesets: false });
  for (const c of cliffy.corners.slice(0, 17 * 4)) c.layer = 3;
  setCliffType(cliffy, hill, "box", "Ldrt", [{ cliffID: "CLdi", groundTile: "Ldrt" }, { cliffID: "CLgr", groundTile: "Lgrs" }], own);
  assert.deepEqual([cliffy.groundTiles, cliffy.customTilesetsRaw, cliffy.cliffTiles], [["Lgrd", "Lgrs", "Lrok"], 0, ["CLgr", "CLdi"]]);
  assert.deepEqual(drawnGroundTiles(cliffy, own), ["Ldrt", "Ldro", "Ldrg"], "drawn as before");
  // With the flag set the file's list counts, as before.
  const set = rev6();
  set.customTilesetsRaw = 1;
  assert.equal(groundSlot(set, "Ldrt", [], own), 5);
});

test("the AI cliff tool takes a third cliff type, and refuses one a corner can't name", () => {
  const own = ["Ldrt", "Ldro", "Ldrg", "Lrok", "Lgrs", "Lgrd"];
  const kinds = [{ cliffID: "CLdi", groundTile: "Ldrt" }, { cliffID: "CLgr", groundTile: "Lgrs" }, { cliffID: "CAdi", groundTile: "Adrt" },
    ...Array.from({ length: 14 }, (_, i) => ({ cliffID: `C${String(i).padStart(3, "0")}`, groundTile: `G${String(i).padStart(3, "0")}` }))];
  const cliffy = (cliffTiles: string[]) => {
    const t = field();
    Object.assign(t, { tileset: "L", groundTiles: [...own], cliffTiles, customTilesetsRaw: 0, customTilesets: false });
    for (const c of t.corners.slice(0, 17 * 4)) c.layer = 3;
    return t;
  };
  const three = cliffy(["CLdi", "CLgr"]);
  const changed = setCliffType(three, hill, "box", "Adrt", kinds, own);
  assert.deepEqual(three.cliffTiles, ["CLdi", "CLgr", "CAdi"]);
  assert.ok(changed.length && changed.every((i) => three.corners[i].cliffTexture === 2), "the corners got number 2");
  // A full list (15) can't take CAdi; a list where Adrt's cliff is the 16th can't paint it.
  const fifteen = kinds.slice(3, 17).map((k) => k.cliffID);
  assert.throws(() => setCliffType(cliffy(["CLdi", ...fifteen]), hill, "box", "Adrt", kinds, own), /cliff list is full \(15 entries/);
  assert.throws(() => setCliffType(cliffy(["CLdi", ...fifteen, "CAdi"]), hill, "box", "Adrt", kinds, own), /entry 15 of the map's cliff list/);
});

test("objects near the change follow the ground, except doodads with a fixed height", () => {
  const t = field();
  const changed = sculptCorners(t, hill, "ellipse", "raise", 100);
  const on = { position: [1024, 1024, 0] }, fixed = { position: [1024, 1024, 0], flags: 6 }, far = { position: [9000, 9000, 7] };
  assert.equal(followGround([on, fixed, far], t, changed, true), 1);
  assert.equal(on.position[2], heightAt(t, 1024, 1024));
  assert.equal(fixed.position[2], 0);
  assert.equal(far.position[2], 7);
  const unit = { position: [1024, 1024, 0], flags: 6 };
  assert.equal(followGround([unit], t, changed, false), 1, "the flag is a doodad's");
  assert.equal(followGround([on], t, [], true), 0);
});

test("a floating doodad follows the edited ground onto the water, a plain one onto the bed", () => {
  const t = field();
  const changed = setWater(t, hill, "ellipse", "lake", []);
  const pad = { id: "ZPlp", position: [1024, 1024, 0] }, plant = { id: "ZPfw", position: [1024, 1024, 0] };
  const floats = (id: string) => id === "ZPlp";
  assert.equal(followGround([pad, plant], t, changed, true, floats), 2);
  const water = floatingLevelAt(t, 1024, 1024);
  assert.ok(water !== null && water > heightAt(t, 1024, 1024), "the lake has water over its bed there");
  assert.equal(pad.position[2], water, "on the water");
  assert.equal(plant.position[2], heightAt(t, 1024, 1024), "on the bed");
  // Units never float by this rule, whatever their id.
  const unit = { id: "ZPlp", position: [1024, 1024, 0] };
  followGround([unit], t, changed, false, floats);
  assert.equal(unit.position[2], heightAt(t, 1024, 1024));
});

test("the height grid has north first and stays small", () => {
  const t = field();
  sculptCorners(t, hill, "ellipse", "raise", 100);
  const small = heightGrid(t, { left: 0, bottom: 0, right: 512, top: 1024 });
  assert.equal(small.rows.length, 9);
  assert.equal(small.rows[0].length, 5);
  assert.equal(small.rows[0][4], Math.round(heightAt(t, 512, 1024)));
  assert.equal(small.rows[8][0], 0);
  assert.ok(heightGrid({ ...t }, { left: 0, bottom: 0, right: 12800, top: 12800 }).cellSize === 512);
});

test("height colours run from blue to red, with lines between levels", () => {
  const t = field();
  sculptCorners(t, hill, "ellipse", "raise", 100);
  const { rgba, width, height } = heightColors(t);
  assert.deepEqual([width, height, rgba.length], [64, 64, 64 * 64 * 4]);
  const px = (x: number, y: number) => [...rgba.slice((y * width + x) * 4, (y * width + x) * 4 + 4)];
  assert.ok(px(1, 1)[2] > px(1, 1)[0], "low is blue");
  assert.ok(px(32, 32)[0] > px(32, 32)[2], "high is red");
  assert.ok(Array.from({ length: 64 }, (_, x) => px(x, 32)).some((p) => p[0] === 0 && p[3] === 220), "a line crosses the slope");
});

test("the playable area comes from the map's border, and leaving it is said", () => {
  const t = { offsetX: -4096, offsetY: -4096, width: 65, height: 65 };
  const p = playableArea({ cameraComplements: [6, 6, 4, 8] }, t);
  assert.deepEqual(p, { left: -3328, right: 3328, bottom: -3584, top: 3072 });
  assert.equal(beyondPlayable({ left: 0, bottom: 0, right: 100, top: 100 }, p), null);
  assert.match(beyondPlayable({ left: -3500, bottom: 0, right: 100, top: 3200 }, p) ?? "", /west and north/);
});

test("keep-clear places: areas, and lines with a width", () => {
  assert.equal(distanceToLine(5, 3, [[0, 0], [10, 0]]), 3);
  assert.equal(distanceToLine(13, 4, [[0, 0], [10, 0]]), 5);
  assert.equal(distanceToLine(1, 1, [[1, 1]]), 0);
  const keep = [{ left: 0, bottom: 0, right: 10, top: 10 }, { points: [[100, 0], [200, 0]] as [number, number][], width: 40 }];
  assert.equal(isKeptClear(5, 5, keep), true);
  assert.equal(isKeptClear(150, 19, keep), true);
  assert.equal(isKeptClear(150, 21, keep), false);
});

test("a path paints along its line, frays at its sides and ends, and leaves the rest", () => {
  const t = field();
  const changed = paintPath(t, [[256, 1024], [1792, 1024]], 256, 1, 0.5, false, seeded());
  assert.equal(t.corners[8 * 17 + 8].texture, 1);
  assert.equal(t.corners[2 * 17 + 8].texture, 0);
  assert.equal(t.corners[0].texture, 0);
  assert.ok(changed.includes(8 * 17 + 8));
  assert.ok(changed.length > 8 && changed.length < 40);
  const hard = field();
  assert.ok(paintPath(hard, [[256, 1024], [1792, 1024]], 256, 1, 0, false, seeded()).length > changed.length, "fraying leaves out some of what a hard edge paints");
});

test("a thin path stays in one piece, whatever the fraying does", () => {
  const t = field();
  paintPath(t, [[100, 180], [1900, 1770]], 90, 1, 1, false, () => 0.99);
  for (let n = 0; n <= 40; n++) {
    const x = Math.round((100 + 45 * n) / 128), y = Math.round((180 + 39.75 * n) / 128);
    assert.equal(t.corners[y * 17 + x].texture, 1, `${x},${y}`);
  }
});

test("a seed repeats a layout, and another seed doesn't", () => {
  const spots = (seed: number) => scatterSpots(box, 96, "ellipse", seededRandom(seed));
  assert.deepEqual(spots(7), spots(7));
  assert.notDeepEqual(spots(7), spots(8));
  const r = seededRandom(1), all = Array.from({ length: 1000 }, r);
  assert.ok(all.every((v) => v >= 0 && v < 1) && Math.abs(all.reduce((a, b) => a + b) / 1000 - 0.5) < 0.05);
});

test("rows cover an area evenly, stay in it, and can be loosened", () => {
  const spots = rowSpots({ left: 0, bottom: 0, right: 400, top: 200 }, 100, 100, 0, seededRandom(1));
  assert.deepEqual(spots.map((s) => [s.x, s.y]), [[50, 50], [150, 50], [250, 50], [350, 50], [50, 150], [150, 150], [250, 150], [350, 150]]);
  const loose = rowSpots({ left: 0, bottom: 0, right: 400, top: 200 }, 100, 100, 10, seededRandom(1));
  assert.ok(loose.every((s, i) => Math.abs(s.x - spots[i].x) <= 10) && loose.some((s, i) => s.x !== spots[i].x));
});

test("the pathing picture tells free, cliffs, water, what stands there and destructables apart", () => {
  const free = 0x40, cliff = 0x40 | 0x02, water = 0;
  const rgba = pathingColors(new Uint8Array([free, cliff, water, free, free]), new Uint8Array([0, 0, 0, 1, 1]), new Uint8Array([0, 0, 0, 0, 1]));
  const px = (i: number) => [...rgba.slice(i * 4, i * 4 + 4)];
  assert.equal(px(0)[3], 0);
  assert.deepEqual(px(1), [230, 30, 30, 170]);
  assert.deepEqual(px(2), [60, 150, 255, 90]);
  assert.deepEqual(px(3), [255, 150, 0, 170]);
  assert.deepEqual(px(4), [170, 70, 230, 170], "a tree shows as what it is");
  const doodad = pathingColors(new Uint8Array([cliff]), new Uint8Array([1]), new Uint8Array([0]));
  assert.deepEqual([...doodad.slice(0, 4)], [255, 150, 0, 170], "a doodad is in the pathing map too, and still shows as standing there");
});

test("a flattened path levels the ground across it towards its middle", () => {
  const t = field();
  for (let i = 8 * 17; i < 9 * 17; i++) t.corners[i].rawHeight += 400;
  const crown = at(t, 8, 8);
  paintPath(t, [[0, 896], [2048, 896]], 512, 1, 0, true, seeded());
  assert.ok(at(t, 8, 8) < crown, "a bump beside the line is brought down");
  assert.equal(t.corners[0].rawHeight, 0x2000);
});

test("a tileset change swaps the tileset's own tiles, slot by slot, and keeps others", () => {
  const got = swapTiles(["Ldrt", "Lgrs", "Vcbp", "Lrok"], ["Ldrt", "Lrok", "Lgrs", "Lgrd"], ["Fdrt", "Frok", "Fgrs", "Fgrd"]);
  assert.deepEqual(got.tiles, ["Fdrt", "Frok", "Vcbp", "Fgrs"]);
  assert.deepEqual(got.kept, ["Vcbp"]);
});

test("a tile that stays doesn't get a second slot when a tileset changes", () => {
  const { tiles, kept } = swapTiles(["Ldrt", "Lgrs", "Alvd", "Lrok"], ["Ldrt", "Lgrs", "Lrok"], ["Alvd", "Adrt", "Agrs", "Arok"]);
  assert.deepEqual(kept, ["Alvd"]);
  assert.equal(new Set(tiles).size, tiles.length, tiles.join());
  assert.equal(tiles[2], "Alvd", "it stays in its slot");
});

test("a tileset with fewer tiles repeats its last, so no slot is lost", () => {
  assert.deepEqual(swapTiles(["A", "B", "C"], ["A", "B", "C"], ["X", "Y"]).tiles, ["X", "Y", "Y"]);
});

test("objects swap types where they stand, in an area if given", () => {
  const list = [
    { id: "LTlt", position: [0, 0, 5], variation: 7, skinId: "LTlt" },
    { id: "LTlt", position: [900, 0, 5], variation: 1 },
    { id: "ARrk", position: [0, 0, 5] },
  ];
  assert.equal(replacePlaced(list, { LTlt: "FTtw" }, { left: -10, bottom: -10, right: 10, top: 10 }, () => 4), 1);
  assert.deepEqual(list[0], { id: "FTtw", position: [0, 0, 5], variation: 3, skinId: "FTtw" });
  assert.equal(list[1].id, "LTlt");
  assert.equal(replacePlaced(list, { LTlt: "FTtw" }, null, () => 4), 1);
  assert.equal(list[1].variation, 1);
  assert.equal("skinId" in list[1], false);
  assert.equal(list[2].id, "ARrk");
});

test("a replace follows the new kind's life: barrel to destructable and back, units untouched", () => {
  const kinds: Record<string, string> = { LTbr: "w3d", LTcr: "w3b", hfoo: "w3u", hpea: "w3u" };
  const kindOf = (id: string) => kinds[id];
  const list: { id: string; position: number[]; life?: number }[] = [{ id: "LTbr", position: [0, 0, 0], life: 255 }, { id: "LTcr", position: [1, 0, 0], life: 50 }, { id: "hfoo", position: [2, 0, 0] }];
  assert.equal(replacePlaced(list, { LTbr: "LTcr" }, null, () => 1, kindOf), 1);
  assert.equal(list[0].life, 100);
  assert.equal(replacePlaced(list, { LTcr: "LTbr" }, null, () => 1, kindOf), 2);
  assert.deepEqual(list.map((e) => e.life), [255, 255, undefined]);
  assert.equal(replacePlaced(list, { hfoo: "hpea" }, null, () => 1, kindOf), 1);
  assert.equal(list[2].life, undefined);
  // Without the kind (control: the old behaviour) the life stays.
  const old = [{ id: "LTbr", position: [0, 0, 0], life: 255 }];
  replacePlaced(old, { LTbr: "LTcr" }, null, () => 1);
  assert.equal(old[0].life, 255);
});

test("a picture can leave things out, water with its shoreline", () => {
  assert.deepEqual(hiddenInPicture(undefined), { groups: [], water: false });
  assert.deepEqual(hiddenInPicture(["doodads", "units"]), { groups: ["doodads", "units"], water: false });
  assert.deepEqual(hiddenInPicture(["water"]), { groups: ["shoreline"], water: true });
  assert.throws(() => hiddenInPicture(["terrain"]), /hide lists any of/);
  assert.throws(() => hiddenInPicture("doodads"), /hide lists any of/);
});

test("a line's pieces fill it from end to end, so corners meet, and are turned along it", () => {
  const east = lineSpots([0, 0], [400, 0], 100, 90);
  assert.deepEqual(east.map((s) => s.x), [50, 150, 250, 350]);
  assert.ok(east.every((s) => s.facing === 90));
  assert.equal(lineSpots([0, 0], [0, 400], 100, 90)[0].facing, 180);
  assert.equal(lineSpots([0, 0], [-400, 0], 100, 90)[0].facing, 270);
  assert.equal(lineSpots([0, 0], [10, 0], 100, 0).length, 1, "at least one");
  assert.equal(lineSpots([0, 0], [1000, 0], 190, 90).length, 6, "1000 / 190: rather a little overlap than gaps");
});

test("looking for room goes outwards, on the pathing grid", () => {
  const spots = spotsAround(320, 320);
  assert.ok(spots.every(([x, y]) => x % 32 === 0 && y % 32 === 0));
  const d = (s: [number, number]) => Math.hypot(s[0] - 320, s[1] - 320);
  assert.ok(d(spots[0]) < 50 && d(spots.at(-1)!) > 250);
});

test("a size range is used instead of the type's", () => {
  const e = { variation: 0, angle: 0, scale: [1, 1, 1] as [number, number, number] };
  dress(e, tree, { scaleRange: [0.3, 0.5] }, true, seeded());
  assert.ok(e.scale[0] >= 0.3 && e.scale[0] <= 0.5);
});

test("scattered things differ, within what their type allows", () => {
  const random = seeded();
  const made = Array.from({ length: 50 }, () => {
    const e = { variation: 0, angle: 0, scale: [1, 1, 1] as [number, number, number] };
    dress(e, tree, {}, true, random);
    return e;
  });
  assert.ok(new Set(made.map((e) => e.variation)).size > 2);
  assert.ok(made.every((e) => e.variation < 5 && e.scale[0] >= 0.8 && e.scale[0] <= 1.2 && e.scale[0] === e.scale[2]));
  assert.ok(new Set(made.map((e) => e.angle)).size > 40);
});

test("what's asked for wins, a type's fixed facing wins over that, and units don't vary by themselves", () => {
  const e = { variation: 0, angle: 0, scale: [1, 1, 1] as [number, number, number] };
  dress(e, tree, { variation: 3, facing: 180, scale: 2 }, true, seeded());
  assert.deepEqual(e, { variation: 3, angle: Math.PI, scale: [2, 2, 2] });
  // A variation the type hasn't got is refused, not moved to its last one (decision 2026-11-15), and nothing changes.
  for (const variation of [9, 5, -1, 1.5, NaN, Infinity]) {
    assert.throws(() => dress(e, tree, { variation, facing: 0 }, true, seeded()), /variation goes from 0 to 4/);
    assert.deepEqual(e, { variation: 3, angle: Math.PI, scale: [2, 2, 2] });
  }
  dress(e, { ...tree, fixedRot: 90 }, { facing: 180 }, true, seeded());
  assert.equal(e.angle, Math.PI / 2);
  const unit = { variation: 0, angle: 1, scale: [1, 1, 1] as [number, number, number] };
  dress(unit, tree, {}, false, seeded());
  assert.deepEqual(unit, { variation: 0, angle: 1, scale: [1, 1, 1] });
});

/** 8 × 8 tiles from (0, 0); pathing cells are 32 wide, row 0 in the south. */
function ground(edit: (cell: (tx: number, ty: number, flags: number) => void) => void) {
  const c = { height: 100, water: 0, texture: 0, layer: 2, ramp: false, blight: false, hasWater: false } as Corner;
  const t = { tileset: "A", groundTiles: ["Adrt", "Agrs"], width: 9, height: 9, offsetX: 0, offsetY: 0, corners: Array.from({ length: 81 }, () => ({ ...c })) } as unknown as Terrain;
  const p = { width: 32, height: 32, cells: new Uint8Array(32 * 32).fill(NO_WATER) };
  edit((tx, ty, flags) => { for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) p.cells[(ty * 4 + y) * 32 + tx * 4 + x] = flags; });
  return { t, p };
}

test("the text map has north on top and tells ground, water and blocked apart", () => {
  const { t, p } = ground((tile) => {
    tile(0, 7, NO_WATER | NO_WALK);
    tile(7, 0, 0);
    tile(1, 0, NO_WATER | NO_BUILD);
  });
  const map = textMap(t, p, { left: 0, bottom: 0, right: 1024, top: 1024 });
  assert.equal(map.rows.length, 8);
  assert.equal(map.rows[0], "#.......");
  assert.equal(map.rows[7], ".,.....~");
  assert.deepEqual([map.left, map.top, map.cellSize], [0, 1024, 128]);
});

test("one blocked cell is enough to show: a tree is that small", () => {
  const { t, p } = ground(() => {});
  p.cells[33] = NO_WATER | NO_WALK;
  const map = textMap(t, p, { left: 0, bottom: 0, right: 1024, top: 1024 });
  assert.equal(map.rows[7], "#.......");
  assert.equal(map.rows[6], "........");
});

test("a big area stays a small map", () => {
  const { t, p } = ground(() => {});
  const wide = { ...t, width: 513, offsetX: -8192, offsetY: -8192 } as Terrain;
  const map = textMap(wide, { ...p, width: 512, height: 512, cells: new Uint8Array(512 * 512).fill(NO_WATER) }, { left: -8192, bottom: -8192, right: 8192, top: 8192 });
  assert.ok(map.rows.length <= 64 && map.rows[0].length <= 64, `${map.rows.length}`);
  assert.equal(map.cellSize, 256);
});

test("the summary counts what's inside only", () => {
  const { t, p } = ground(() => {});
  t.corners[0].height = 300;
  t.corners[1].texture = 1;
  t.corners[10].hasWater = true;
  t.corners[10].water = 200;
  t.corners[80].layer = 5;
  const got = terrainSummary(t, p, { left: 0, bottom: 0, right: 128, top: 128 });
  assert.deepEqual(got.height, { lowest: 100, highest: 300 });
  assert.deepEqual(got.cliffLevels, [2]);
  assert.equal(got.percent.water, 25);
  assert.deepEqual(got.groundTiles, [{ id: "Adrt", percent: 75 }, { id: "Agrs", percent: 25 }]);
  assert.throws(() => terrainSummary(t, p, { left: 9000, bottom: 9000, right: 9500, top: 9500 }), /outside/);
});

test("the summary names tiles as drawn: with the custom tilesets flag 0 by the tileset's own list", () => {
  const { t, p } = ground(() => {});
  t.corners[1].texture = 1;
  const area = { left: 0, bottom: 0, right: 128, top: 128 };
  // The file says Adrt, Agrs; the tileset's own list (with the flag 0 what each slot is drawn with) Agrs, Avin.
  t.customTilesetsRaw = 0;
  assert.deepEqual(terrainSummary(t, p, area, ["Agrs", "Avin"]).groundTiles, [{ id: "Agrs", percent: 75 }, { id: "Avin", percent: 25 }]);
  t.customTilesetsRaw = 1;
  assert.deepEqual(terrainSummary(t, p, area, ["Agrs", "Avin"]).groundTiles, [{ id: "Adrt", percent: 75 }, { id: "Agrs", percent: 25 }], "control: the flag set, the file's");
});

test("the camera for an area looks at its middle, with room around it", () => {
  const v = viewOfArea({ left: 0, bottom: 0, right: 2000, top: 1000 }, 40, 2, Math.PI / 2, "top");
  assert.deepEqual(v.target, [1000, 500, 40]);
  assert.ok(Math.abs(v.distance - 600) < 0.001);
  assert.ok(v.pitch > viewOfArea(box, 0, 1, 1, "angled").pitch && viewOfArea(box, 0, 1, 1, "angled").pitch > viewOfArea(box, 0, 1, 1, "low").pitch);
  assert.equal(viewOfArea({ left: 0, bottom: 0, right: 1, top: 1 }, 0, 1, 1, "top").distance, 400);
});

test("a selection is offered what it can become", () => {
  assert.deepEqual(replaceableKinds(["w3d"]), ["w3d", "w3b"]);
  assert.deepEqual(replaceableKinds(["w3b"]), ["w3b", "w3d"], "trees open on destructables");
  assert.deepEqual(replaceableKinds(["w3b", "w3d"]), ["w3b", "w3d"]);
  assert.deepEqual(replaceableKinds(["w3u"]), ["w3u"]);
  assert.deepEqual(replaceableKinds(["w3t"]), ["w3t"]);
  assert.deepEqual(replaceableKinds(["w3u", "w3d"]).sort(), ["w3b", "w3d", "w3u"]);
  assert.equal(replaceableBy("w3d", "w3b"), true, "a tree can become a destructable");
  assert.equal(replaceableBy("w3u", "w3d"), false, "a unit can't become a doodad: they're in different files");
  assert.equal(replaceableBy("w3t", "w3u"), false);
});

test("a replace's snapshot restores the whole entry: life, scale and flags come back exactly", () => {
  const kinds: Record<string, string> = { LTbr: "w3d", LTcr: "w3b" };
  const kindOf = (id: string) => kinds[id];
  const list: { id: string; skinId?: string; position: number[]; life?: number; scale?: number[]; flags?: number; extra?: number }[] = [
    { id: "LTbr", skinId: "LTbr", position: [1, 2, 3], life: 255, scale: [1, 1, 1], flags: 2 },
    { id: "LTcr", skinId: "LTcr", position: [4, 5, 6], life: 100, scale: [2, 2, 2] },
  ];
  const start = structuredClone(list);
  const before = list.map(entryLook);
  replacePlaced(list, { LTbr: "LTcr", LTcr: "LTbr" }, null, () => 1, kindOf);
  list[0].scale = [3, 3, 3]; list[0].flags = 7; list[1].extra = 1;
  assert.notDeepEqual(list, start);
  list.forEach((e, i) => restoreEntry(e, before[i]));
  assert.deepEqual(list, start);
  // Control: restoring only id, skinId and variation (the old undo) leaves the life changed.
  const old = structuredClone(start);
  replacePlaced(old, { LTbr: "LTcr" }, null, () => 1, kindOf);
  old[0].id = "LTbr"; old[0].skinId = "LTbr";
  assert.notEqual(old[0].life, start[0].life);
});

test("replace_objects sets the life of the new kind: 100 as destructable, 255 as doodad", () => {
  const types: Record<string, { numVar: number; kind: string }> = { LTbr: { numVar: 1, kind: "w3d" }, LTcr: { numVar: 1, kind: "w3b" } };
  const look = (id: string) => types[id];
  const list = [{ id: "LTbr", skinId: "LTbr", position: [0, 0, 0], life: 255 }];
  assert.equal(replaceByType(list, { LTbr: "LTcr" }, null, look), 1);
  assert.equal(list[0].life, 100);
  assert.equal(replaceByType(list, { LTcr: "LTbr" }, null, look), 1);
  assert.equal(list[0].life, 255);
});

test("a replace keeps the variation within what the new type has, and a type with none or an unknown one gives variation 0", () => {
  const types: Record<string, { numVar: number }> = { Few: { numVar: 2 }, Many: { numVar: 9 }, None: { numVar: 0 } };
  const entry = (id: string) => ({ id, position: [0, 0, 0], variation: 5 });
  const run = (to: string) => { const e = [entry("Many")]; replaceByType(e, { Many: to }, null, (id) => types[id]); return e[0].variation; };
  assert.equal(run("Few"), 1, "clamped to the last one");
  assert.equal(run("Many"), 5, "control: a type with enough keeps it");
  assert.equal(run("None"), 0, "no variations: 0, not -1");
  assert.equal(run("Unknown"), 0, "a type the lookup doesn't know counts as one variation");
});

test("set_water argument validation refuses mixing points with region or box coordinates", () => {
  const checkWaterArgs = (aitools as { checkWaterArgs?: (args: Record<string, unknown>) => unknown }).checkWaterArgs;
  assert.equal(typeof checkWaterArgs, "function");
  const pts = [[0, 0], [512, 512]];
  assert.throws(() => checkWaterArgs!({ mode: "ford", points: pts, left: 0, bottom: 0 }), /not both/);
  assert.throws(() => checkWaterArgs!({ mode: "ford", points: pts, left: 0, bottom: 0, right: 512, top: 512 }), /not both/);
  assert.throws(() => checkWaterArgs!({ mode: "lake", points: pts, region: "River" }), /not both/);
  assert.throws(() => checkWaterArgs!({ mode: "lake", region: "River", left: 0 }), /not both/);
  assert.throws(() => checkWaterArgs!({ mode: "bogus", points: pts }), /mode must be/);
  assert.throws(() => checkWaterArgs!({ mode: "ford", points: [[0, 0]] }), /at least two/);
  assert.throws(() => checkWaterArgs!({ mode: "ford", points: [[0, Number.NaN], [100, 100]] }), /at least two/);
  assert.throws(() => checkWaterArgs!({ mode: "ford", points: pts, width: 64 }), /at least 128/);
  assert.throws(() => checkWaterArgs!({ mode: "ford", points: pts, width: Number.NaN }), /at least 128/);
  assert.deepEqual(checkWaterArgs!({ mode: "ford", points: pts }), { mode: "ford", points: pts, width: 384 });
  assert.deepEqual(checkWaterArgs!({ mode: "lake", left: 0, bottom: 0, right: 512, top: 512 }), { mode: "lake", points: undefined, width: 384 });
  assert.deepEqual(checkWaterArgs!({ mode: "shallow", region: "Lake" }), { mode: "shallow", points: undefined, width: 384 });
});

test("setWater ford and lake are idempotent when run again over the same line or area", () => {
  const snap = (t: Terrain) => t.corners.map((c) => [c.rawHeight, c.rawWater, c.hasWater]);
  const line = { points: [[256, 256], [1792, 1792]] as [number, number][], width: 512 };
  const tFord = field();
  const c1 = setWater(tFord, line, "ellipse", "ford", []);
  assert.ok(c1.length > 0);
  const after1 = snap(tFord);
  const mid = tFord.corners[8 * 17 + 8];
  assert.ok(mid.hasWater && mid.water - mid.height > 36 && mid.water - mid.height < 40, `ford depth: ${mid.water - mid.height}`);
  assert.deepEqual(setWater(tFord, line, "ellipse", "ford", []), []);
  assert.deepEqual(snap(tFord), after1);

  // Deepening an existing ford into a lake preserves the water surface and becomes idempotent on the next lake call.
  const cDeep = setWater(tFord, line, "ellipse", "lake", []);
  assert.ok(cDeep.length > 0);
  assert.equal(tFord.corners[8 * 17 + 8].rawWater, mid.rawWater);
  assert.ok(tFord.corners[8 * 17 + 8].water - tFord.corners[8 * 17 + 8].height > 100);
  const afterLake = snap(tFord);
  assert.deepEqual(setWater(tFord, line, "ellipse", "lake", []), []);
  assert.deepEqual(snap(tFord), afterLake);

  // Widening an existing ford keeps the middle depth and surface intact.
  const tWiden = field();
  setWater(tWiden, { points: line.points, width: 256 }, "ellipse", "ford", []);
  const narrowMid = tWiden.corners[8 * 17 + 8].rawHeight;
  const narrowWater = tWiden.corners[8 * 17 + 8].rawWater;
  const cWide = setWater(tWiden, line, "ellipse", "ford", []);
  assert.ok(cWide.length > 0);
  assert.equal(tWiden.corners[8 * 17 + 8].rawHeight, narrowMid);
  assert.equal(tWiden.corners[8 * 17 + 8].rawWater, narrowWater);

  // Area (ellipse) lake and ford are also idempotent.
  for (const mode of ["ford", "lake"] as const) {
    const tArea = field();
    assert.ok(setWater(tArea, hill, "ellipse", mode, []).length > 0);
    const snapArea = snap(tArea);
    assert.deepEqual(setWater(tArea, hill, "ellipse", mode, []), []);
    assert.deepEqual(snap(tArea), snapArea);
  }
});
