import assert from "node:assert/strict";
import { test } from "node:test";
import { addAnimProps, objectsInRect, strayInstances, withObjectArt, type Placed, type Skin } from "./objects";

const skin = (file: string): Skin => ({
  kind: "w3u", file, numVar: 1, texId: -1, texFile: "", modelScale: 1, minScale: 1, maxScale: 1, randScale: false, fixedRot: null, uberSplat: "",
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
