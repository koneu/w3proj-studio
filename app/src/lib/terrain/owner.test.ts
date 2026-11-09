import assert from "node:assert/strict";
import { test } from "node:test";
import { hasPlayerUnits, joinOwners, meleeFlagsAfter, ownerOf, placedText, splitOwners } from "./owner";

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

test("a unit's hit points or mana of 0 are saved as -1, the type's own, as the World Editor saves them", () => {
  // we-drive saves of World Editor 7003 (2026-11-09): start locations, a footman, a sorceress and an item with 0.
  const doc = { units: [
    { id: "sloc", player: 0, hp: 0, mana: 0 },
    { id: "hsor", player: UPROOTED, hp: 50, mana: 0 },
    { id: "hsor", player: 0, hp: 0, mana: 5 },
    { id: "ratc", player: 27, hp: -1, mana: -1 },
  ], doodads: [{ id: "LTlt", life: 0 }] };
  splitOwners(doc.units);
  const saved = JSON.parse(placedText(doc));
  assert.deepEqual(saved.units.map((u: { hp: number; mana: number }) => [u.hp, u.mana]), [[-1, -1], [50, -1], [-1, 5], [-1, -1]]);
  assert.equal(saved.units[1].player, UPROOTED, "the owner's flags still go back");
  assert.deepEqual(Object.keys(saved.units[0]), ["id", "player", "hp", "mana"], "in their places");
  assert.equal(saved.doodads[0].life, 0, "a dead destructable stays dead");
  assert.equal(doc.units[0].hp, 0, "what's being edited isn't touched");
});

test("joining doesn't touch what's being edited", () => {
  const list = [{ id: "eaow", player: UPROOTED }];
  splitOwners(list);
  assert.equal(joinOwners(list[0]).player, UPROOTED);
  assert.equal(list[0].player, 1);
});

test("a unit of a player counts; start locations, items and neutrals don't", () => {
  const item = (id: string) => id === "ratf";
  assert.equal(hasPlayerUnits([{ id: "hfoo", player: 0 }], item), true);
  assert.equal(hasPlayerUnits([{ id: "hfoo", player: 23 }], item), true);
  assert.equal(hasPlayerUnits([{ id: "etol", player: 0x10002 }], item), true, "an uprooted Ancient is its player's");
  assert.equal(hasPlayerUnits([{ id: "sloc", player: 0 }, { id: "ratf", player: 0 }], item), false);
  assert.equal(hasPlayerUnits([{ id: "nogr", player: 24 }, { id: "ngol", player: 27 }], item), false);
  assert.equal(hasPlayerUnits([], item), false);
});

test("a player's unit takes Melee off the map's flags, and only that flag; nothing puts it back", () => {
  const item = (id: string) => id === "ratf";
  assert.equal(meleeFlagsAfter(0x9c14, [{ id: "hfoo", player: 0 }], item), 0x9c10);
  assert.equal(meleeFlagsAfter(0x9c14, [{ id: "sloc", player: 0 }, { id: "ratf", player: 27 }], item), 0x9c14);
  assert.equal(meleeFlagsAfter(0x9c10, [], item), 0x9c10);
});
