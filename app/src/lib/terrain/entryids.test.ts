import assert from "node:assert/strict";
import { test } from "node:test";
import { entryIds, renamedEntry } from "./entryids";

const unit = () => ({
  id: "h001", skinId: "h009", position: [0, 0, 0],
  inventory: [{ slot: 0, id: "I001" }], abilities: [{ id: "A001", autocast: 0, level: 1 }],
  itemSets: [[{ id: "I002", chance: 50 }, { id: "I001", chance: 50 }], [{ id: "I003", chance: 100 }]],
  randomUnits: [{ id: "h002", chance: 100 }], randomId: "h003", name: "abcd",
});

test("a placed object's ids: its type, skin, items, abilities, drops and random picks", () => {
  assert.deepEqual(entryIds(unit()).sort(), ["A001", "I001", "I002", "I003", "h001", "h002", "h003", "h009"]);
  assert.deepEqual(entryIds({ id: "hfoo", inventory: [], abilities: "x", itemSets: [null, [null, 5]] }), ["hfoo"]);
});

test("renaming reaches every place an id is held, and nothing else", () => {
  const to = new Map([["h001", "h101"], ["A001", "A101"], ["I001", "I101"], ["I003", "I103"], ["h002", "h102"], ["h003", "h103"], ["h009", "h109"]]);
  const original = unit();
  const r = renamedEntry(original, to);
  assert.equal(r.id, "h101");
  assert.equal(r.skinId, "h109");
  assert.equal(r.inventory[0].id, "I101");
  assert.equal(r.abilities[0].id, "A101");
  assert.deepEqual(r.itemSets.map((s) => s.map((x) => x.id)), [["I002", "I101"], ["I103"]]);
  assert.equal(r.randomUnits[0].id, "h102");
  assert.equal(r.randomId, "h103");
  assert.equal(r.name, "abcd");
  assert.deepEqual(original, unit(), "the original is untouched");
  assert.deepEqual(renamedEntry(original, new Map()), original);
});

test("an entry without these fields stays as it is", () => {
  assert.deepEqual(renamedEntry({ id: "LTlt", position: [1, 2, 3] }, new Map([["LTlt", "D000"]])), { id: "D000", position: [1, 2, 3] });
});
