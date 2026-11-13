import assert from "node:assert/strict";
import { test } from "node:test";
import { hdSlots } from "../../lib/model/renderer";
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

test("a placeholder takes the part of the set its slot in the HD layer asks for, whatever its own name says", () => {
  // The HD cave (CliffDoodadCave) lists textures 0..2 as Cliff1_ORM, Cliff1_Normal, Cliff1_Diffuse, and its layer
  // takes them in that order as diffuse, normal and ORM: by name it was drawn with the ORM as its colour (white).
  const model = { materials: [{ priorityPlane: 0, flags: 0, layers: [{ filterMode: 0, shadingFlags: 0, textureIds: [0, 1, 2, 3, 4, 5], textureAnimId: -1, coordId: 0, alpha: 1 }] }] };
  const slots = hdSlots(model);
  const names = ["Doodads/Terrain/#ignore_Cliffs/Cliff1_ORM.tif", "Doodads/Terrain/#ignore_Cliffs/Cliff1_Normal.tif", "ReplaceableTextures/Cliff/Cliff1_Diffuse.tif"];
  assert.deepEqual(names.map((p, i) => cliffRetexture(p, CITY, slots.get(i))),
    ["TerrainArt\\CityScape\\City_Cliff1_Diffuse.blp", "TerrainArt\\CityScape\\City_Cliff1_Normal.blp", "TerrainArt\\CityScape\\City_Cliff1_ORM.blp"]);
  // Control: by name alone the first is the ORM.
  assert.equal(cliffRetexture(names[0], CITY), "TerrainArt\\CityScape\\City_Cliff1_ORM.blp");
  // Other paths stay whatever their slot.
  assert.equal(cliffRetexture("Textures/Black32.blp", CITY, "_Diffuse"), "Textures/Black32.blp");
});
