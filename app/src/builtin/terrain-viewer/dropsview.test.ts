import assert from "node:assert/strict";
import { test } from "node:test";
import {
  bulkDrops, campLevel, campLevelText, creepLevel, dropsAnything, dropsText, dropsVariants, groupDroppers, itemLabel, itemTablesDiffer, setHeading, setShares, tableUse, type DropperRow,
} from "./dropsview";
import type { Placed } from "./objects";
import { changeEach, dropsOf, type TypeFacts } from "./unitprops";

const facts = (kind = "w3u"): TypeFacts => ({
  kind, hero: false, building: false, invulnerable: false, attacks: true, acquireRange: 500, maxHp: 420, maxMana: 0, skills: [], toggles: [], slots: 0,
  goldMine: false, waygate: false, customColor: false, maxLevel: 10, levelSkip: 2,
});
/** A unit as World Editor 2.0 writes it (subversion 11), at a place, for a player (from 0). */
const unit = (id: string, x: number, y: number, player: number, more: Record<string, unknown> = {}): Placed => ({
  id, variation: 0, position: [x, y, 0], angle: 0, scale: [1, 1, 1], skinId: id, flags: 2, player, hp: -1, mana: -1, itemTable: -1, itemSets: [],
  gold: 12500, targetAcquisition: -1, level: 1, strength: 0, agility: 0, intelligence: 0, inventory: [], abilities: [], color: -1, waygate: -1, editorId: 0, ...more,
} as unknown as Placed);
/** The older layout (subversion 9): no item table field. */
const oldUnit = (id: string, x: number, y: number) => {
  const u = unit(id, x, y, 24) as unknown as Record<string, unknown>;
  delete u.itemTable;
  return u as unknown as Placed;
};
const tree = (x: number, y: number, more: Record<string, unknown> = {}): Placed =>
  ({ id: "LTlt", variation: 0, position: [x, y, 0], angle: 0, scale: [1, 1, 1], flags: 2, life: 100, itemTable: -1, itemSets: [], editorId: 0, ...more } as unknown as Placed);
const row = (entry: Placed, kind = "w3u"): DropperRow => ({ entry, kind });
const sets = (e: Placed) => (e as unknown as { itemSets: unknown }).itemSets;

test("what drops reads in words: random items by class and level, never their code", () => {
  assert.equal(itemLabel("YjI2"), "Random item, charged, level 2");
  assert.equal(itemLabel("YYI/"), "Random item, any class, any level");
  assert.equal(itemLabel("ratf", "Claws of Attack +15"), "Claws of Attack +15");
  assert.equal(itemLabel("ratf"), "ratf");
  assert.equal(itemLabel("0x00000000"), "Nothing");
});

test("a set's shares: each item's part of the bar, the rest drops nothing", () => {
  const s = setShares([{ id: "ratf", chance: 60 }, { id: "YjI2", chance: 20 }]);
  assert.equal(s.total, 80);
  assert.equal(s.nothing, 20);
  assert.deepEqual(s.items.map((x) => x.share), [0.6, 0.2]);
  // Past 100 the game picks by shares: the bar is of the total, and nothing is left over.
  const over = setShares([{ id: "ratf", chance: 100 }, { id: "rde1", chance: 50 }]);
  assert.equal(over.over, true);
  assert.equal(over.nothing, 0);
  assert.deepEqual(over.items.map((x) => Math.round(x.share * 100)), [67, 33]);
  assert.equal(setHeading([], 0), "Set 1 · empty: drops nothing");
  assert.equal(setHeading([{ id: "ratf", chance: 100 }], 1), "Set 2 · drops this · 100%");
  assert.equal(setHeading([{ id: "ratf", chance: 30 }, { id: "rde1", chance: 30 }], 0), "Set 1 · drops one of these · 60% (40% nothing)");
});

