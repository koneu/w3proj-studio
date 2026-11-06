import assert from "node:assert/strict";
import { test } from "node:test";
import { joinOwners, ownerOf, placedText, splitOwners } from "./owner";

const UPROOTED = 0x10001;

test("the owner is the low half of the player field", () => {
  assert.equal(ownerOf(UPROOTED), 1);
  assert.equal(ownerOf(5), 5);
  assert.equal(ownerOf(27), 27);
  assert.equal(ownerOf(undefined), undefined);
});

test("splitting shows the owner and keeps the flag for later", () => {
  const list: { id: string; player?: number; playerFlags?: number }[] = [{ id: "eaow", player: UPROOTED }, { id: "hfoo", player: 2 }, { id: "LTlt" }];
  splitOwners(list);
  assert.equal(list[0].player, 1);
  assert.equal(list[0].playerFlags, 0x10000);
  assert.deepEqual(list[1], { id: "hfoo", player: 2 });
  assert.deepEqual(list[2], { id: "LTlt" });
});

test("a file comes back exactly as it was", () => {
  const original = { version: 8, units: [{ id: "eaow", player: UPROOTED, x: 1 }, { id: "hfoo", player: 2, x: 2 }] };
  const doc = JSON.parse(JSON.stringify(original)) as typeof original;
  splitOwners(doc.units);
  assert.equal(placedText(doc), JSON.stringify(original));
});

test("a new owner keeps the flag: the Ancient stays uprooted", () => {
  const doc = { units: [{ id: "eaow", player: UPROOTED }] };
  splitOwners(doc.units);
  doc.units[0].player = 3;
  assert.equal(JSON.parse(placedText(doc)).units[0].player, 0x10003);
});

test("joining doesn't touch what's being edited", () => {
  const list = [{ id: "eaow", player: UPROOTED }];
  splitOwners(list);
  assert.equal(joinOwners(list[0]).player, UPROOTED);
  assert.equal(list[0].player, 1);
});
