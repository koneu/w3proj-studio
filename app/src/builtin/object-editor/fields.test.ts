import assert from "node:assert/strict";
import { test } from "node:test";
import { parseIni } from "../../lib/formats/text";
import { checkState, setListValue, shownValue, tickListValue, worldEditTypes, type EditorType } from "./fields";

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

test("categories, tilesets and lightning effects get their lists from the World Editor's tables", () => {
  const data = parseIni([
    "[TileSets]", "L=WESTRING_LOCALE_LORDAERON_SUMMER,TerrainArt\\Blight\\Lords_Blight", "A=WESTRING_LOCALE_ASHENVALE,x", "//#LINENOBETA", "NumValues=2",
    "[DoodadCategories]", "O=WESTRING_DTYPE_PROPS,ReplaceableTextures\\WorldEditUI\\Doodad-Prop", "Z=WESTRING_GONE,y",
    "[DestructibleCategories]", "B=WESTRING_DTYPE_BRIDGE,z",
  ].join("\n"));
  const strings: Record<string, string> = { WESTRING_LOCALE_LORDAERON_SUMMER: "Lordaeron Summer", WESTRING_LOCALE_ASHENVALE: "Ashenvale", WESTRING_DTYPE_PROPS: "Props", WESTRING_DTYPE_BRIDGE: "Bridges/Ramps" };
  const bolt = { value: "CLPB", label: "Chain Lightning", alts: [] };
  const types = worldEditTypes(data, (k) => strings[k] ?? k, new Map([["lightningEffect", { shape: "single", entries: [bolt] }]]));
  assert.deepEqual(types.get("doodadCategory"), { shape: "single", entries: [{ value: "O", label: "Props", alts: [] }, { value: "Z", label: "Z", alts: [] }] }, "a name the game lacks: the letter");
  assert.deepEqual(types.get("destructableCategory")!.entries.map((e) => e.label), ["Bridges/Ramps"]);
  const sets = types.get("tilesetList")!;
  assert.equal(sets.shape, "list");
  assert.deepEqual(sets.entries.map((e) => `${e.value}=${e.label}`), ["*=All tilesets", "A=Ashenvale", "L=Lordaeron Summer"], "by name, every tileset first; other keys of the section aren't tilesets");
  assert.deepEqual(types.get("lightningList"), { shape: "list", entries: [bolt] });
  assert.equal(shownValue(sets, "L,A"), "Lordaeron Summer, Ashenvale");
  assert.equal(shownValue(sets, "*"), "All tilesets");
  assert.equal(worldEditTypes(new Map(), (k) => k, new Map()).size, 0, "no tables: no types, the fields stay text");

  const [all, ashen, summer] = sets.entries;
  assert.equal(tickListValue(sets, "L,A", all, true), "*", "every tileset replaces the list");
  assert.equal(tickListValue(sets, "*", summer, true), "L", "and leaves it when one is ticked");
  assert.equal(tickListValue(sets, "L", ashen, true), "L,A");
  assert.equal(tickListValue(sets, "L,A", summer, false), "A");
  assert.equal(tickListValue(sets, "*", all, false), "");
});
