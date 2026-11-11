import assert from "node:assert/strict";
import { test } from "node:test";
import { mapChoices, mapInfo, newTerrain, playableOf, type NewMapOptions } from "./newmap";

const data = {
  sets: [
    { id: "L", name: "Lordaeron Summer", tiles: [{ id: "Ldrt", name: "Dirt" }, { id: "Lgrs", name: "Grass" }, { id: "Lgrd", name: "Grassy Dirt" }], cliffs: ["CLdi"] },
    { id: "D", name: "Dungeon", tiles: [{ id: "Ddrt", name: "Dirt" }, { id: "Dbrk", name: "Brick" }], cliffs: [] },
  ],
  all: [{ id: "Ldrt", name: "Dirt" }, { id: "Lgrs", name: "Grass" }, { id: "Lgrd", name: "Grassy Dirt" }, { id: "Ddrt", name: "Dirt" }, { id: "Dbrk", name: "Brick" }],
  cliffsOn: (tiles: string[]) => (tiles.includes("Ldrt") ? ["CLdi"] : []),
};
const folder = "C:\\maps";

test("a name is enough next to an open project, with the dialog's defaults", () => {
  const o = mapChoices({ name: "  Green Hills " }, data, folder);
  assert.equal(o.name, "Green Hills");
  assert.equal(o.dir, "C:\\maps\\Green Hills");
  assert.deepEqual([o.width, o.height, o.tileset, o.layer, o.water, o.noise, o.lua], [96, 96, "L", 2, "none", false, false]);
  assert.deepEqual(o.groundTiles, ["Ldrt", "Lgrs", "Lgrd"]);
  assert.deepEqual(o.cliffTiles, ["CLdi"]);
  assert.equal(o.customTiles, false);
  assert.equal(o.baseTile, "Lgrs", "exactly Grass, before Grassy Dirt");
});

test("a tileset without grass starts on its first tile", () => {
  assert.equal(mapChoices({ name: "Crypt", tileset: "D" }, data, folder).baseTile, "Ddrt");
});

test("the folder name can't escape its parent or break Windows", () => {
  const o = mapChoices({ name: "..\\..\\Windows: bad?.", folder: "D:/work/" }, data, null);
  assert.equal(o.dir, "D:/work\\....Windows bad");
  assert.equal(o.name, "..\\..\\Windows: bad?.", "the map keeps its name; only the folder is cleaned");
});

test("without an open project a folder is needed, and a full one", () => {
  assert.throws(() => mapChoices({ name: "A" }, data, null), /give folder/);
  assert.throws(() => mapChoices({ name: "A", folder: "maps" }, data, null), /full path/);
  assert.throws(() => mapChoices({ name: "A", folder: "..\\up" }, data, folder), /full path/);
  assert.equal(mapChoices({ name: "A", folder: "\\\\pc\\share" }, data, null).dir, "\\\\pc\\share\\A");
});

test("wrong choices say what's possible", () => {
  assert.throws(() => mapChoices({ name: " " }, data, folder), /needs a name/);
  assert.throws(() => mapChoices({ name: "A", width: 100 }, data, folder), /width must be one of 32, 64/);
  assert.throws(() => mapChoices({ name: "A", height: 512 }, data, folder), /height must/);
  assert.throws(() => mapChoices({ name: "A", tileset: "Q" }, data, folder), /L \(Lordaeron Summer\), D \(Dungeon\)/);
  assert.throws(() => mapChoices({ name: "A", baseTile: "Dbrk" }, data, folder), /Ldrt \(Dirt\)/);
  assert.throws(() => mapChoices({ name: "A", cliffLevel: 15 }, data, folder), /0 to 14/);
  assert.throws(() => mapChoices({ name: "A", script: "python" }, data, folder), /jass or lua/);
  assert.throws(() => mapChoices({ name: "A", water: "lava" }, data, folder), /none, shallow or deep/);
});

test("water goes on any cliff level: the ground stays where it is", () => {
  assert.equal(mapChoices({ name: "A", water: "deep", cliffLevel: 0 }, data, folder).water, "deep");
  assert.equal(mapChoices({ name: "A", water: "shallow" }, data, folder).water, "shallow");
});

const choices = (more: Partial<NewMapOptions>): NewMapOptions =>
  ({ width: 64, height: 64, tileset: "L", groundTiles: ["Ldrt"], cliffTiles: [], baseTile: "Ldrt", layer: 2, water: "none", noise: false, customTiles: false, name: "A", author: "", description: "", lua: false, dir: "C:\\maps\\A", ...more });

