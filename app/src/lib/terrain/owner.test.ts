import assert from "node:assert/strict";
import { test } from "node:test";
import { hasPlayerUnits, joinOwners, meleeBlockers, meleeFlagsAfter, ownerOf, placedText, splitOwners } from "./owner";

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

test("a unit or item of a player counts; start locations and neutrals don't", () => {
  assert.equal(hasPlayerUnits([{ id: "hfoo", player: 0 }]), true);
  assert.equal(hasPlayerUnits([{ id: "hfoo", player: 23 }]), true);
  assert.equal(hasPlayerUnits([{ id: "etol", player: 0x10002 }]), true, "an uprooted Ancient is its player's");
  assert.equal(hasPlayerUnits([{ id: "ratf", player: 0 }]), true, "an item of Player 1 (we-drive save: the editor took the flag off)");
  assert.equal(hasPlayerUnits([{ id: "sloc", player: 0 }, { id: "ratf", player: 27 }]), false);
  assert.equal(hasPlayerUnits([{ id: "nogr", player: 24 }, { id: "ngol", player: 27 }]), false);
  assert.equal(hasPlayerUnits([]), false);
});

test("a player's unit takes Melee off the map's flags, and only that flag; nothing puts it back", () => {
  assert.equal(meleeFlagsAfter({ flags: 0x9c14 }, [{ id: "hfoo", player: 0 }]), 0x9c10);
  assert.equal(meleeFlagsAfter({ flags: 0x9c14 }, [{ id: "sloc", player: 0 }, { id: "ratf", player: 27 }]), 0x9c14);
  assert.equal(meleeFlagsAfter({ flags: 0x9c10 }, []), 0x9c10);
});

// we-drive saves of World Editor 7003 (2026-11-09): (4)PhantomGrove (flags 0x2fc14) with the Melee flag cleared and one
// change each; the editor's save put the flag back exactly when the change isn't a reason.
test("the World Editor's melee rules, as far as war3map.w3i and the units tell", () => {
  const base = { flags: 0x2fc10, players: [0, 1, 2, 3].map(() => ({ fixedStart: 0 })), gameDataSet: 0, upgrades: [], techs: [] };
  const sloc = [{ id: "sloc", player: 0 }, { id: "ngol", player: 27 }, { id: "nskf", player: 24 }];
  const blocked = (change: Partial<typeof base> & { flags?: number }, placed = sloc) => meleeBlockers({ ...base, ...change }, placed);
  assert.deepEqual(blocked({}), [], "plain: the flag came back");
  // Reasons (the flag stayed off).
  assert.equal(blocked({ flags: base.flags | 0x1 }).length, 1, "hide minimap");
  assert.equal(blocked({ flags: base.flags & ~0x10 }).length, 1, "masked areas not partially visible");
  assert.equal(blocked({ flags: base.flags | 0x40 }).length, 1, "custom forces");
  assert.equal(blocked({ players: [{ fixedStart: 1 }, { fixedStart: 0 }] }).length, 1, "a fixed start location");
  assert.equal(blocked({ gameDataSet: 1 }).length, 1, "game data set");
  assert.deepEqual(blocked({ gameDataSet: 0xffffffff }), [], "-1: the World Editor's own new maps have it, Melee on");
  assert.deepEqual(blocked({ gameDataSet: -1 }), [], "-1 read signed");
  assert.equal(blocked({ upgrades: [{ players: 1, id: "Rhme", level: 0, availability: 0 }] as never[] }).length, 1, "an upgrade entry");
  assert.equal(blocked({ techs: [{ players: 1, id: "hfoo" }] as never[] }).length, 1, "a techtree entry");
  assert.equal(blocked({}, [...sloc, { id: "hfoo", player: 0 }]).length, 1, "a unit of Player 1");
  assert.equal(blocked({}, [...sloc, { id: "ratf", player: 0 }]).length, 1, "an item of Player 1");
  // Not reasons (the flag came back).
  for (const f of [0x80, 0x100, 0x200, 0x20]) assert.deepEqual(blocked({ flags: base.flags | f }), [], `flag ${f.toString(16)} alone`);
  assert.deepEqual(blocked({ players: [{ fixedStart: 2 }] }), [], "Race selectable");
  assert.deepEqual(blocked({}, [...sloc, { id: "hfoo", player: 24 }]), [], "a neutral unit");
  // The flag goes off for each, and only it.
  assert.equal(meleeFlagsAfter({ ...base, flags: 0x2fc14 | 0x40 }, sloc), 0x2fc10 | 0x40);
  assert.equal(meleeFlagsAfter({ ...base, flags: 0x2fc14 }, sloc), 0x2fc14);
});
