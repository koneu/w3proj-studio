import assert from "node:assert/strict";
import { test } from "node:test";
import { ITEM_CLASSES, parseRandomId, randomChoices, randomIdLabel, randomObjectId } from "./randomids";

// What the World Editor made and named (we-drive 2026-11-12): a new set of a random group with Random in each position
// saved as "YYU/", "YYB/", "YYI/"; its Random Groups dialog named the probe group's ids so.
test("the ids the World Editor writes for Random in a unit, building and item position", () => {
  assert.equal(randomObjectId({ kind: "creep", level: -1 }), "YYU/");
  assert.equal(randomObjectId({ kind: "building" }), "YYB/");
  assert.equal(randomObjectId({ kind: "item", level: -1, itemClass: 0 }), "YYI/");
});

test("the level is the character after '0', '/' any level; levels above 9 go on in the character table", () => {
  assert.equal(randomObjectId({ kind: "creep", level: 3 }), "YYU3");
  assert.equal(randomObjectId({ kind: "creep", level: 10 }), "YYU:");
  assert.equal(randomObjectId({ kind: "creep", level: 18 }), "YYUB");
  assert.equal(randomObjectId({ kind: "item", level: 2, itemClass: 1 }), "YiI2");
  assert.equal(randomObjectId({ kind: "item", level: 9, itemClass: 4 }), "YlI9");
  assert.deepEqual(parseRandomId("YYU:"), { kind: "creep", level: 10 });
  assert.deepEqual(parseRandomId("YYU/"), { kind: "creep", level: -1 });
  assert.deepEqual(parseRandomId("YoI0"), { kind: "item", level: 0, itemClass: 7 });
  assert.throws(() => randomObjectId({ kind: "item", level: 1, itemClass: 8 }), /no item class/);
});

test("the World Editor's names of the probe group's ids, and none for ids it left unnamed", () => {
  const named: [string, string | undefined][] = [
    ["YYU1", "Random Level 1 Neutral Hostile Unit"], ["YYU/", "Random Any Level Neutral Hostile Unit"],
    ["YYU:", "Random Level 10 Neutral Hostile Unit"], ["YYU0", "Random Level 0 Neutral Hostile Unit"],
    // Any fourth character is the random building.
    ["YYB/", "Random Neutral Passive Building"], ["YYB0", "Random Neutral Passive Building"], ["YYBb", "Random Neutral Passive Building"],
    ["YYUB", "Random Level 18 Neutral Hostile Unit"],
    ["YiI2", "Random Level 2 Permanent Item"], ["YYI/", "Random Any Level Item"], ["YlI9", "Random Level 9 Artifact Item"],
    ["YYI:", "Random Level 10 Item"], ["YoI0", "Random Level 0 Miscellaneous Item"], ["YYI3", "Random Level 3 Item"],
    ["YiI/", "Random Any Level Permanent Item"],
    // Shown empty by the editor, written as plain ids into the script.
    ["Yyu1", undefined], ["YYNB", undefined],
    // Ordinary ids.
    ["hfoo", undefined], ["YTct", undefined], ["0x00000000", undefined], ["YYU", undefined], ["", undefined],
  ];
  for (const [id, label] of named) assert.equal(randomIdLabel(id), label, id);
});

test("what a position of each type offers: any level and levels 0 to 20 of creeps, the building, items by class and level 0 to 8", () => {
  const units = randomChoices(0);
  assert.equal(units.length, 22);
  assert.deepEqual(units.slice(0, 2), [{ id: "YYU/", label: "Random Any Level Neutral Hostile Unit" }, { id: "YYU0", label: "Random Level 0 Neutral Hostile Unit" }]);
  assert.equal(units.at(-1)!.id, "YYUD");
  assert.deepEqual(randomChoices(1), [{ id: "YYB/", label: "Random Neutral Passive Building" }]);
  const items = randomChoices(2);
  assert.equal(items.length, ITEM_CLASSES.length * 10);
  assert.equal(items[0].id, "YYI/");
  assert.equal(items.at(-1)!.id, "YoI8");
  assert.deepEqual(randomChoices(7), []);
  // Each offered id reads back as what it was made from.
  for (const t of [0, 1, 2]) for (const c of randomChoices(t)) assert.equal(randomObjectId(parseRandomId(c.id)!), c.id);
});
