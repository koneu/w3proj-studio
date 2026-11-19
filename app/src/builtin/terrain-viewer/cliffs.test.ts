import assert from "node:assert/strict";
import { test } from "node:test";
import { hdSlots } from "../../lib/model/renderer";
import { cliffList, cliffRetexture, defaultCliffToAdd, planCliffs, weDefaultCliffType, type CliffType } from "./cliffs";

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
  const terrain = (cliffTiles: string[]) => ({ cliffTiles });
  // Lordaeron Summer: Grass Cliff, the second in the cliff list (we-compare water-brush-*, 2026-11-13).
  assert.equal(weDefaultCliffType(cliffList(terrain(["CLdi", "CLgr"]), types)), 1);
  // Ashenvale: CAgr, the first here (tests/fixtures/water-brush/ash-shallow.w3e).
  assert.equal(weDefaultCliffType(cliffList(terrain(["CAgr", "CAdi"]), types)), 0);
  assert.equal(weDefaultCliffType(cliffList(terrain([]), types)), -1, "no cliff types on the map");
  assert.equal(weDefaultCliffType(cliffList(terrain(["CLno", "CLgr"]), types)), 1, "after a type the game doesn't define");
});

test("the water brush's cliff type is the tileset's natural cliff, wherever the map's cliff list has it", () => {
  // CliffTypes.slk's rows (w3proj game slk TerrainArt/CliffTypes.slk --col cliffID,cliffModelDir,texFile).
  const row = (cliffID: string, cliffModelDir: string, texFile: string): CliffType =>
    ({ cliffID, cliffModelDir, rampModelDir: "CliffTrans", texDir: "TerrainArt\\X", texFile, groundTile: "Xdrt" });
  const types = new Map([row("CLdi", "Cliffs", "Lords_Cliff0"), row("CLgr", "Cliffs", "Lords_Cliff1"), row("CAgr", "Cliffs", "Ashen_Cliff1"),
    row("CAdi", "Cliffs", "Ashen_Cliff0"), row("CWgr", "Cliffs", "Lordw_Cliff0"), row("CWsn", "Cliffs", "Lordw_Cliff1"),
    row("CYdi", "Cliffs", "City_Cliff0"), row("CYsq", "CityCliffs", "City_Cliff1"), row("CDdi", "Cliffs", "Cave_Cliff0"),
    row("CDsq", "CityCliffs", "Cave_Cliff1"), row("CGdi", "Cliffs", "GCliff0"), row("CGsq", "CityCliffs", "GCliff1"),
    row("CKdi", "Cliffs", "Citadel_Cliff0"), row("CKdt", "CityCliffs", "Citadel_Cliff1")].map((c) => [c.cliffID, c]));
  const pick = (tileset: string, cliffTiles: string[]) => weDefaultCliffType(cliffList({ cliffTiles }, types), tileset, types);
  // we-compare water-dungeon and its probes (branch we-compare-14): the editor typed the water's rim with these.
  assert.equal(pick("D", ["CDdi", "CDsq"]), 0, "Dungeon: Natural Walls, not Cave_Cliff1's Manmade Walls");
  assert.equal(pick("G", ["CGdi", "CGsq"]), 0);
  assert.equal(pick("K", ["CKdi", "CKdt"]), 0);
  assert.equal(pick("L", ["CLdi", "CLgr"]), 1);
  assert.equal(pick("L", ["CLgr", "CLdi"]), 0);
  assert.equal(pick("A", ["CAgr", "CAdi"]), 0);
  assert.equal(pick("L", ["CLdi", "CWsn", "CLgr"]), 2, "the tileset's own, not the first natural second texture (CWsn)");
  assert.equal(pick("L", ["CKdt", "CLgr", "CLdi", "CYsq"]), 1);
  // A list without the tileset's own: the first with the second texture until a stroke appends it (defaultCliffToAdd).
  assert.equal(pick("L", ["CAgr", "CLdi"]), 0);
  assert.equal(pick("D", []), -1);
  // Control: the old rule (first …_Cliff1) took Manmade Walls on Dungeon.
  assert.equal(weDefaultCliffType(cliffList({ cliffTiles: ["CDdi", "CDsq"] }, types)), 1);
});

