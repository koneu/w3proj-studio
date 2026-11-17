import assert from "node:assert/strict";
import { test } from "node:test";
import type { FieldMeta, KindData } from "../../lib/objects/metadata";
import type { EditorType } from "./fields";
import { pickerList } from "./picker";

const race = { id: "urac", label: "Race", type: "unitRace", field: "race", repeat: 0 } as FieldMeta;
const RACES: Record<string, string> = { hfoo: "human", earc: "nightelf" };
const kd = {
  kind: "w3u", facetDefs: [], facets: () => ({}), fields: [race], fieldById: new Map([["urac", race]]),
  names: new Map([["hfoo", "Footman"], ["earc", "Archer"]]), searchText: () => "", baseIds: ["hfoo", "earc"],
  levels: () => 1, fieldsFor: () => [race], defaultValue: (id: string) => RACES[id],
} as unknown as KindData;
const types = new Map<string, EditorType>([["unitRace", { shape: "single", entries: [
  { value: "human", label: "Human", alts: [] }, { value: "nightelf", label: "Night Elf", alts: [] },
] }]]);

const archer = (list: ReturnType<typeof pickerList>) => list.entries.find((e) => e.id === "earc")!;

test("a row shows a filtered choice field's label, not the stored value", () => {
  const list = pickerList(kd, { editorTypes: types });
  list.setQuery("race:Night_Elf");
  assert.deepEqual(list.entries.filter((e) => list.matches(e)).map((e) => e.id), ["earc"]);
  assert.equal(list.valueText(race, archer(list)), "Race: Night Elf");
  // Without types the stored value is all there is.
  assert.equal(pickerList(kd, {}).valueText(race, archer(list)), "Race: nightelf");
});

test("a browser opened before the editor types load uses them once they arrive", async () => {
  let arrive!: (t: Map<string, EditorType> | null) => void;
  let redraws = 0;
  const list = pickerList(kd, { editorTypes: new Promise((r) => { arrive = r; }) }, () => redraws++);
  list.setQuery("race:Night_Elf");
  assert.equal(list.entries.filter((e) => list.matches(e)).length, 0, "only raw values match before");
  assert.equal(list.valueText(race, archer(list)), "Race: nightelf");
  arrive(types);
  await new Promise<void>((r) => setImmediate(r)); // every microtask the loading chains has run
  assert.equal(redraws, 1, "the browser is drawn again");
  assert.deepEqual(list.entries.filter((e) => list.matches(e)).map((e) => e.id), ["earc"]);
  assert.equal(list.valueText(race, archer(list)), "Race: Night Elf");
});

test("a quoted value keeps its space: race:\"Night Elf\" is the label, not race:Night and a word Elf", () => {
  const list = pickerList(kd, { editorTypes: types });
  const found = (q: string) => { list.setQuery(q); return list.entries.filter((e) => list.matches(e)).map((e) => e.id); };
  assert.deepEqual(found("race:\"Night Elf\""), ["earc"]);
  assert.deepEqual(found("race=\"night elf\""), ["earc"], "with = too, in any case");
  assert.deepEqual(found("race:\"Night Elf\" archer"), ["earc"], "a word after it is still a word");
  assert.deepEqual(found("race:\"Night Elf\" footman"), [], "and still has to match");
  // Control: unquoted, the space ends the value as before (Night matches the label, Elf is a word nothing has).
  assert.deepEqual(found("race:Night Elf"), []);
});

test("types that fail to load leave the browser on raw values, without a redraw", async () => {
  let redraws = 0;
  const list = pickerList(kd, { editorTypes: Promise.resolve(null) }, () => redraws++);
  await new Promise<void>((r) => setImmediate(r)); // every microtask the loading chains has run
  assert.equal(redraws, 0);
  assert.equal(list.valueText(race, archer(list)), "Race: nightelf");
});

test("extra entries (random items) are listed first, found by words, and hidden while a facet or field filter is on", () => {
  const extra = [{ id: "YkI2", name: "Random Level 2 Power Up Item" }, { id: "YYI/", name: "Random Any Level Item" }];
  const list = pickerList(kd, { extra });
  const found = (q: string) => { list.setQuery(q); return list.entries.filter((e) => list.matches(e)).map((e) => e.id); };
  assert.deepEqual(found(""), ["YkI2", "YYI/", "earc", "hfoo"]);
  assert.deepEqual(found("level 2 power"), ["YkI2"]);
  assert.deepEqual(found("ykI2"), ["YkI2"]);
  assert.deepEqual(found("race:human"), ["hfoo"]);
  // Control: without the option there are none.
  assert.deepEqual(pickerList(kd, {}).entries.map((e) => e.id), ["earc", "hfoo"]);
});

test("game rows show 'Name - Editor Suffix', and the suffix is searched; the sort stays by name then id", () => {
  const unsf = { id: "unsf", label: "Name - Editor Suffix", type: "string", field: "EditorSuffix", repeat: 0 } as FieldMeta;
  const SUF: Record<string, string> = { nmr0: "(Lordaeron Winter)", nmr3: "WES_X", nmer: "" };
  const k = {
    kind: "w3u", facetDefs: [], facets: () => ({}), fields: [unsf], fieldById: new Map([["unsf", unsf]]),
    names: new Map([["nmr3", "Mercenary Camp"], ["nmr0", "Mercenary Camp"], ["nmer", "Mercenary Camp"]]), searchText: () => "",
    baseIds: ["nmr3", "nmr0", "nmer"], levels: () => 1, fieldsFor: () => [unsf], defaultValue: (id: string) => SUF[id],
    westring: (v: string) => (v === "WES_X" ? "|cffff0000(Dalaran)|r" : v),
  } as unknown as KindData;
  const list = pickerList(k, { custom: [{ id: "h000", base: "nmr0", name: "Mine" }] });
  assert.deepEqual(list.entries.map((e) => e.label), ["Mercenary Camp", "Mercenary Camp - (Lordaeron Winter)", "Mercenary Camp - (Dalaran)", "Mine"]);
  assert.deepEqual(list.entries.map((e) => e.id), ["nmer", "nmr0", "nmr3", "h000"]);
  list.setQuery("winter");
  assert.deepEqual(list.entries.filter((e) => list.matches(e)).map((e) => e.id), ["nmr0"]);
  list.setQuery("dalaran");
  assert.deepEqual(list.entries.filter((e) => list.matches(e)).map((e) => e.id), ["nmr3"]);
});
