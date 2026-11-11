import assert from "node:assert/strict";
import { test } from "node:test";
import { checkState, setListValue, shownValue, type EditorType } from "./fields";

const raceType: EditorType = { shape: "single", entries: [
  { value: "human", label: "Human", alts: [] }, { value: "nightelf", label: "Night Elf", alts: [] },
] };

test("what a choice, list or flags value shows as", () => {
  assert.equal(shownValue(raceType, "nightelf"), "Night Elf");
  assert.equal(shownValue(raceType, "NightElf"), "Night Elf", "in any case");
  assert.equal(shownValue(raceType, "naga"), undefined, "no label for an unknown value");
  assert.equal(shownValue(undefined, "nightelf"), undefined, "a field without a type");
  assert.equal(shownValue(raceType, undefined), undefined);
  const list: EditorType = { shape: "list", entries: [
    { value: "giant", label: "Giant", alts: [] }, { value: "undead", label: "Undead", alts: ["Undead_a"] },
  ] };
  assert.equal(shownValue(list, "giant,undead_a"), "Giant, Undead", "alternative spellings too");
  assert.equal(shownValue(list, "giant,odd"), "Giant, odd", "an unknown item stays as it is");
  assert.equal(shownValue(list, "_"), undefined, "an empty list");
  const flags: EditorType = { shape: "flags", entries: [
    { value: "0", label: "Ground", alts: [] }, { value: "2", label: "Air", alts: [] },
  ] };
  assert.equal(shownValue(flags, "5"), "Ground, Air");
  assert.equal(shownValue(flags, "0"), undefined);
});

test("a list entry goes in and out, with its other spellings", () => {
  assert.equal(setListValue("giant,undead", "worker", [], true), "giant,undead,worker");
  assert.equal(setListValue("giant, undead", "undead", [], false), "giant");
  assert.equal(setListValue("Giant", "giant", [], true), "giant");
  assert.equal(setListValue("aliv,enemy", "alive", ["aliv"], false), "enemy");
  assert.equal(setListValue("_", "giant", [], true), "giant");
  assert.equal(setListValue("giant", "giant", [], false), "");
});

test("a box for several objects: all, none, or some of them", () => {
  const has = (v: string) => v.includes("x");
  assert.deepEqual(checkState(["x", "xy"], has), { checked: true, indeterminate: false });
  assert.deepEqual(checkState(["a", "b"], has), { checked: false, indeterminate: false });
  assert.deepEqual(checkState(["x", "b"], has), { checked: false, indeterminate: true });
  assert.deepEqual(checkState([], has), { checked: false, indeterminate: false });
});