test("a stroke on the default cliff type appends the tileset's default cliff to a list without it", () => {
  const row = (cliffID: string, cliffModelDir: string, texFile: string): CliffType =>
    ({ cliffID, cliffModelDir, rampModelDir: "CliffTrans", texDir: "TerrainArt\\X", texFile, groundTile: "Xdrt" });
  const types = new Map([row("CLdi", "Cliffs", "Lords_Cliff0"), row("CLgr", "Cliffs", "Lords_Cliff1"), row("CAgr", "Cliffs", "Ashen_Cliff1"),
    row("CAdi", "Cliffs", "Ashen_Cliff0"), row("CDdi", "Cliffs", "Cave_Cliff0"), row("CDsq", "CityCliffs", "Cave_Cliff1")].map((c) => [c.cliffID, c]));
  // we-compare water-cliff-append (branch we-compare-15): CAgr CLdi on Lordaeron Summer saved as CAgr CLdi CLgr, the
  // water's rim typed 2.
  const list = ["CAgr", "CLdi"];
  assert.equal(defaultCliffToAdd(list, "L", types, 15), "CLgr");
  assert.equal(weDefaultCliffType(cliffList({ cliffTiles: [...list, "CLgr"] }, types), "L", types), 2);
  assert.equal(defaultCliffToAdd(["CDsq"], "D", types, 15), "CDdi", "Dungeon's natural walls, not its …Cliff1");
  // Nothing to add: the list has it, wherever; a full list; a tileset with no cliff type of its own.
  assert.equal(defaultCliffToAdd(["CLdi", "CLgr"], "L", types, 15), null);
  assert.equal(defaultCliffToAdd(["CLgr", "CAgr"], "L", types, 15), null);
  assert.equal(defaultCliffToAdd(list, "L", types, 2), null, "no room left: the list keeps its entries");
  assert.equal(defaultCliffToAdd(list, "Q", types, 15), null);
  assert.equal(defaultCliffToAdd([], "A", types, 15), "CAgr", "an empty list gets it too");
});

const LORDAERON = new Map([["CLdi", "Ldrt", "Lords_Cliff0"], ["CLgr", "Lgrs", "Lords_Cliff1"]].map(([cliffID, groundTile, texFile]) =>
  [cliffID, { cliffID, cliffModelDir: "Cliffs", rampModelDir: "CliffTrans", texDir: "TerrainArt\\LordaeronSummer", texFile, groundTile } as CliffType]));
const ids = (list: ReturnType<typeof cliffList>) => list.map((c) => c?.cliffID);

test("cliff type numbers follow the w3e's cliff list, with custom-tilesets 0 and 1, whatever the ground list's order", () => {
  // tests/fixtures/we-specs/make-custom-tilesets.mjs: rev6 has the tileset's own ground list reversed (Lgrs before
  // Ldrt), rev6c also the cliff list the other way round. The World Editor's Grass Cliff is 1 under CLdi CLgr and 0
  // under CLgr CLdi with either flag (we-compare ct0-cliff-grass-rev6-0/-1, -rev6c-0/-1, 2026-11-16).
  const own = ["Ldrt", "Ldro", "Ldrg", "Lrok", "Lgrs", "Lgrd"];
  for (const customTilesetsRaw of [0, 1]) {
    const rev6 = { groundTiles: [...own].reverse(), cliffTiles: ["CLdi", "CLgr"], customTilesetsRaw };
    assert.deepEqual(ids(cliffList(rev6, LORDAERON)), ["CLdi", "CLgr"], `rev6, flag ${customTilesetsRaw}: not the ground list's CLgr CLdi`);
    const rev6c = { ...rev6, cliffTiles: ["CLgr", "CLdi"] };
    assert.deepEqual(ids(cliffList(rev6c, LORDAERON)), ["CLgr", "CLdi"], `rev6c, flag ${customTilesetsRaw}`);
  }
  // A flag-1 file with the usual lists: the same numbers as the ground list gave before.
  const usual = { groundTiles: own, cliffTiles: ["CLdi", "CLgr"], customTilesetsRaw: 1 };
  assert.deepEqual(ids(cliffList(usual, LORDAERON)), ["CLdi", "CLgr"]);
});

test("a cliff type the game doesn't define keeps its place in the list", () => {
  assert.deepEqual(ids(cliffList({ cliffTiles: ["CLno", "CLgr"] }, LORDAERON)), [undefined, "CLgr"]);
  assert.deepEqual(ids(cliffList({ cliffTiles: ["CLdi", "CLgr", "CLno"] }, LORDAERON)), ["CLdi", "CLgr", undefined]);
});

test("cliff models take their type from the cliff list's numbers", () => {
  // One tile with a raised corner, cliff type 0: CLgr's texture when the cliff list starts with CLgr, though the
  // ground list has Ldrt (CLdi's) first.
  const c = (layer: number) => ({ height: 0, water: 0, texture: 0, variation: 0, cliffVariation: 0, cliffTexture: 0, layer,
    ramp: false, blight: false, hasWater: false, boundary: false, rawHeight: 0x2000, rawWater: 0x2000, texExtra: 0 });
  const t = { version: 11, tileset: "L", customTilesets: false, customTilesetsRaw: 0, groundTiles: ["Ldrt", "Lgrs"], cliffTiles: ["CLgr", "CLdi"],
    width: 2, height: 2, offsetX: 0, offsetY: 0, corners: [c(2), c(2), c(3), c(2)], trailer: new Uint8Array(0) };
  const textures = (t2: typeof t) => planCliffs(t2, LORDAERON, () => true).requests.map((r) => r.replaceable?.[11]);
  assert.deepEqual(textures(t), ["TerrainArt\\LordaeronSummer\\Lords_Cliff1.blp"]);
  assert.deepEqual(textures({ ...t, cliffTiles: ["CLdi", "CLgr"] }), ["TerrainArt\\LordaeronSummer\\Lords_Cliff0.blp"], "control: the other order");
});
