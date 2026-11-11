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
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(redraws, 1, "the browser is drawn again");
  assert.deepEqual(list.entries.filter((e) => list.matches(e)).map((e) => e.id), ["earc"]);
  assert.equal(list.valueText(race, archer(list)), "Race: Night Elf");
});

test("types that fail to load leave the browser on raw values, without a redraw", async () => {
  let redraws = 0;
  const list = pickerList(kd, { editorTypes: Promise.resolve(null) }, () => redraws++);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(redraws, 0);
  assert.equal(list.valueText(race, archer(list)), "Race: nightelf");
});
