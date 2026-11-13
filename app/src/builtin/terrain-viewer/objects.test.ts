import assert from "node:assert/strict";
import { test } from "node:test";
import type { W3Api } from "../../extensions/api";
import { addAnimProps, addClickHelpers, addMoveTypes, drawnTeam, loadSkins, objectsInRect, placeholderInstances, placement, selectableObjects, skinParses, strayInstances, unitsEntryKind, withObjectArt, type Placed, type Skin } from "./objects";
import { TerrainRenderer, type ObjectInstance } from "./renderer";
import { placeholderModel } from "../../lib/model/placeholder";
import { bounds } from "../../lib/model/renderer";

const near = (a: number, b: number, tol: number, what: string) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} not within ${tol} of ${b}`);

const skin = (file: string): Skin => ({
  kind: "w3u", file, numVar: 1, texId: -1, texFile: "", modelScale: 1, minScale: 1, maxScale: 1, randScale: false, fixedRot: null, uberSplat: "",
});

test("the skin tables are asked for at once, and the later table still wins whichever lands first", async () => {
  // The map's models wait for these: one after another, each waited its turn in the game's read queue.
  const files: Record<string, string> = {
    "Doodads\\DoodadSkins.txt": "[LTlt]\nfile=Doodads\\Tree",
    "Units\\UnitSkin.txt": "[hfoo]\nfile=Units\\Footman\nfile:hd=Units\\FootmanHD",
    "Units\\ItemSkin.txt": "[hfoo]\nfile=Items\\NotAFootman",
    "Units\\HumanUnitFunc.txt": "[hfoo]\nAnimprops=upgrade,first",
    "Units\\UnitData.slk": "ID;P\nC;Y1;X1;K\"unitID\"\nC;X2;K\"movetp\"\nC;Y2;X1;K\"hfoo\"\nC;X2;K\"foot\"\nE",
  };
  const pending: { go: () => void }[] = [], asked: string[] = [];
  const w3 = {
    settings: { get: () => "hd" },
    game: { readText: (path: string) => new Promise<string>((resolve, reject) => {
      asked.push(path);
      pending.push({ go: () => (path in files ? resolve(files[path]) : reject(new Error(`not found: ${path}`))) });
    }) },
  } as unknown as W3Api;
  const loading = loadSkins(w3);
  await new Promise((r) => setTimeout(r, 10));
  for (const path of Object.keys(files)) assert.ok(asked.includes(path), `${path} is asked for before any read landed (asked: ${asked.join(", ")})`);
  for (const p of [...pending].reverse()) p.go();
  const skins = await loading;
  assert.equal(skins.get("LTlt")?.file, "Doodads\\Tree");
  assert.equal(skins.get("hfoo")?.file, "Items\\NotAFootman", "the item table comes after the unit table");
  assert.equal(skins.get("hfoo")?.kind, "w3t");
  assert.deepEqual(skins.get("hfoo")?.animProps, ["upgrade", "first"]);
  assert.equal(skins.get("hfoo")?.moveType, "foot");
  assert.ok(skins.has("sloc"));
});

test("a unit table's Animprops land on the skins, whatever the table's spelling", () => {
  const skins = new Map([["hctw", skin("tower")], ["hkee", skin("hall")], ["hwtw", skin("tower")]]);
  addAnimProps(skins, "[hctw]\r\nAnimprops=upgrade,second\r\n[hkee]\t\r\nAnimprops=Upgrade,First\r\n[hwtw]\r\nName=Scout\r\n[nope]\r\nAnimprops=alternate\r\n");
  assert.deepEqual(skins.get("hctw")?.animProps, ["upgrade", "second"]);
  assert.deepEqual(skins.get("hkee")?.animProps, ["upgrade", "first"]);
  assert.equal(skins.get("hwtw")?.animProps, undefined);
  assert.equal(skins.has("nope"), false);
});

test("a custom unit keeps its base's look, and the map's own Animprops win", () => {
  const skins = new Map([["hctw", { ...skin("tower"), animProps: ["upgrade", "second"] }]]);
  const out = withObjectArt(skins, [{ kind: "w3u", custom: [
    { base: "hctw", id: "h000", mods: [] },
    { base: "hctw", id: "h001", mods: [{ field: "uani", value: "upgrade,third" }] },
  ] }]);
  assert.deepEqual(out.get("h000")?.animProps, ["upgrade", "second"]);
  assert.deepEqual(out.get("h001")?.animProps, ["upgrade", "third"]);
  assert.deepEqual(out.get("hctw")?.animProps, ["upgrade", "second"]);
});

const placed = (id: string, x: number, y: number, extra: Partial<Placed> = {}): Placed => ({ id, variation: 0, position: [x, y, 0], angle: 0, scale: [1, 1, 1], ...extra });

test("an object without a model gets a stand-in that a selection box can pick, like one with a model", () => {
  const unknown = placed("zzzz", 100, 100, { player: 0 }), failed = placed("hfoo", 300, 300, { player: 1 }), start = placed("sloc", 100, 100, { player: 0 });
  const list = [unknown, failed, start];
  const skins = new Map([["hfoo", skin("footman")]]);
  const strays = strayInstances("units", list, [unknown, failed, start], skins, () => 0);
  assert.deepEqual(strays.map((s) => s.inst.pick!.id), ["zzzz", "hfoo", "sloc"], "a start location without a model gets a stand-in too");
  assert.equal(strays[0].inst.pick!.kind, "w3u");
  assert.equal(strays[1].inst.pick!.kind, "w3u", "a known type keeps its kind");
  assert.equal(strays[0].inst.pick!.index, 0);
  assert.equal(strays[0].inst.pick!.placed, unknown);
  assert.equal(strayInstances("doodads", [unknown], [unknown], skins, () => 0)[0].inst.pick!.kind, "w3d");
  // The projection: world x/y straight to pixels.
  const project = (p: [number, number, number]): [number, number] => [p[0], p[1]];
  const hidden = new Set<string>(), kinds = new Set(["w3u", "w3d"]);
  assert.deepEqual(objectsInRect(strays, project, hidden, kinds, 0, 0, 200, 200), [unknown, start], "the box takes the start without a model");
  assert.deepEqual(selectableObjects(strays, new Set()).map((o) => o.p), [unknown, failed, start], "Select All includes it");
  assert.deepEqual(objectsInRect(strays, project, hidden, kinds, 200, 200, 400, 400), [failed], "corners in any order");
  assert.deepEqual(objectsInRect(strays, project, new Set(["units"]), kinds, 0, 0, 400, 400), [], "a hidden group");
  assert.deepEqual(objectsInRect(strays, project, hidden, new Set(["w3t"]), 0, 0, 400, 400), [], "kinds not wanted");
  assert.deepEqual(objectsInRect(strays, () => null, hidden, kinds, 0, 0, 400, 400), [], "behind the camera");
});

test("an unknown type in war3mapUnits.doo saved as an item is an item, so an items-only box finds it", () => {
  // As the World Editor writes them: an item with level 0 and target acquisition 0, a unit with level 1 and -1 or -2.
  const item = placed("I0zz", 100, 100, { player: 27, level: 0, targetAcquisition: 0 } as Partial<Placed>);
  const unit = placed("h0zz", 300, 300, { player: 0, level: 1, targetAcquisition: -1 } as Partial<Placed>);
  const camp = placed("n0zz", 500, 500, { player: 24, level: 1, targetAcquisition: -2 } as Partial<Placed>);
  const strays = strayInstances("units", [item, unit, camp], [item, unit, camp], new Map(), () => 0);
  assert.deepEqual(strays.map((s) => s.inst.pick!.kind), ["w3t", "w3u", "w3u"]);
  const project = (p: [number, number, number]): [number, number] => [p[0], p[1]];
  assert.deepEqual(objectsInRect(strays, project, new Set(), new Set(["w3t"]), 0, 0, 600, 600), [item]);
  assert.deepEqual(objectsInRect(strays, project, new Set(), new Set(["w3u"]), 0, 0, 600, 600), [unit, camp]);
  // The type's own kind wins; a start location stays one; a record without those fields stays a unit.
  assert.equal(unitsEntryKind(item, "w3u"), "w3u");
  assert.equal(unitsEntryKind(unit, "w3t"), "w3t");
  assert.equal(unitsEntryKind(placed("sloc", 0, 0, { level: 0, targetAcquisition: 0 } as Partial<Placed>)), "w3u");
  assert.equal(unitsEntryKind(placed("zzzz", 0, 0)), "w3u");
});

test("a click picks an object without a model through its stand-in, as a selection box does", () => {
  const unknown = placed("zzzz", 100, 100, { player: 0 });
  const strays = strayInstances("units", [unknown], [unknown], new Map(), () => 0);
  // The renderer's own pick, on a renderer with no models drawn (it needs no graphics for this).
  const view = { batches: [], hiddenGroups: new Set<string>() };
  const pick = (x: number, y: number, hidden = view.hiddenGroups) =>
    TerrainRenderer.prototype.pickObject.call({ ...view, hiddenGroups: hidden } as unknown as TerrainRenderer,
      { origin: [x, y, 2000], dir: [0, 0, -1] }, () => 24, strays);
  assert.equal(pick(100, 100)?.pick?.placed, unknown, "straight down onto the marker");
  assert.equal(pick(110, 95)?.pick?.placed, unknown, "within its click radius");
  assert.equal(pick(300, 300), null, "the ground beside it");
  assert.equal(pick(100, 100, new Set(["units"])), null, "units hidden");
});

test("a click picks a start location without a model through its stand-in", () => {
  const start = placed("sloc", 500, 500, { player: 0 });
  const strays = strayInstances("units", [start], [start], new Map(), () => 0);
  const pick = (showEditorOnly: boolean) => TerrainRenderer.prototype.pickObject.call(
    { batches: [], hiddenGroups: new Set<string>(), showEditorOnly } as unknown as TerrainRenderer, { origin: [500, 500, 2000], dir: [0, 0, -1] }, () => 24, strays);
  assert.equal(pick(true)?.pick?.placed, start);
  assert.equal(pick(false), null, "not in game view");
});

test("an object whose model doesn't load is the editor's cube: picked over the cube's height, scaled and placed as the object", () => {
  const big = placed("LRsr", 500, 500, { scale: [2, 2, 2] }), small = placed("YOtc", 100, 100);
  const strays = strayInstances("doodads", [big, small], [big, small], new Map(), () => 0);
  const cubes = placeholderInstances(strays, bounds(placeholderModel()));
  assert.deepEqual(cubes.map((c) => c.pick?.placed), [big, small], "the same objects, picked the same way");
  assert.deepEqual(cubes[1].sphere?.slice(0, 3), [100, 100, 64], "round the cube's middle, half its side up");
  near(cubes[1].sphere![3], Math.hypot(64, 64, 64), 1e-3, "the cube's corners inside");
  assert.deepEqual(cubes[0].sphere?.slice(0, 3), [500, 500, 128], "the object's scale scales the cube");
  near(cubes[0].sphere![3], 2 * Math.hypot(64, 64, 64), 1e-3, "and its bounds");
  // A click from the side at the cube's top edge picks it, where a marker's small sphere didn't reach.
  const view = { batches: [{ group: "doodads", instances: cubes }], hiddenGroups: new Set<string>() };
  const side = (z: number) => TerrainRenderer.prototype.pickObject.call(view as unknown as TerrainRenderer, { origin: [100, -2000, z], dir: [0, 1, 0] });
  assert.equal(side(120)?.pick?.placed, small);
  assert.equal(TerrainRenderer.prototype.pickObject.call({ batches: [], hiddenGroups: new Set() } as unknown as TerrainRenderer,
    { origin: [100, -2000, 120], dir: [0, 1, 0] }, undefined, strays), null, "the old stand-in's sphere (32 round the foot) misses there");
  assert.equal(side(400), null, "above it");
});

test("units get their movement type from the unit table, and a map's own movement type wins", () => {
  const skins = new Map([["hbot", skin("transport")], ["hfoo", skin("footman")]]);
  addMoveTypes(skins, [{ unitID: "hbot", movetp: "float" }, { unitID: "hfoo", movetp: "foot" }, { unitID: "nope", movetp: "fly" }, { unitID: "", movetp: "x" }]);
  assert.equal(skins.get("hbot")?.moveType, "float");
  assert.equal(skins.get("hfoo")?.moveType, "foot");
  assert.equal(skins.has("nope"), false);
  const out = withObjectArt(skins, [{ kind: "w3u", original: [{ base: "hfoo", mods: [{ field: "umvt", value: "amph" }] }],
    custom: [{ base: "hbot", id: "h000", mods: [] }, { base: "hbot", id: "h001", mods: [{ field: "umvt", value: "foot" }] }] }]);
  assert.equal(out.get("hfoo")?.moveType, "amph", "a changed standard unit");
  assert.equal(out.get("h000")?.moveType, "float", "a custom unit keeps its base's");
  assert.equal(out.get("h001")?.moveType, "foot");
});

test("doodads get their click helper from Doodads.slk, and a map's own useClickHelper (duch) wins", () => {
  const doodad = (file: string): Skin => ({ ...skin(file), kind: "w3d" });
  const skins = new Map([["YOtf", doodad("fire")], ["LRrk", doodad("rock")], ["ZZdt", doodad("prints")], ["hfoo", skin("footman")]]);
  addClickHelpers(skins, [{ doodID: "YOtf", useClickHelper: "1" }, { doodID: "LRrk", useClickHelper: "0" }, { doodID: "ZZdt", useClickHelper: " 1 " },
    { doodID: "hfoo", useClickHelper: "1" }, { doodID: "nope", useClickHelper: "1" }]);
  assert.equal(skins.get("YOtf")?.clickHelper, true);
  assert.equal(skins.get("ZZdt")?.clickHelper, true);
  assert.equal(skins.get("LRrk")?.clickHelper, undefined);
  assert.equal(skins.get("hfoo")?.clickHelper, undefined, "a unit has none, whatever a row of that id says");
  assert.equal(skins.has("nope"), false);
  const out = withObjectArt(skins, [{ kind: "w3d", original: [{ base: "YOtf", mods: [{ field: "duch", value: 0 }] }],
    custom: [{ base: "ZZdt", id: "D000", mods: [] }, { base: "LRrk", id: "D001", mods: [{ field: "duch", value: 1 }] }] }]);
  assert.equal(out.get("YOtf")?.clickHelper, undefined, "a standard doodad the map changed");
  assert.equal(out.get("D000")?.clickHelper, true, "a custom doodad keeps its base's");
  assert.equal(out.get("D001")?.clickHelper, true);
  assert.equal(skins.get("YOtf")?.clickHelper, true, "the game's skins stay as they were");
});

test("units get their flying height from the unit table, and a map's own wins", () => {
  const skins = new Map([["hgry", skin("gryphon")], ["hfoo", skin("footman")], ["hbad", skin("bad")]]);
  addMoveTypes(skins, [{ unitID: "hgry", movetp: "fly", moveHeight: "240" }, { unitID: "hfoo", movetp: "foot", moveHeight: "0" },
    { unitID: "hbad", movetp: "fly", moveHeight: "high" }]);
  assert.equal(skins.get("hgry")?.moveHeight, 240);
  assert.equal(skins.get("hfoo")?.moveHeight, 0);
  assert.equal(skins.get("hbad")?.moveHeight, undefined, "a value that isn't a number is left out");
  const out = withObjectArt(skins, [{ kind: "w3u", original: [{ base: "hfoo", mods: [{ field: "umvh", value: 300 }] }],
    custom: [{ base: "hgry", id: "h000", mods: [] }, { base: "hgry", id: "h001", mods: [{ field: "umvh", value: 600 }] }] }]);
  assert.equal(out.get("hfoo")?.moveHeight, 300, "a changed standard unit");
  assert.equal(out.get("h000")?.moveHeight, 240, "a custom unit keeps its base's");
  assert.equal(out.get("h001")?.moveHeight, 600);
});

test("a selection box goes by where an object is drawn: a ship on the water above its stored height", () => {
  const ship = placed("hbot", 100, 100, { player: 0 });
  const [stray] = strayInstances("units", [ship], [ship], new Map(), () => 0);
  stray.inst.world = placement(ship, 1, 300);
  // Seen from the side: pixel y is the height.
  const side = (p: [number, number, number]): [number, number] => [p[0], p[2]];
  assert.deepEqual(objectsInRect([stray], side, new Set(), new Set(["w3u"]), 0, 250, 200, 350), [ship]);
  assert.deepEqual(objectsInRect([stray], side, new Set(), new Set(["w3u"]), 0, -50, 200, 50), []);
  // A ship whose model didn't load: its stand-in floats too, picked round where it is drawn.
  const skins = new Map([["hbot", { ...skin("transport"), moveType: "float" }]]);
  const [standIn] = strayInstances("units", [ship], [ship], skins, () => 0, undefined, (p, s) => (s.moveType === "float" ? 300 : p.position[2]));
  assert.equal(standIn.inst.world[14], 300);
  assert.deepEqual(standIn.inst.sphere, [100, 100, 300, 32]);
  assert.deepEqual(ship.position, [100, 100, 0], "the stored height stays");
});

/** A game with the skin tables in `files`; `settings` as the app's. Reads that throw are listed in `broken`. */
const fakeGame = (files: Record<string, string>, settings: Record<string, string>, broken = new Set<string>()) => ({
  settings: { get: (k: string) => settings[k] },
  game: { readText: async (p: string) => {
    if (broken.has(p)) throw new Error("the storage is busy");
    return files[p] ?? "";
  } },
}) as unknown as W3Api;

const gameTables = () => ({
  "Units\\UnitSkin.txt": "[hfoo]\r\nfile=Units\\Human\\Footman\\Footman\r\nfile:sd=Units\\Human\\Footman\\FootmanSD\r\nmodelScale=1.2\r\n",
  "Doodads\\DoodadSkins.txt": "[LTlt]\r\nfile=Doodads\\Tree\r\nnumVar=10\r\n",
  "Units\\HumanUnitFunc.txt": "[hfoo]\r\nAnimprops=upgrade,first\r\n",
  "Units\\UnitData.slk": "ID;PWXL;N;E\r\nC;Y1;X1;K\"unitID\"\r\nC;X2;K\"movetp\"\r\nC;Y2;X1;K\"hfoo\"\r\nC;X2;K\"foot\"\r\nE\r\n",
});

test("a unit type's own team colour wins over its owner's: the tavern's roof is red whoever owns it", async () => {
  // UnitSkin.txt gives the tavern (ntav) and the mercenary camps teamColor 0 and up, the rest -1; the World Editor drew
  // TwistedMeadows' tavern (Neutral Passive) with a red roof where Studio's was black (test round 5, 2026-11-09).
  const files = { ...gameTables(), "Units\\UnitSkin.txt": "[hfoo]\r\nfile=Units\\Footman\r\nteamColor=-1\r\n[ntav]\r\nfile=buildings\\other\\Tavern\\Tavern\r\nteamColor=0\r\n[nmr2]\r\nfile=Camp\r\nteamColor=12\r\n" };
  const skins = await loadSkins(fakeGame(files, { "game.installDir": "/team-colour", "game.graphicsMode": "hd" }));
  assert.equal(skins.get("ntav")?.teamColor, 0);
  assert.equal(skins.get("nmr2")?.teamColor, 12);
  assert.equal(skins.get("hfoo")?.teamColor, undefined, "-1: the owner's");
  assert.equal(drawnTeam(skins.get("ntav")!, 20), 0, "Neutral Passive's tavern: red");
  assert.equal(drawnTeam(skins.get("hfoo")!, 3), 3, "a footman: its owner's");
  // The map's object data (utco) changes it, -1 back to the owner's.
  const out = withObjectArt(skins, [{ kind: "w3u", original: [{ base: "ntav", mods: [{ field: "utco", value: 5 }] }, { base: "nmr2", mods: [{ field: "utco", value: -1 }] }] }]);
  assert.equal(drawnTeam(out.get("ntav")!, 20), 5);
  assert.equal(drawnTeam(out.get("nmr2")!, 7), 7);
});

test("a type whose skin section is spelled in another case is drawn, from its own kind's section only", async () => {
  // Doodads.slk has Yosh, DoodadSkins.txt [YOsh] (Ycgd [YCgd], Lccn [LCcn], …). An item spelled as a doodad in another
  // case isn't the doodad's, and the type's own spelling wins.
  const slk = (key: string, ...ids: string[]) => `ID;PWXL;N;E\r\nC;Y1;X1;K"${key}"\r\n${ids.map((id, i) => `C;Y${i + 2};X1;K"${id}"\r\n`).join("")}E\r\n`;
  const files = {
    ...gameTables(),
    "Doodads\\DoodadSkins.txt": "[YOsh]\r\nskinType=doodad\r\nfile=Doodads\\Ship\r\n[LTlt]\r\nfile=Doodads\\Tree\r\n[LTLT]\r\nfile=Doodads\\Upper\r\n",
    "Doodads\\Doodads.slk": slk("doodID", "Yosh", "LTlt", "Ztst"),
    "Units\\ItemSkin.txt": "[ztst]\r\nskinType=item\r\nfile=Items\\Item\r\n",
    "Units\\ItemData.slk": slk("itemID", "ztst"),
  };
  const skins = await loadSkins(fakeGame(files, { "game.installDir": "/case", "game.graphicsMode": "hd" }));
  assert.equal(skins.get("Yosh")?.file, "Doodads\\Ship");
  assert.equal(skins.get("Yosh")?.kind, "w3d");
  assert.equal(skins.get("LTlt")?.file, "Doodads\\Tree", "the own spelling wins");
  assert.equal(skins.get("Ztst"), undefined, "an item's section isn't a doodad's");
  assert.equal(skins.get("ztst")?.kind, "w3t");
  // A map's custom doodad based on it gets its model too.
  assert.equal(withObjectArt(skins, [{ kind: "w3d", custom: [{ base: "Yosh", id: "D000", mods: [] }] }]).get("D000")?.file, "Doodads\\Ship");
});

test("a placed waygate is drawn in its own colour; a type that doesn't allow one in its owner's", async () => {
  // World Editor 2.0 (we-drive, 2026-11-10, a copy of cliff.w3m): a waygate with colour 4 yellow, one with 2 teal, a
  // waygate type with utcc 0 and colour 4 in Neutral Passive's, a footman type with utcc 1 and colour 6 green, a plain
  // footman with colour 6 red (its owner's).
  const files = { ...gameTables(), "Units\\UnitSkin.txt": "[hfoo]\r\nfile=Units\\Footman\r\ncustomTeamColor=0\r\n[nwgt]\r\nfile=buildings\\other\\WayGate\\WayGate\r\nteamColor=-1\r\ncustomTeamColor=1\r\n" };
  const skins = await loadSkins(fakeGame(files, { "game.installDir": "/custom-colour", "game.graphicsMode": "hd" }));
  assert.equal(skins.get("nwgt")?.customColor, true);
  assert.equal(skins.get("hfoo")?.customColor, undefined);
  assert.equal(drawnTeam(skins.get("nwgt")!, 27, 4), 4);
  assert.equal(drawnTeam(skins.get("nwgt")!, 27, 2), 2);
  assert.equal(drawnTeam(skins.get("nwgt")!, 27, -1), 27, "no colour of its own: the owner's");
  assert.equal(drawnTeam(skins.get("nwgt")!, 27, 24), 27, "not a player colour");
  assert.equal(drawnTeam(skins.get("hfoo")!, 0, 6), 0, "a footman's stored colour isn't drawn");
  const out = withObjectArt(skins, [{ kind: "w3u", custom: [{ id: "h001", base: "hfoo", mods: [{ field: "utcc", value: 1 }] }, { id: "n000", base: "nwgt", mods: [{ field: "utcc", value: 0 }] }] }]);
  assert.equal(drawnTeam(out.get("h001")!, 0, 6), 6);
  assert.equal(drawnTeam(out.get("n000")!, 27, 4), 27);
});

test("the skins are parsed once per install and graphics mode, and come out alike each time", async () => {
  const files = gameTables(), settings = { "game.installDir": "/cache-a", "game.graphicsMode": "hd" };
  const w3 = fakeGame(files, settings);
  const before = skinParses.count;
  const first = await loadSkins(w3);
  assert.equal(first.get("hfoo")?.file, "Units\\Human\\Footman\\Footman");
  assert.deepEqual(first.get("hfoo")?.animProps, ["upgrade", "first"]);
  assert.equal(first.get("hfoo")?.moveType, "foot");
  assert.equal(first.get("LTlt")?.numVar, 10);
  assert.ok(first.has("sloc"));
  first.delete("LTlt");
  const second = await loadSkins(w3);
  assert.equal(skinParses.count - before, 1, "the tables didn't change: parsed once");
  assert.ok(second.has("LTlt"), "each caller gets its own map");
  assert.deepEqual(second, await loadSkins(w3));
  assert.throws(() => { (second.get("hfoo") as Skin).file = "x"; }, "the shared entries can't be changed");

  settings["game.graphicsMode"] = "sd";
  assert.equal((await loadSkins(w3)).get("hfoo")?.file, "Units\\Human\\Footman\\FootmanSD", "another mode, the mode's own keys");
  settings["game.installDir"] = "/cache-b";
  await loadSkins(w3);
  assert.equal(skinParses.count - before, 3, "another mode, another install: parsed again");
});

test("a type with only Classic and HD models has one in the 3.0 art (DE) too: the Ogre Lord of LastRefuge", async () => {
  // UnitSkin.txt names nogl's model only as file:hd and file:sd; with no file:de and no plain file, the DE view drew
  // nothing for it (the user, 2026-11-10). DE falls back to Classic, as the storage's layers do.
  const files = { ...gameTables(), "Units\\UnitSkin.txt": "[nogl]\r\nfile:hd=Units\\Creeps\\OgreLord\\OgreLord\r\nfile:sd=units\\creeps\\OgreLord\\OgreLordSD\r\nmodelScale:hd=1.1\r\nmodelScale:sd=1.3\r\n[nogm]\r\nfile:hd=Units\\Creeps\\OgreMauler\\OgreMauler\r\nfile:sd=units\\creeps\\Ogre\\Ogre\r\nfile:de=units\\creeps\\Ogre\\OgreDE\r\n" };
  const of = async (mode: string) => loadSkins(fakeGame(files, { "game.installDir": "/art-sets", "game.graphicsMode": mode }));
  const de = await of("de");
  assert.equal(de.get("nogl")?.file, "units\\creeps\\OgreLord\\OgreLordSD");
  assert.equal(de.get("nogl")?.modelScale, 1.3);
  assert.equal(de.get("nogm")?.file, "units\\creeps\\Ogre\\OgreDE", "its own key first");
  assert.equal((await of("hd")).get("nogl")?.file, "Units\\Creeps\\OgreLord\\OgreLord");
  assert.equal((await of("sd")).get("nogm")?.file, "units\\creeps\\Ogre\\Ogre");
});

test("a reloaded game's changed table is seen, and a table that couldn't be read isn't kept as empty", async () => {
  const files = gameTables(), settings = { "game.installDir": "/cache-c", "game.graphicsMode": "hd" }, broken = new Set<string>();
  const w3 = fakeGame(files, settings, broken);
  await loadSkins(w3);
  // A patch, then w3.game.reload: the table reads differently.
  files["Units\\UnitSkin.txt"] = files["Units\\UnitSkin.txt"].replace("modelScale=1.2", "modelScale=2");
  assert.equal((await loadSkins(w3)).get("hfoo")?.modelScale, 2);
  // The storage busy for one read: that load goes without the doodads, as before, the next has them again.
  broken.add("Doodads\\DoodadSkins.txt");
  assert.equal((await loadSkins(w3)).has("LTlt"), false);
  broken.clear();
  const before = skinParses.count;
  assert.equal((await loadSkins(w3)).get("LTlt")?.numVar, 10);
  assert.equal(skinParses.count - before, 1);
});

test("a map's object data goes on the game's skins fresh each time, and doesn't stick to them", async () => {
  const w3 = fakeGame(gameTables(), { "game.installDir": "/cache-d", "game.graphicsMode": "hd" });
  const mapped = withObjectArt(await loadSkins(w3), [{ kind: "w3u", original: [{ base: "hfoo", mods: [{ field: "umdl", value: "Units\\Other" }, { field: "uani", value: "alternate" }] }] }]);
  assert.equal(mapped.get("hfoo")?.file, "Units\\Other");
  const again = await loadSkins(w3);
  assert.equal(again.get("hfoo")?.file, "Units\\Human\\Footman\\Footman");
  assert.deepEqual(again.get("hfoo")?.animProps, ["upgrade", "first"]);
  assert.equal(withObjectArt(again, []).get("hfoo")?.file, "Units\\Human\\Footman\\Footman");
});

test("a click picks a start location by its model in the editor's view (not in game view), and Select All takes it with the rest", () => {
  const start = placed("sloc", 100, 100, { player: 0 }), unit = placed("hfoo", 500, 500, { player: 0 });
  const inst = (p: Placed): ObjectInstance => ({ world: placement(p, 1, 0), team: 0, sphere: [p.position[0], p.position[1], 0, 32],
    pick: { kind: "w3u", id: p.id, index: 0, placed: p, model: "m", extraScale: 1 } });
  const batches = [{ group: "units", editorOnly: true, instances: [inst(start)] }, { group: "units", instances: [inst(unit)] }];
  const pick = (showEditorOnly: boolean, x: number, y: number) => TerrainRenderer.prototype.pickObject.call(
    { batches, hiddenGroups: new Set<string>(), showEditorOnly } as unknown as TerrainRenderer,
    { origin: [x, y, 2000], dir: [0, 0, -1] }, () => 24);
  assert.equal(pick(true, 100, 100)?.pick?.placed, start, "the start location");
  assert.equal(pick(true, 500, 500)?.pick?.placed, unit, "the unit beside it still");
  assert.equal(pick(false, 100, 100), null, "not in game view");
  const sources = batches.flatMap((b) => b.instances.map((i) => ({ group: b.group, inst: i })));
  assert.deepEqual(selectableObjects(sources, new Set()).map((o) => o.p), [start, unit], "Select All includes the start location");
  assert.deepEqual(selectableObjects(sources, new Set(["units"])), [], "a hidden group is left out (control)");
});