test("drops in a line name the table or the item, and say so when nothing drops", () => {
  const names = { table: (n: number) => (n === 3 ? "Smoke Loot" : undefined), item: (id: string) => (id === "ratf" ? "Claws of Attack" : undefined) };
  assert.equal(dropsText({ mode: "none" }, names), "Drops nothing");
  assert.equal(dropsText({ mode: "table", table: 3 }, names), "Item table Smoke Loot");
  assert.equal(dropsText({ mode: "table", table: 9 }, names), "Item table #9 (not in the map)");
  assert.equal(dropsText({ mode: "custom", sets: [[{ id: "YjI2", chance: 100 }]] }, names), "Random item, charged, level 2 (100%)");
  assert.equal(dropsText({ mode: "custom", sets: [[]] }, names), "Own sets, all empty: drops nothing");
  assert.equal(dropsText({ mode: "custom", sets: [[{ id: "ratf", chance: 50 }, { id: "YjI2", chance: 50 }], [{ id: "ratf", chance: 10 }]] }, names), "2 sets · 3 items");
  assert.equal(dropsAnything({ mode: "custom", sets: [[]] }), false);
  assert.equal(dropsAnything({ mode: "custom", sets: [[{ id: "0x00000000", chance: 100 }]] }), false);
  assert.equal(dropsAnything({ mode: "table", table: 0 }), true);
});

test("creeps standing together make a camp; others go by owner", () => {
  // Two camps of Neutral Hostile creeps, a crate by the second, a player's unit and a lone creep far off.
  const a1 = unit("nomg", -3242, -3145, 24, { itemSets: [[{ id: "YjI2", chance: 100 }]] }), a2 = unit("nftt", -3157, -3275, 24);
  const b1 = unit("nftt", 3634, 3811, 24), b2 = unit("nomg", 3719, 3681, 24, { itemTable: 0 }), crate = tree(3900, 3700);
  const mine = unit("hfoo", 0, 0, 0), lone = unit("nwlg", 0, 3000, 24);
  const rows = [row(a1), row(a2), row(b1), row(b2), row(crate, "w3b"), row(mine), row(lone)];
  const names = { owner: (p: number) => (p === 24 ? "Neutral Hostile" : `Player ${p + 1}`), type: (id: string) => id };
  const camps = groupDroppers(rows, "camp", names);
  assert.deepEqual(camps.map((g) => g.title), ["Camp 1", "Camp 2", "Camp 3", "Player 1"]);
  // North first: the camp at the top right, then the lone creep, then the bottom left.
  assert.deepEqual(camps[0].rows.map((r) => r.entry), [b1, b2, crate]);
  assert.deepEqual(camps[1].rows.map((r) => r.entry), [lone]);
  assert.deepEqual(camps[2].rows.map((r) => r.entry), [a1, a2]);
  assert.match(camps[0].detail, /^3 objects · 1 drop · at 3751, 3731$/);
  assert.match(camps[2].detail, /^2 creeps · 1 drop/);
  assert.deepEqual(camps[3].rows.map((r) => r.entry), [mine]);
  // Two creeps just over the camp distance apart are two camps; just under, one.
  const near = (gap: number) => groupDroppers([row(unit("nftt", 0, 0, 24)), row(unit("nftt", gap, 0, 24))], "camp", names).length;
  assert.equal(near(449), 1);
  assert.equal(near(451), 2);
});

