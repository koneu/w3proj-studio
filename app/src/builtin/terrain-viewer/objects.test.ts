import assert from "node:assert/strict";
import { test } from "node:test";
import type { W3Api } from "../../extensions/api";
import { addAnimProps, addMoveTypes, loadSkins, objectsInRect, placement, strayInstances, withObjectArt, type Placed, type Skin } from "./objects";
import { TerrainRenderer } from "./renderer";

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
