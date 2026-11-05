import assert from "node:assert/strict";
import { test } from "node:test";
import { placedList, placedTypes, type PlacedThing } from "./placedinfo";

const at = (id: string, player?: number): PlacedThing => ({ id, position: [1, 2, 3], angle: 0, player });
const all = [at("hfoo", 0), at("sloc", 0), at("hfoo", 1), at("ogru", 1), at("hfoo", 0)];
const names = new Map([["hfoo", "Footman"]]);

test("types by count, then by id", () => {
  assert.deepEqual(placedTypes(all, names), [
    { id: "hfoo", name: "Footman", count: 3 },
    { id: "ogru", name: undefined, count: 1 },
    { id: "sloc", name: undefined, count: 1 },
  ]);
});

test("players count from 1 in and out", () => {
  const second = placedList(all, names, undefined, 2);
  assert.deepEqual(second.map((p) => [p.id, p.player]), [["hfoo", 2], ["ogru", 2]]);
  assert.equal(placedList(all, names, "hfoo", 1).length, 2);
  assert.equal(placedList(all, names, "hfoo").length, 3);
});

test("doodads have no owner, and don't get one", () => {
  const got = placedList([at("ATtr")], names, "ATtr");
  assert.equal("player" in got[0], false);
});
