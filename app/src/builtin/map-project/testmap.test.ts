import assert from "node:assert/strict";
import { test } from "node:test";
import { testMapArgs, testMapOptions } from "./testmap";

const settings = (values: Record<string, unknown>) => ({ get: <T>(key: string, fallback?: T) => (key in values ? values[key] : fallback) as T });

test("nothing set: what Test Map always passed", () => {
  assert.deepEqual(testMapArgs(testMapOptions(settings({}))), ["-mapdiff", "1", "-testmapprofile", "WorldEdit", "-fixedseed", "1"]);
});

test("every option, in the World Editor's order", () => {
  const o = testMapOptions(settings({
    "testMap.difficulty": "hard", "testMap.profile": " Tester ", "testMap.windowMode": "windowedFullscreen", "testMap.assetMode": "sd",
    "testMap.teenData": "off", "testMap.fixedSeed": false, "testMap.noFocusPause": true,
  }));
  assert.deepEqual(testMapArgs(o), ["-windowmode", "windowedfullscreen", "-hd", "0", "-teen", "0", "-nowfpause", "-mapdiff", "2", "-testmapprofile", "Tester"]);
});

test("asset modes and window modes map to the game's values; default leaves the flag out", () => {
  assert.deepEqual(testMapArgs({ assetMode: "hd" }).slice(0, 2), ["-hd", "1"]);
  assert.deepEqual(testMapArgs({ assetMode: "de" }).slice(0, 2), ["-hd", "2"]);
  assert.deepEqual(testMapArgs({ windowMode: "fullscreen", teenData: "on" }).slice(0, 4), ["-windowmode", "fullscreen", "-teen", "1"]);
  assert.ok(!testMapArgs({ assetMode: "default", windowMode: "default", teenData: "default" }).some((a) => ["-hd", "-windowmode", "-teen"].includes(a)));
  assert.deepEqual(testMapArgs({ difficulty: "easy" }).slice(0, 2), ["-mapdiff", "0"]);
});

test("an empty profile is the player's own: no flag", () => {
  assert.ok(!testMapArgs({ profile: "" }).includes("-testmapprofile"));
});

test("a wrong value is refused with the setting's name", () => {
  assert.throws(() => testMapArgs({ assetMode: "4k" }), /testMap\.assetMode can't be "4k"/);
  assert.throws(() => testMapArgs({ difficulty: "insane" }), /testMap\.difficulty/);
  assert.throws(() => testMapArgs({ profile: "-loadfile" }), /testMap\.profile/);
});
