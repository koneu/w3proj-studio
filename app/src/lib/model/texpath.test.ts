import assert from "node:assert/strict";
import { test } from "node:test";
import { gamePartOf, isMachinePath, neverStoredLast, textureCandidates } from "./texpath";

test("the build machine's folder in front of the art folder is dropped", () => {
  assert.equal(gamePartOf("C:/Users/ksizemore/Box/Classic Games/Warcraft3/assets/Art/HD//Doodads/Terrain/CityBridgeExtraLarge0/StoneBridgeWide_Diffuse.tif"),
    "Doodads/Terrain/CityBridgeExtraLarge0/StoneBridgeWide_Diffuse.tif");
  assert.equal(gamePartOf("C:/Users/dok/Perforce/dok_RE-DOK-WD_2049/warcraft3/assets/Art/DE/Buildings/Human/Farm/FarmBirth.mdl"), "Buildings/Human/Farm/FarmBirth.mdl");
  assert.equal(gamePartOf("C:\\Users\\User\\Documents\\Blizzard\\warcraft3\\Art\\DE\\\\Doodads\\Dungeon\\X.tif"), "Doodads/Dungeon/X.tif");
});

test("the game's own mod folders are dropped too", () => {
  assert.equal(gamePartOf("C:/Users/dok/Perforce/x/warcraft3/branches/master/War3.w3mod/_DE.w3mod/Buildings/Undead/UBirth/UBirth.mdl"), "Buildings/Undead/UBirth/UBirth.mdl");
});

test("paths without a drive are game paths already", () => {
  assert.equal(gamePartOf("Textures/CityWall_Diffuse.tif"), "Textures/CityWall_Diffuse.tif");
  assert.equal(gamePartOf("Doodads\\A\\B.blp"), "Doodads/A/B.blp");
  assert.equal(isMachinePath("Textures/a.blp"), false);
  assert.equal(isMachinePath("C:/x/a.blp"), true);
});

test("an absolute path without a game part has none", () => {
  assert.equal(gamePartOf("C:/Users/dok/Downloads/arthas_BH/Blackhood01_Diffuse.tif"), null);
});

test("names the game never stores (.tif) are read last; the first one the game has stays the same", () => {
  assert.deepEqual(neverStoredLast(["D/X.tif", "D/X.dds"]), ["D/X.dds", "D/X.tif"]);
  assert.deepEqual(neverStoredLast(["a\\X.TIF", "a\\X.dds", "b\\X.tif", "b\\X.dds"]), ["a\\X.dds", "b\\X.dds", "a\\X.TIF", "b\\X.tif"]);
  // The shadow map's list: as written, .blp, .dds. A .blp the game has still comes before the .dds.
  assert.deepEqual(neverStoredLast(["X.tif", "X.blp", "X.dds"]), ["X.blp", "X.dds", "X.tif"]);
  // Only .tif: the game has .tiff, .tga and .png files, so those keep their place.
  for (const keep of [["X.blp", "X.dds"], ["X.tga", "X.dds"], ["X.png", "X.dds"], ["X.tiff", "X.dds"], ["X.mdx"]]) assert.deepEqual(neverStoredLast(keep), keep);
  // Every list and every set of stored files: the first stored name found is the same.
  const names = ["p.tif", "p.dds", "q.blp", "q.tif", "q.dds", "r.tga"];
  for (let mask = 0; mask < 1 << names.length; mask++) {
    const stored = new Set(names.filter((n, i) => mask & (1 << i) && !n.endsWith(".tif")));
    const first = (list: string[]) => list.find((n) => stored.has(n));
    assert.equal(first(neverStoredLast(names)), first(names), [...stored].join());
  }
});

test("candidates: as written, then as .dds; with no game part the model's folder, then Textures", () => {
  assert.deepEqual(textureCandidates("C:/a/Art/HD//Doodads/T/X_Diffuse.tif"), ["Doodads/T/X_Diffuse.tif", "Doodads/T/X_Diffuse.dds"]);
  assert.deepEqual(textureCandidates("Textures/Black32.blp"), ["Textures/Black32.blp", "Textures/Black32.dds"]);
  assert.deepEqual(textureCandidates("C:/dl/B/Body.tif", "Units/Human/Arthas/Arthas.mdx"),
    ["Units/Human/Arthas/Body.tif", "Units/Human/Arthas/Body.dds", "Textures/Body.tif", "Textures/Body.dds"]);
  assert.deepEqual(textureCandidates("a.dds"), ["a.dds"]);
});
