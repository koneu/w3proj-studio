import assert from "node:assert/strict";
import { test } from "node:test";
import { constantWarning, readGameplayLimits, type FieldLookup, type GameplayLimits } from "./constlimits";

// Made up like the game's files: MiscGame.txt has the speeds, MiscData.txt has other things (and here a
// different MaxUnitSpeed, which must lose to MiscGame's).
const GAME = ["[Misc]\r\n// min unit speed\r\nMinUnitSpeed=150\r\nMaxUnitSpeed=400\r\nMinBldgSpeed=25\r\nMaxBldgSpeed=400 // buildings\r\n", "[Misc]\nMaxUnitSpeed=999\nInvisSpeed=0.4\n"];

test("the game's defaults: the first file with a value wins", () => {
  assert.deepEqual(readGameplayLimits(null, GAME), {
    MaxUnitSpeed: { value: 400, from: "game" }, MinUnitSpeed: { value: 150, from: "game" },
    MaxBldgSpeed: { value: 400, from: "game" }, MinBldgSpeed: { value: 25, from: "game" },
  });
});

test("the map's Gameplay Constants come first, whatever the key's case", () => {
  const l = readGameplayLimits("[Misc]\nmaxunitspeed=500\n", GAME);
  assert.deepEqual(l.MaxUnitSpeed, { value: 500, from: "map" });
  assert.deepEqual(l.MinUnitSpeed, { value: 150, from: "game" });
});

test("a map value that isn't a number leaves the constant unknown, not the game's", () => {
  const l = readGameplayLimits("[Misc]\nMaxUnitSpeed=fast\n", GAME);
  assert.equal(l.MaxUnitSpeed, undefined);
  assert.deepEqual(l.MinUnitSpeed, { value: 150, from: "game" });
});

test("other sections and unreadable game files give nothing", () => {
  assert.deepEqual(readGameplayLimits("[Other]\nMaxUnitSpeed=10\n", []), {});
  assert.deepEqual(readGameplayLimits(null, ["", "garbage\0\u0001"]), {});
});

const lookup = (fields: Record<string, number | [number, boolean]>): FieldLookup => (id) => {
  const f = fields[id];
  if (f === undefined) return undefined;
  return Array.isArray(f) ? { value: f[0], set: f[1] } : { value: f, set: false };
};
const LIMITS: GameplayLimits = readGameplayLimits(null, GAME);

test("Movement Speed past MaxUnitSpeed warns; at it, below it or 0 doesn't", () => {
  const unit = lookup({ ubdg: 0, umas: 0, umis: 0 });
  const w = constantWarning("umvs", 450, true, LIMITS, unit);
  assert.ok(w && /400 at most/.test(w.text) && /Unit Speed - Maximum/.test(w.text) && /game's default/.test(w.text), w?.text);
  assert.equal(w.setByMap, true);
  for (const v of [400, 300, 150, 0, "", "x"]) assert.equal(constantWarning("umvs", v, true, LIMITS, unit), null, String(v));
});

test("below MinUnitSpeed warns, unless the unit's own minimum allows it", () => {
  assert.match(constantWarning("umvs", 100, true, LIMITS, lookup({ umis: 0 }))?.text ?? "", /150 at least/);
  assert.equal(constantWarning("umvs", 100, true, LIMITS, lookup({ umis: 100 })), null);
});

test("the unit's own Speed Maximum replaces the constant when it isn't 0", () => {
  assert.equal(constantWarning("umvs", 405, false, LIMITS, lookup({ umas: 522 })), null);
  const w = constantWarning("umvs", 450, false, LIMITS, lookup({ umas: [420, true] }));
  assert.ok(w && /420 at most/.test(w.text) && /Speed Maximum \(umas\)/.test(w.text), w?.text);
  assert.equal(w.setByMap, true, "the map set the unit's maximum");
});

test("buildings go by the building constants", () => {
  const map = readGameplayLimits("[Misc]\nMaxBldgSpeed=50\n", GAME);
  const w = constantWarning("umvs", 60, false, map, lookup({ ubdg: 1 }));
  assert.ok(w && /50 at most/.test(w.text) && /Building Speed - Maximum, set by this map/.test(w.text), w?.text);
  assert.equal(w.setByMap, true, "the map's constant");
  assert.equal(constantWarning("umvs", 200, false, map, lookup({ ubdg: 0 })), null, "a unit: 400");
  assert.match(constantWarning("umvs", 60, false, map, lookup({ ubdg: 0 }))?.text ?? "", /150 at least/, "a unit: 150 at least");
  assert.equal(constantWarning("umvs", 30, false, LIMITS, lookup({ ubdg: 1 })), null, "25 for buildings, not 150");
});

test("an inherited value past the game's own default isn't the map's", () => {
  assert.equal(constantWarning("umvs", 450, false, LIMITS, lookup({}))?.setByMap, false);
});

test("an unknown constant says nothing; other fields have no such limit", () => {
  assert.equal(constantWarning("umvs", 9999, true, {}, lookup({})), null);
  assert.equal(constantWarning("ulev", 9999, true, LIMITS, lookup({})), null);
});
