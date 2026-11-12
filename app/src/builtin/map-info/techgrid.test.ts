import assert from "node:assert/strict";
import { test } from "node:test";
import { setTechAvailable, setUpgradeState, techAvailable, techRows, upgradeRows, upgradeState } from "./techgrid";
import type { Tech, Upgrade } from "./techtree";

test("the techtree grid: a row per unavailable object, a cell ticked where the player can use it", () => {
  const techs: Tech[] = [{ players: 0b101, id: "hfoo" }, { players: 0b10, id: "hkni" }, { players: 0b1000, id: "hfoo" }];
  assert.deepEqual(techRows(techs), ["hfoo", "hkni"]);
  assert.deepEqual([0, 1, 2, 3].map((p) => techAvailable(techs, "hfoo", p)), [false, true, false, false]);
  assert.equal(techAvailable(techs, "hpea", 0), true, "an object no entry names is available");
});

test("the techtree grid: a player made unavailable goes into the object's first entry, the others keep their bytes", () => {
  const techs: Tech[] = [{ players: 0b1, id: "hfoo" }, { players: 0b10, id: "hkni" }, { players: 0b1000, id: "hfoo" }];
  const others = structuredClone(techs.slice(1));
  assert.equal(setTechAvailable(techs, "hfoo", 2, false), true);
  assert.deepEqual(techs[0], { players: 0b101, id: "hfoo" });
  assert.deepEqual(techs.slice(1), others);
  assert.equal(setTechAvailable(techs, "hfoo", 2, false), false, "already unavailable: no change");
  assert.equal(setTechAvailable(techs, "hpea", 31, false), true);
  assert.deepEqual(techs.at(-1), { players: 0x80000000, id: "hpea" }, "player 32's bit stays an unsigned mask");
});

test("the techtree grid: a player made available leaves every entry of the object; an entry left with no player goes", () => {
  const techs: Tech[] = [{ players: 0b11, id: "hfoo" }, { players: 0b10, id: "hkni" }, { players: 0b10, id: "hfoo" }];
  assert.equal(setTechAvailable(techs, "hfoo", 1, true), true);
  assert.deepEqual(techs, [{ players: 0b1, id: "hfoo" }, { players: 0b10, id: "hkni" }]);
  assert.equal(setTechAvailable(techs, "hfoo", 1, true), false);
  setTechAvailable(techs, "hfoo", 0, true);
  assert.deepEqual(techs, [{ players: 0b10, id: "hkni" }]);
});

test("the techtree grid leaves an entry with no players alone when no cell of it changed", () => {
  const techs: Tech[] = [{ players: 0, id: "hfoo" }, { players: 0b1, id: "hfoo" }];
  setTechAvailable(techs, "hfoo", 0, true);
  assert.deepEqual(techs, [{ players: 0, id: "hfoo" }]);
});

test("the upgrades grid: a row per upgrade level, a player's state is the last entry naming them, else available", () => {
  const ups: Upgrade[] = [
    { players: 0b11, id: "Rhme", level: 0, availability: 0 },
    { players: 0b10, id: "Rhme", level: 0, availability: 2 },
    { players: 0b1, id: "Rhme", level: 1, availability: 2 },
  ];
  assert.deepEqual(upgradeRows(ups), [{ id: "Rhme", level: 0 }, { id: "Rhme", level: 1 }]);
  assert.deepEqual([0, 1, 2].map((p) => upgradeState(ups, "Rhme", 0, p)), [0, 2, 1]);
  assert.equal(upgradeState(ups, "Rhme", 1, 0), 2);
  assert.equal(upgradeState(ups, "Rhme", 2, 0), 1);
});

test("the upgrades grid: a state set moves the player into the entry that keeps it; available needs none", () => {
  const ups: Upgrade[] = [
    { players: 0b11, id: "Rhme", level: 0, availability: 0 },
    { players: 0b1, id: "Rhar", level: 0, availability: 2 },
  ];
  assert.equal(setUpgradeState(ups, "Rhme", 0, 0, 2), true);
  assert.deepEqual(ups, [
    { players: 0b10, id: "Rhme", level: 0, availability: 0 },
    { players: 0b1, id: "Rhar", level: 0, availability: 2 },
    { players: 0b1, id: "Rhme", level: 0, availability: 2 },
  ]);
  assert.equal(setUpgradeState(ups, "Rhme", 0, 1, 2), true, "joins the entry with that state");
  assert.deepEqual(ups, [{ players: 0b1, id: "Rhar", level: 0, availability: 2 }, { players: 0b11, id: "Rhme", level: 0, availability: 2 }],
    "the unavailable entry, left with no player, went");
  assert.equal(setUpgradeState(ups, "Rhme", 0, 1, 2), false);
  assert.equal(setUpgradeState(ups, "Rhme", 0, 0, 1), true);
  assert.equal(setUpgradeState(ups, "Rhme", 0, 1, 1), true);
  assert.deepEqual(ups, [{ players: 0b1, id: "Rhar", level: 0, availability: 2 }], "available everywhere: the level's entries are gone");
  assert.equal(upgradeState(ups, "Rhme", 0, 0), 1);
});
