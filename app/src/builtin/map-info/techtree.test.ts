import assert from "node:assert/strict";
import { test } from "node:test";
import { addItemTable, ITEM_TABLES_ANCHOR, itemTableAnchor, itemTablesShown, TECH_LIMITS, techNumber, type TechInfo } from "./techtree";

const info = (itemTables?: TechInfo["itemTables"]): TechInfo => ({ upgrades: [], techs: [], unitTables: [], ...(itemTables ? { itemTables } : {}) });

test("a new item table comes after the others: the next number, one empty set, the World Editor's name", () => {
  const first = { number: 0, name: "Loot", sets: [[{ chance: 100, id: "ratf" }]] };
  const third = { number: 3, name: "TRIGSTR_007", sets: [] };
  const map = info([structuredClone(first), structuredClone(third)]);
  const made = addItemTable(map);
  assert.deepEqual(made, { number: 4, name: "Item Table", sets: [[]] });
  assert.equal(map.itemTables!.at(-1), made, "it is the map's, at the end");
  assert.deepEqual(map.itemTables!.slice(0, 2), [first, third], "the tables there stay as stored");
});

test("the first item table of a map is number 0", () => {
  const map = info([]);
  assert.equal(addItemTable(map).number, 0);
  assert.equal(addItemTable(map).number, 1);
});

test("a Reign of Chaos map has no item tables to add to, and gets none", () => {
  const map = info();
  assert.throws(() => addItemTable(map), /no item tables/);
  assert.equal("itemTables" in map, false, "nothing was added to the map");
});

test("the item tables as other modules see them: names through the string table, copies", () => {
  const map = info([{ number: 2, name: "TRIGSTR_007", sets: [[{ chance: 100, id: "ratf" }]] }, { number: 5, name: "Plain", sets: undefined as never }]);
  const shown = itemTablesShown(map, (v) => (v === "TRIGSTR_007" ? "Smoke Loot" : v));
  assert.deepEqual(shown, [{ number: 2, name: "Smoke Loot", sets: [[{ chance: 100, id: "ratf" }]] }, { number: 5, name: "Plain", sets: [] }]);
  shown[0].sets[0][0].chance = 1;
  assert.equal(map.itemTables![0].sets[0][0].chance, 100, "changing what was given changes nothing");
  assert.equal(map.itemTables![0].name, "TRIGSTR_007");
  assert.deepEqual(itemTablesShown(info(), (v) => v), [], "Reign of Chaos: none");
});

test("Map Properties scrolls to the item tables or to one of them", () => {
  assert.equal(ITEM_TABLES_ANCHOR, "item-tables");
  assert.notEqual(itemTableAnchor(0), itemTableAnchor(1));
});

test("an upgrade's level past war3map.w3i's u32 (stored from 0) and a chance past 100 are refused; the edges are taken", () => {
  const { level, chance } = TECH_LIMITS;
  for (const typed of ["0", "4294967297", "1.5", "", "abc"]) assert.equal(techNumber(typed, level), null, `level ${JSON.stringify(typed)}`);
  assert.equal(techNumber("1", level), 1);
  assert.equal(techNumber("4294967296", level), 4294967296, "stored as 4294967295, the u32's highest");
  for (const typed of ["-1", "101", "50.5", ""]) assert.equal(techNumber(typed, chance), null, `chance ${JSON.stringify(typed)}`);
  assert.equal(techNumber("0", chance), 0);
  assert.equal(techNumber("100", chance), 100);
  // an item's chance starts at 1, as the World Editor's item box (a group line's at 0)
  assert.equal(techNumber("0", TECH_LIMITS.itemChance), null);
  assert.equal(techNumber("1", TECH_LIMITS.itemChance), 1);
  assert.equal(techNumber("100", TECH_LIMITS.itemChance), 100);
});