test("a camp's level: its creeps' levels added up, in the game minimap's bands", () => {
  // A random level-4 creep (the file keeps the level in the first byte), a hero at level 3 (its own level, not its
  // type's), and creeps of their type's level.
  const random = unit("YYU4", 0, 0, 24, { randomLevel: "040000" }), hero = unit("Nbrn", 100, 0, 24, { level: 3 }), troll = unit("nftt", 200, 0, 24);
  assert.equal(creepLevel(random, facts()), 4);
  assert.equal(creepLevel(hero, { ...facts(), hero: true, level: 1 }), 3);
  assert.equal(creepLevel(troll, { ...facts(), level: 2 }), 2);
  assert.equal(creepLevel(troll, facts()), undefined, "a type without a known level");
  const rows = [row(random), row(hero), row(troll), row(tree(150, 50), "w3b")].map((r, i) => ({ ...r, level: [4, 3, 2, undefined][i] }));
  const names = { owner: () => "Neutral Hostile", type: (id: string) => id };
  const [camp] = groupDroppers(rows, "camp", names);
  // The crate isn't a creep: it adds nothing and isn't "unknown".
  assert.deepEqual(camp.level, { total: 9, strongest: 4, strength: "weak", unknown: 0 });
  assert.equal(campLevelText(camp.level!), "Level 9 (weak)");
  assert.equal(campLevel([5, 5]).strength, "middle");
  assert.equal(campLevel([9, 9, 1, 1]).strength, "tough");
  assert.equal(campLevel([19]).strength, "middle");
  assert.equal(campLevelText(campLevel([6, undefined])), "Level 6 (weak) + 1 unknown");
  // Groups that aren't camps have no level.
  assert.equal(groupDroppers([row(unit("hfoo", 0, 0, 0))], "camp", names)[0].level, undefined);
});

test("by owner and by type", () => {
  const rows = [row(unit("nftt", 0, 0, 24)), row(tree(10, 10), "w3b"), row(unit("hfoo", 0, 0, 1)), row(unit("nftt", 900, 0, 24)), row(unit("hfoo", 50, 0, 0))];
  const names = { owner: (p: number) => `P${p}`, type: (id: string) => ({ nftt: "Forest Troll", hfoo: "Footman", LTlt: "Tree" }[id] ?? id) };
  assert.deepEqual(groupDroppers(rows, "owner", names).map((g) => [g.title, g.rows.length]), [["P0", 1], ["P1", 1], ["P24", 2], ["Destructables", 1]]);
  assert.deepEqual(groupDroppers(rows, "type", names).map((g) => [g.title, g.rows.length]), [["Footman", 2], ["Forest Troll", 2], ["Tree", 1]]);
});

test("where each map item table is used, and tables used that the map hasn't", () => {
  const a = unit("nftt", 0, 0, 24, { itemTable: 3 }), b = tree(0, 0, { itemTable: 3 }), c = unit("nomg", 0, 0, 24, { itemTable: 7 }), d = unit("nomg", 0, 0, 24);
  const { used, missing } = tableUse([row(a), row(b, "w3b"), row(c), row(d)], [{ number: 3 }, { number: 4 }]);
  assert.deepEqual(used.get(3)?.map((r) => r.entry), [a, b]);
  assert.deepEqual(used.get(4), []);
  assert.deepEqual([...missing.keys()], [7]);
});

test("the different drops among several objects, most common first", () => {
  const same = [{ id: "YjI2", chance: 100 }];
  const a = unit("nftt", 0, 0, 24, { itemSets: [same] }), b = unit("nftt", 0, 0, 24, { itemSets: [same] }), c = unit("nomg", 0, 0, 24);
  const v = dropsVariants([c, a, b]);
  assert.deepEqual(v.map((x) => x.entries), [[a, b], [c]]);
  assert.deepEqual(v[0].drops, { mode: "custom", sets: [same] });
  assert.equal(dropsVariants([a, b]).length, 1);
});

