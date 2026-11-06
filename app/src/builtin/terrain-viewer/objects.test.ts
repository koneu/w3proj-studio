import assert from "node:assert/strict";
import { test } from "node:test";
import { addAnimProps, withObjectArt, type Skin } from "./objects";

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
