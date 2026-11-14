import assert from "node:assert/strict";
import { test } from "node:test";
import { hdSlots } from "../../lib/model/renderer";
import { cliffList, cliffRetexture, weDefaultCliffType, type CliffType } from "./cliffs";

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

test("new cliffs and water start on the cliff type the World Editor's palette starts on", () => {
  // CliffTypes.slk's rows for Lordaeron Summer and Ashenvale (w3proj game slk TerrainArt/CliffTypes.slk).
  const row = (cliffID: string, dir: string, texFile: string, groundTile: string): CliffType =>
    ({ cliffID, cliffModelDir: "Cliffs", rampModelDir: "CliffTrans", texDir: `TerrainArt\\${dir}`, texFile, groundTile });
  const types = new Map([row("CLdi", "LordaeronSummer", "Lords_Cliff0", "Ldrt"), row("CLgr", "LordaeronSummer", "Lords_Cliff1", "Lgrs"),
    row("CAgr", "Ashenvale", "Ashen_Cliff1", "Agrs"), row("CAdi", "Ashenvale", "Ashen_Cliff0", "Adrt")].map((c) => [c.cliffID, c]));
  const terrain = (groundTiles: string[]) => ({ groundTiles }) as Parameters<typeof cliffList>[0];
  // Lordaeron Summer: Grass Cliff, the second by the ground tiles (we-compare water-brush-*, 2026-11-13).
  assert.equal(weDefaultCliffType(cliffList(terrain(["Ldrt", "Ldro", "Ldrg", "Lrok", "Lgrs", "Lgrd"]), types)), 1);
  // Ashenvale: CAgr, the first here (tests/fixtures/water-brush/ash-shallow.w3e).
  assert.equal(weDefaultCliffType(cliffList(terrain(["Agrs", "Adrt"]), types)), 0);
  assert.equal(weDefaultCliffType(cliffList(terrain(["Ldro"]), types)), -1, "no cliff on the map's tiles");
});
