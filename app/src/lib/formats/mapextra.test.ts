import assert from "node:assert/strict";
import { test } from "node:test";
import { readMapExtra, writeMapExtra } from "./mapextra";

// The editor's own saves (branch map-settings-we, 2026-11-14): the JassHelper menu's switches one after another, then
// Map Properties > Prefs (Felwood Sky, Fixed - Dusk, Enforce Terrain Limits) on top.
const WE_JASSHELPER = "[MapExtraInfo]\nEnableJassHelper=true\n\n";
const WE_DEBUG = "[MapExtraInfo]\nEnableJassHelper=true\nEnableJassHelperDebug=true\n\n";
const WE_ALL_JASSHELPER = "[MapExtraInfo]\nEnableJassHelper=true\nEnableJassHelperDebug=true\nEnableJassHelperOptimizer=true\nEnableJassHelperVJass=false\n\n";
const WE_EVERYTHING = "[MapExtraInfo]\nEnableJassHelper=true\nEnableJassHelperDebug=true\nEnableJassHelperOptimizer=true\nEnableJassHelperVJass=false\n"
  + "EnforceTerrainLimits=true\nSkyModel=2\nTimeOfDay=3\n\n";

test("the editor's files read as the switches that were set", () => {
  assert.deepEqual(readMapExtra(""), {});
  assert.deepEqual(readMapExtra(WE_JASSHELPER), { jassHelper: true });
  assert.deepEqual(readMapExtra(WE_EVERYTHING), { jassHelper: true, debug: true, optimizer: true, vjass: false, enforceTerrainLimits: true, skyModel: 2, timeOfDay: 3 });
  // A campaign map's (Curse of the Forsaken): only the view preferences.
  assert.deepEqual(readMapExtra("[MapExtraInfo]\r\nSkyModel=2\r\nTimeOfDay=4\r\n\r\n"), { skyModel: 2, timeOfDay: 4 });
});

test("keys count case-insensitively, only in [MapExtraInfo], and unreadable values as absent", () => {
  assert.deepEqual(readMapExtra("[Other]\nSkyModel=5\n[mapextrainfo]\nskymodel=7\nENABLEJASSHELPER=TRUE\n"), { skyModel: 7, jassHelper: true });
  assert.deepEqual(readMapExtra("[MapExtraInfo]\nSkyModel=x\nEnableJassHelper=maybe\nTimeOfDay=1\n"), { timeOfDay: 1 });
  assert.deepEqual(readMapExtra("SkyModel=3\n"), {}, "a key before any section isn't the editor's");
});

test("Studio writes the bytes the editor writes, for every step it was measured at", () => {
  assert.equal(writeMapExtra("", { jassHelper: true }), WE_JASSHELPER);
  assert.equal(writeMapExtra(WE_JASSHELPER, { jassHelper: true, debug: true }), WE_DEBUG);
  assert.equal(writeMapExtra("", { jassHelper: true, debug: true, optimizer: true, vjass: false }), WE_ALL_JASSHELPER);
  // Set in another order: the editor's order all the same.
  assert.equal(writeMapExtra("", { timeOfDay: 3, skyModel: 2, enforceTerrainLimits: true, vjass: false, optimizer: true, debug: true, jassHelper: true }), WE_EVERYTHING);
  // JassHelper off: the editor saved an empty file though its menu still had debug and the optimizer ticked.
  assert.equal(writeMapExtra(WE_ALL_JASSHELPER, { jassHelper: false, debug: true, optimizer: true, vjass: false }), "");
});

test("defaults leave their keys out", () => {
  assert.equal(writeMapExtra(WE_DEBUG, { jassHelper: true, debug: false, vjass: true }), WE_JASSHELPER);
  assert.equal(writeMapExtra(WE_EVERYTHING, {}), "");
});

test("a file whose values don't change comes back byte for byte (line ends, order, comments)", () => {
  for (const text of [WE_EVERYTHING, "[MapExtraInfo]\r\nTimeOfDay=4\r\nSkyModel=2\r\n", "; note\n[MapExtraInfo]\nSkyModel=02\n", "", "[MapExtraInfo]\nEnableJassHelper=false\n"]) {
    assert.equal(writeMapExtra(text, readMapExtra(text)), text);
  }
  // Only stored lines count: a switch under JassHelper with JassHelper off writes nothing either way.
  assert.equal(writeMapExtra(WE_JASSHELPER, { jassHelper: true, optimizer: false }), WE_JASSHELPER);
});

test("any text: reading never throws, the same values give it back, and what is written reads back as written", () => {
  const parts = ["[MapExtraInfo]", "[mapextrainfo]", "[Other]", "[", "]", "SkyModel=", "TimeOfDay=", "EnableJassHelper=", "EnableJassHelperDebug=",
    "EnableJassHelperVJass=", "EnforceTerrainLimits=", "Unknown=", "true", "false", "1", "0", "-3", "x", "=", " ", ";c", "\n", "\r\n", "\r", "\u0000", "ä"];
  let seed = 7;
  const rand = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  for (let round = 0; round < 3000; round++) {
    const text = Array.from({ length: rand(24) }, () => parts[rand(parts.length)]).join("");
    const values = readMapExtra(text);
    assert.equal(writeMapExtra(text, values), text, JSON.stringify(text));
    const wanted = { jassHelper: rand(2) === 1 || undefined, debug: rand(2) === 1 || undefined, vjass: rand(3) === 0 ? false : undefined, skyModel: rand(3) ? rand(23) : undefined, timeOfDay: rand(2) ? rand(5) : undefined };
    const written = writeMapExtra(text, wanted);
    const back = readMapExtra(written);
    assert.equal(writeMapExtra(written, back), written, JSON.stringify([text, wanted]));
    assert.equal(back.skyModel, wanted.skyModel, JSON.stringify([text, wanted]));
    assert.equal(back.timeOfDay, wanted.timeOfDay);
    assert.equal(back.jassHelper, wanted.jassHelper);
    assert.equal(back.debug, wanted.jassHelper ? wanted.debug : undefined, "the switches under JassHelper only with it on");
  }
});

test("keys and sections the editor doesn't know stay", () => {
  const text = "[MapExtraInfo]\nSkyModel=2\nCustomDataSource=x.txt\n\n[Notes]\nA=1\n";
  assert.equal(writeMapExtra(text, { skyModel: 4 }), "[MapExtraInfo]\nSkyModel=4\nCustomDataSource=x.txt\n\n[Notes]\nA=1\n");
  assert.equal(writeMapExtra(text, {}), "[MapExtraInfo]\nCustomDataSource=x.txt\n\n[Notes]\nA=1\n");
});
