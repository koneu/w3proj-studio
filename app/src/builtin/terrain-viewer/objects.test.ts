import assert from "node:assert/strict";
import { test } from "node:test";
import type { W3Api } from "../../extensions/api";
import { addAnimProps, addMoveTypes, loadSkins, objectsInRect, placeholderInstances, placement, skinParses, strayInstances, withObjectArt, type Placed, type Skin } from "./objects";
import { TerrainRenderer } from "./renderer";
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
  assert.deepEqual(strays.map((s) => s.inst.pick!.id), ["zzzz", "hfoo"], "start locations stay markers");
  assert.equal(strays[0].inst.pick!.kind, "w3u");
  assert.equal(strays[1].inst.pick!.kind, "w3u", "a known type keeps its kind");
  assert.equal(strays[0].inst.pick!.index, 0);
  assert.equal(strays[0].inst.pick!.placed, unknown);
  assert.equal(strayInstances("doodads", [unknown], [unknown], skins, () => 0)[0].inst.pick!.kind, "w3d");
  // The projection: world x/y straight to pixels.
  const project = (p: [number, number, number]): [number, number] => [p[0], p[1]];
  const hidden = new Set<string>(), kinds = new Set(["w3u", "w3d"]);
  assert.deepEqual(objectsInRect(strays, project, hidden, kinds, 0, 0, 200, 200), [unknown]);
  assert.deepEqual(objectsInRect(strays, project, hidden, kinds, 200, 200, 400, 400), [failed], "corners in any order");
  assert.deepEqual(objectsInRect(strays, project, new Set(["units"]), kinds, 0, 0, 400, 400), [], "a hidden group");
  assert.deepEqual(objectsInRect(strays, project, hidden, new Set(["w3t"]), 0, 0, 400, 400), [], "kinds not wanted");
  assert.deepEqual(objectsInRect(strays, () => null, hidden, kinds, 0, 0, 400, 400), [], "behind the camera");
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