// World Editor 7003's new 64 × 64 maps, saved by we-drive (2026-11-11): flat ground at the chosen level, every corner
// flagged as water, the stored level 0x2200 shallow and 0x2400 deep at level 2, 0x2800 deep at level 4.
test("a new map on water keeps its ground at the cliff level, the surface 38.4 (shallow) or 166.4 (deep) above", () => {
  for (const [water, layer, raw] of [["shallow", 2, 0x2200], ["deep", 2, 0x2400], ["deep", 4, 0x2800], ["shallow", 0, 0x1e00]] as const) {
    const t = newTerrain(choices({ water, layer }));
    const what = `${water} at level ${layer}`;
    assert.ok(t.corners.every((c) => c.layer === layer && c.rawHeight === 0x2000), `${what}: the ground stays flat at its level`);
    assert.ok(t.corners.every((c) => c.hasWater && (c.rawWater & 0x3fff) === raw), `${what}: every corner is water, stored 0x${raw.toString(16)}`);
    const c = t.corners[0];
    assert.ok(Math.abs(c.water - c.height - (water === "deep" ? 166.4 : 38.4)) < 1e-9, `${what}: the surface over the ground`);
  }
  const dry = newTerrain(choices({}));
  assert.ok(dry.corners.every((c) => !c.hasWater && c.layer === 2 && (c.rawWater & 0x3fff) === 0x2000), "no water: dry, the level as the editor's");
});

test("a new map on water isn't a melee map, as the World Editor's (its start is in an invalid position)", () => {
  const melee = (o: NewMapOptions) => ((mapInfo(o, newTerrain(o)) as { flags: number }).flags & 4) !== 0;
  assert.equal(melee(choices({})), true);
  assert.equal(melee(choices({ noise: true })), true);
  assert.equal(melee(choices({ water: "shallow" })), false);
  assert.equal(melee(choices({ water: "deep", layer: 5 })), false);
  assert.equal((mapInfo(choices({ water: "shallow" }), newTerrain(choices({ water: "shallow" }))) as { flags: number }).flags, 0x9c10, "only Melee goes");
});

/** Heights of a terrain's corners in world units, by rows. */
const heightStats = (t: ReturnType<typeof newTerrain>) => {
  const z = t.corners.map((c) => (c.rawHeight - 0x2000) / 4);
  const mean = z.reduce((a, b) => a + b, 0) / z.length;
  const sd = Math.sqrt(z.reduce((a, b) => a + (b - mean) ** 2, 0) / z.length);
  let step = 0, steps = 0, lag1 = 0, lag3 = 0, n1 = 0, n3 = 0;
  for (let y = 0; y < t.height; y++) for (let x = 0; x < t.width; x++) {
    const at = (i: number, j: number) => z[(y + j) * t.width + x + i];
    if (x + 1 < t.width) { step += Math.abs(at(1, 0) - at(0, 0)); steps++; lag1 += (at(1, 0) - mean) * (at(0, 0) - mean); n1++; }
    if (y + 1 < t.height) { step += Math.abs(at(0, 1) - at(0, 0)); steps++; }
    if (x + 3 < t.width) { lag3 += (at(3, 0) - mean) * (at(0, 0) - mean); n3++; }
  }
  return { min: Math.min(...z), max: Math.max(...z), sd, step: step / steps, lag1: lag1 / n1 / sd ** 2, lag3: lag3 / n3 / sd ** 2 };
};

// World Editor 7003's random height field on a new 64 × 64 map (we-drive save, 2026-11-11): -51 to 47.25, standard
// deviation 18.25, mean neighbour step 16.6, correlation 0.37 with the next corner, 0.00 three on.
test("random hills are as rough as the World Editor's random height field", () => {
  let seed = 1;
  const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  for (const size of [64, 256]) {
    const s = heightStats(newTerrain(choices({ noise: true, width: size, height: size }), random));
    const what = `${size} × ${size}: ${JSON.stringify(s)}`;
    assert.ok(s.step > 15 && s.step < 18.5, `${what}: neighbour step about 16.6`);
    assert.ok(s.sd > 16.5 && s.sd < 20, `${what}: deviation about 18.25`);
    assert.ok(s.min > -64 && s.min < -40 && s.max < 64 && s.max > 40, `${what}: about ±50`);
    assert.ok(s.lag1 > 0.3 && s.lag1 < 0.45 && Math.abs(s.lag3) < 0.06, `${what}: lightly blurred white noise`);
  }
  const flat = heightStats(newTerrain(choices({})));
  assert.deepEqual([flat.min, flat.max], [0, 0], "no hills: flat");
});

test("a new map marks its border, or the game and the World Editor don't darken it", () => {
  const t = newTerrain({ width: 32, height: 32, tileset: "L", groundTiles: ["Ldrt"], cliffTiles: [], baseTile: "Ldrt", layer: 2, water: "none", noise: false, customTiles: false } as unknown as NewMapOptions);
  const marked = t.corners.filter((c) => c.rawWater & 0x4000).length;
  const [w, h] = playableOf(32, 32);
  assert.equal(marked, 32 * 32 - w * h);
});

test("what can be played of a map", () => {
  assert.deepEqual(playableOf(96, 96), [84, 84]);
  assert.deepEqual(playableOf(32, 64), [20, 52]);
});
