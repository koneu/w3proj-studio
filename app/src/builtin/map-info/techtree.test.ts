import assert from "node:assert/strict";
import { test } from "node:test";
import { addItemTable, ITEM_TABLES_ANCHOR, itemTableAnchor, type TechInfo } from "./techtree";

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

test("Map Properties scrolls to the item tables or to one of them", () => {
  assert.equal(ITEM_TABLES_ANCHOR, "item-tables");
  assert.notEqual(itemTableAnchor(0), itemTableAnchor(1));
});
