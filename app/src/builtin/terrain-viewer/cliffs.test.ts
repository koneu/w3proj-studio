import assert from "node:assert/strict";
import { test } from "node:test";
import { cliffRetexture } from "./cliffs";

const CITY = { texDir: "TerrainArt\\CityScape", texFile: "City_Cliff1" };

test("Reforged cliff models' placeholder textures become the cliff type's HD set, the City cliffs' too", () => {
  // Doodads\Terrain\Cliffs (HD): #ignore_Cliffs placeholders.
  assert.equal(cliffRetexture("Doodads/Terrain/#ignore_Cliffs/Cliff1_Diffuse.tif", CITY), "TerrainArt\\CityScape\\City_Cliff1_Diffuse.blp");
  // Doodads\Terrain\CityCliffs (HD) name ReplaceableTextures\Cliff\Cliff1_…, which the game doesn't store: OrcX02_03's
  // city walls were white.
  assert.equal(cliffRetexture("ReplaceableTextures/Cliff/Cliff1_Diffuse.tif", CITY), "TerrainArt\\CityScape\\City_Cliff1_Diffuse.blp");
  assert.equal(cliffRetexture("ReplaceableTextures\\Cliff\\Cliff0_ORM.tif", CITY), "TerrainArt\\CityScape\\City_Cliff1_ORM.blp");
  // Real files stay: the legacy cliff textures, and anything else.
  assert.equal(cliffRetexture("ReplaceableTextures/Cliff/Cliff1Legacy_Diffuse.dds", CITY), "ReplaceableTextures/Cliff/Cliff1Legacy_Diffuse.dds");
  assert.equal(cliffRetexture("Textures/Black32.blp", CITY), "Textures/Black32.blp");
});