test("a set added to each keeps what each drops already; a map item table is refused, not lost", () => {
  const set = [{ id: "ratf", chance: 100 }];
  const own = unit("nftt", 0, 0, 24, { itemSets: [[{ id: "YjI2", chance: 100 }]] }), none = unit("nomg", 0, 0, 24), tabled = unit("nomg", 0, 0, 24, { itemTable: 2 });
  const r = bulkDrops([own, none], { op: "addSet", set });
  assert.ok("drops" in r);
  assert.deepEqual(r.drops, [{ mode: "custom", sets: [[{ id: "YjI2", chance: 100 }], set] }, { mode: "custom", sets: [set] }]);
  // Nothing is changed by working it out.
  assert.deepEqual(sets(own), [[{ id: "YjI2", chance: 100 }]]);
  const refused = bulkDrops([own, tabled], { op: "addSet", set });
  assert.ok("error" in refused && /1 of them drop from a map item table/.test(refused.error));
  // Applied as one change per object: all of them change, and the set given isn't shared between them.
  const made = changeEach([own, none].map((entry, i) => ({ entry, facts: facts(), change: { field: "drops" as const, value: r.drops[i] } })));
  assert.ok("changed" in made && made.changed.length === 2);
  (sets(none) as { chance: number }[][])[0][0].chance = 5;
  assert.equal((sets(own) as { chance: number }[][])[1][0].chance, 100);
});

test("the same drops for several objects at once, and drops copied from one to others", () => {
  const source = unit("nomg", 0, 0, 24, { itemSets: [[{ id: "YjI2", chance: 60 }, { id: "ratf", chance: 40 }], [{ id: "YkI1", chance: 100 }]] });
  const targets = [unit("nftt", 0, 0, 24), unit("nftt", 0, 0, 24, { itemTable: 1 }), tree(0, 0)];
  const r = bulkDrops(targets, { op: "same", drops: dropsOf(source) });
  assert.ok("drops" in r);
  const kinds = ["w3u", "w3u", "w3b"];
  const made = changeEach(targets.map((entry, i) => ({ entry, facts: facts(kinds[i]), change: { field: "drops" as const, value: r.drops[i] } })));
  assert.ok("changed" in made && made.changed.length === 3);
  for (const t of targets) {
    assert.deepEqual(sets(t), sets(source));
    assert.equal((t as unknown as { itemTable: number }).itemTable, -1);
  }
  // Each its own copy: changing one later doesn't change the others or the source.
  (sets(targets[0]) as { chance: number }[][])[0][0].chance = 1;
  assert.equal((sets(targets[1]) as { chance: number }[][])[0][0].chance, 60);
  assert.equal((sets(source) as { chance: number }[][])[0][0].chance, 60);
});

test("copying a map item table to an object whose file has no table field changes none of them", () => {
  const source = unit("nomg", 0, 0, 24, { itemTable: 4 });
  const targets = [unit("nftt", 0, 0, 24), oldUnit("nftt", 0, 0)];
  const r = bulkDrops(targets, { op: "same", drops: dropsOf(source) });
  assert.ok("drops" in r);
  const before = JSON.stringify(targets);
  const made = changeEach(targets.map((entry, i) => ({ entry, facts: facts(), change: { field: "drops" as const, value: r.drops[i] } })), { tables: [4] });
  assert.ok("error" in made && /nftt: .*older layout/.test(made.error));
  assert.equal(JSON.stringify(targets), before);
});

test("Map Properties' item tables differ from the saved ones by name, number, item or chance, not by how they're written", () => {
  const saved = [{ number: 3, name: "Loot", sets: [[{ chance: 60, id: "ratf" }, { chance: 40, id: "YjI2" }]] }];
  const same = [{ number: 3, name: "Loot", sets: [[{ id: "ratf", chance: 60 }, { id: "YjI2", chance: 40 }]] }];
  assert.equal(itemTablesDiffer(same, saved), false);
  assert.equal(itemTablesDiffer([{ ...same[0], name: "Ogre Loot" }], saved), true);
  assert.equal(itemTablesDiffer([{ ...same[0], number: 4 }], saved), true);
  assert.equal(itemTablesDiffer([{ ...same[0], sets: [[{ id: "ratf", chance: 61 }, { id: "YjI2", chance: 40 }]] }], saved), true);
  assert.equal(itemTablesDiffer([...same, { number: 4, name: "New", sets: [] }], saved), true);
  assert.equal(itemTablesDiffer([], []), false);
  // A war3map.w3i that couldn't be read: whatever Map Properties holds is unsaved.
  assert.equal(itemTablesDiffer(same, null), true);
});
