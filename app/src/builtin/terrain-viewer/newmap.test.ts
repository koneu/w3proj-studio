import assert from "node:assert/strict";
import { test } from "node:test";
import { mapChoices, playableOf } from "./newmap";

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

test("water needs ground to drop", () => {
  assert.throws(() => mapChoices({ name: "A", water: "deep", cliffLevel: 1 }, data, folder), /Deep water needs cliffLevel 2/);
  assert.throws(() => mapChoices({ name: "A", water: "shallow", cliffLevel: 0 }, data, folder), /Shallow water needs cliffLevel 1/);
  assert.equal(mapChoices({ name: "A", water: "deep" }, data, folder).water, "deep");
});

test("what can be played of a map", () => {
  assert.deepEqual(playableOf(96, 96), [84, 84]);
  assert.deepEqual(playableOf(32, 64), [20, 52]);
});
