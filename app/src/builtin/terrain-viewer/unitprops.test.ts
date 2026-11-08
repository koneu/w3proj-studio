import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyChange, attributesAt, changeAll, checkChange, commonFields, dropsOf, fieldsFor, fitSkills, heroPools, maxSkillLevel, propSnapshot,
  randomItemLabel, redistribute, setTotal, type TypeFacts,
} from "./unitprops";
import type { Placed } from "./objects";

const facts = (more: Partial<TypeFacts> = {}): TypeFacts => ({
  kind: "w3u", hero: false, building: false, invulnerable: false, attacks: true, acquireRange: 500, maxHp: 420, maxMana: 0, skills: [], slots: 0,
  goldMine: false, waygate: false, maxLevel: 10, levelSkip: 2, ...more,
});
// The Paladin as the game has it: three skills of three levels from hero level 1, an ultimate at 6.
const PALADIN = facts({
  hero: true, maxHp: 100, maxMana: 0, slots: 6,
  attributes: { str: 22, agi: 13, int: 17, strPlus: 2.7, agiPlus: 1.5, intPlus: 1.8, hpPerStr: 25, manaPerInt: 15 },
  skills: [{ id: "AHhb", levels: 3, req: 1, skip: 0 }, { id: "AHds", levels: 3, req: 1, skip: 0 }, { id: "AHad", levels: 3, req: 1, skip: 0 }, { id: "AHre", levels: 1, req: 6, skip: 0 }],
});

/** A unit as World Editor 2.0 writes it (war3mapUnits.doo version 8, subversion 11): every value at its default. */
const unit = (id: string, more: Record<string, unknown> = {}): Placed => ({
  id, variation: 0, position: [0, 0, 0], angle: 0, scale: [1, 1, 1], skinId: id, flags: 2, player: 0, unknown1: 0, unknown2: 0,
  hp: -1, mana: -1, itemTable: -1, itemSets: [], gold: 12500, targetAcquisition: -1, level: 1, strength: 0, agility: 0, intelligence: 0,
  inventory: [], abilities: [], randomType: 0, randomLevel: "010000", randomClass: 0, color: -1, waygate: -1, editorId: 0, ...more,
} as unknown as Placed);
/** The pre-1.32 layout (subversion 9): no item table, no hero attributes. */
const oldUnit = (id: string) => {
  const u = unit(id) as unknown as Record<string, unknown>;
  for (const k of ["itemTable", "strength", "agility", "intelligence"]) delete u[k];
  return u as unknown as Placed;
};
const destructable = (more: Record<string, unknown> = {}): Placed =>
  ({ id: "LTlt", variation: 0, position: [0, 0, 0], angle: 0, scale: [1, 1, 1], flags: 2, life: 100, itemTable: -1, itemSets: [], editorId: 0, ...more } as unknown as Placed);
const get = (e: Placed) => e as unknown as Record<string, unknown>;

// What the World Editor's Unit Properties showed on 2026-11-08 (we-drive, a copy of Turtle Rock with these placed):
// a Paladin hit points, mana, level, attributes and the acquisition range, Abilities, Inventory and Items Dropped;
// a footman hit points and the range, Inventory, Items Dropped; a barracks only hit points; a gold mine only its
// gold; a waygate its destination and Custom Color, no hit points. Drops on all of them.
test("only the fields that apply to a type are shown, as in the World Editor", () => {
  assert.deepEqual(fieldsFor(unit("hfoo"), facts()), ["hp", "acquire", "drops"]);
  assert.deepEqual(fieldsFor(unit("hfoo"), facts({ slots: 6 })), ["hp", "inventory", "acquire", "drops"]);
  assert.deepEqual(fieldsFor(unit("Hpal"), PALADIN), ["hp", "mana", "level", "attributes", "skills", "inventory", "acquire", "drops"]);
  assert.deepEqual(fieldsFor(unit("hbar"), facts({ building: true, attacks: false, maxHp: 1500 })), ["hp", "drops"]);
  assert.deepEqual(fieldsFor(unit("ngol"), facts({ goldMine: true, building: true, invulnerable: true, attacks: false })), ["gold", "drops"]);
  assert.deepEqual(fieldsFor(unit("nwgt"), facts({ waygate: true, building: true, invulnerable: true, attacks: false })), ["waygate", "color", "drops"]);
  assert.ok(!fieldsFor(unit("hfoo"), facts()).includes("gold"), "a footman's 12500 isn't gold");
  assert.ok(fieldsFor(unit("nmrl"), facts({ maxMana: 200 })).includes("mana"));
  // A value that isn't the default shows anyway, so it can be set back.
  assert.ok(fieldsFor(unit("ngol", { hp: 50 }), facts({ goldMine: true, invulnerable: true })).includes("hp"));
  assert.ok(fieldsFor(unit("hbar", { targetAcquisition: -2 }), facts({ attacks: false })).includes("acquire"));
  assert.deepEqual(fieldsFor(unit("sloc"), facts()), [], "a start location has none");
  assert.deepEqual(fieldsFor(unit("ratf"), facts({ kind: "w3t" })), []);
  assert.deepEqual(fieldsFor(destructable(), facts({ kind: "w3b" })), ["life", "drops"]);
  assert.deepEqual(fieldsFor(destructable({ id: "CPct", life: 255 }), facts({ kind: "w3d" })), [], "a plain doodad can't die");
  assert.deepEqual(fieldsFor(destructable({ id: "CPct", itemSets: [[{ id: "ratf", chance: 100 }]] }), facts({ kind: "w3d" })), ["drops"], "drops it has can be taken off");
});

test("a field the file's layout doesn't have is never offered or added", () => {
  const old = oldUnit("Hpal");
  assert.ok(!fieldsFor(old, PALADIN).includes("attributes"));
  assert.match(checkChange(old, PALADIN, { field: "attributes", value: [20, 20, 20] }) ?? "", /no hero attributes/);
  assert.match(checkChange(old, PALADIN, { field: "drops", value: { mode: "table", table: 0 } }) ?? "", /older layout/);
  // Its own sets are fine, and the item table stays out of the entry.
  assert.equal(checkChange(old, PALADIN, { field: "drops", value: { mode: "custom", sets: [[{ id: "ratf", chance: 100 }]] } }), null);
  applyChange(old, PALADIN, { field: "drops", value: { mode: "custom", sets: [[{ id: "ratf", chance: 100 }]] } });
  assert.equal("itemTable" in old, false);
  const v7 = destructable() as unknown as Record<string, unknown>;
  delete v7.itemTable; delete v7.itemSets;
  assert.deepEqual(fieldsFor(v7 as unknown as Placed, facts({ kind: "w3b" })), ["life"]);
});

test("a change leaves every other value as stored, defaults included", () => {
  const u = unit("Hpal");
  const before = propSnapshot(u);
  assert.equal(applyChange(u, PALADIN, { field: "hp", value: 50 }), true);
  const after = propSnapshot(u);
  assert.deepEqual({ ...after, hp: -1 }, before);
  assert.equal(get(u).mana, -1);
  assert.equal(get(u).gold, 12500, "what a hero has in the gold field stays");
  // The same value again changes nothing.
  assert.equal(applyChange(u, PALADIN, { field: "hp", value: 50 }), false);
  // Empty boxes give the default back.
  applyChange(u, PALADIN, { field: "hp", value: -1 });
  assert.deepEqual(propSnapshot(u), before);
});

test("values outside the World Editor's ranges are refused", () => {
  const u = unit("Hpal"), f = PALADIN;
  const ok = (c: Parameters<typeof checkChange>[2]) => checkChange(u, f, c) === null;
  assert.ok(ok({ field: "hp", value: -1 }) && ok({ field: "hp", value: 1 }) && ok({ field: "hp", value: 100 }));
  assert.ok(!ok({ field: "hp", value: 0 }) && !ok({ field: "hp", value: 101 }) && !ok({ field: "hp", value: 50.5 }));
  assert.ok(ok({ field: "mana", value: 0 }) && ok({ field: "mana", value: -1 }) && !ok({ field: "mana", value: -2 }));
  assert.ok(ok({ field: "acquire", value: -1 }) && ok({ field: "acquire", value: -2 }) && ok({ field: "acquire", value: 750.5 }));
  assert.ok(!ok({ field: "acquire", value: 0 }) && !ok({ field: "acquire", value: -3 }) && !ok({ field: "acquire", value: 5001 }));
  assert.ok(ok({ field: "level", value: 10 }) && !ok({ field: "level", value: 11 }) && !ok({ field: "level", value: 0 }));
  assert.match(checkChange(u, f, { field: "color", value: 3 }) ?? "", /Only a waygate/);
  const wg = unit("nwgt"), wf = facts({ waygate: true });
  assert.ok([-1, 0, 23].every((value) => checkChange(wg, wf, { field: "color", value }) === null) && checkChange(wg, wf, { field: "color", value: 24 }));
  assert.ok(ok({ field: "attributes", value: null }) && ok({ field: "attributes", value: [1, 1, 1] }) && !ok({ field: "attributes", value: [0, 5, 5] }));
  assert.ok(ok({ field: "slot", slot: 5, id: "ratf" }) && !ok({ field: "slot", slot: 6, id: "ratf" }) && !ok({ field: "slot", slot: 0, id: "rat" }));
  assert.match(checkChange(unit("hfoo"), facts(), { field: "level", value: 3 }) ?? "", /Only heroes/);
  assert.match(checkChange(unit("hfoo"), facts(), { field: "waygate", value: 2 }) ?? "", /Only waygates/);
  const gate = facts({ waygate: true });
  assert.equal(checkChange(unit("nwgt"), gate, { field: "waygate", value: 2 }, { regions: [0, 2] }), null);
  assert.match(checkChange(unit("nwgt"), gate, { field: "waygate", value: 3 }, { regions: [0, 2] }) ?? "", /region/);
  assert.ok(checkChange(unit("ngol"), facts({ goldMine: true }), { field: "gold", value: 1000001 }));
  const d = destructable(), b = facts({ kind: "w3b" });
  assert.equal(checkChange(d, b, { field: "life", value: 0 }), null, "0 places it dead");
  assert.ok(checkChange(d, b, { field: "life", value: 101 }));
});

test("a level 1 hero learns one skill level; an ultimate waits for level 6", () => {
  const [bolt, , , ult] = PALADIN.skills;
  assert.deepEqual([1, 2, 3, 4, 5, 6].map((l) => maxSkillLevel(bolt, l)), [1, 1, 2, 2, 3, 3]);
  assert.deepEqual([5, 6, 10].map((l) => maxSkillLevel(ult, l)), [0, 1, 1]);
  assert.equal(maxSkillLevel({ id: "X", levels: 3, req: 1, skip: 1 }, 2), 2, "a skill's own level skip");
  assert.equal(maxSkillLevel(bolt, 3, 1), 3, "the map's HeroAbilityLevelSkip");
  const u = unit("Hpal", { level: 3 });
  assert.equal(checkChange(u, PALADIN, { field: "skill", id: "AHhb", level: 2 }), null);
  applyChange(u, PALADIN, { field: "skill", id: "AHhb", level: 2 });
  assert.match(checkChange(u, PALADIN, { field: "skill", id: "AHds", level: 2 }) ?? "", /3 skill points; 2 are spent/);
  assert.match(checkChange(u, PALADIN, { field: "skill", id: "AHhb", level: 3 }) ?? "", /up to level 2/);
  assert.match(checkChange(u, PALADIN, { field: "skill", id: "AHre", level: 1 }) ?? "", /up to level 0/);
  assert.match(checkChange(u, PALADIN, { field: "skill", id: "AUdc", level: 1 }) ?? "", /isn't one of this hero's/);
  applyChange(u, PALADIN, { field: "skill", id: "AHds", level: 1 });
  assert.deepEqual(get(u).abilities, [{ id: "AHhb", autocast: 0, level: 2 }, { id: "AHds", autocast: 0, level: 1 }]);
  // Back to 0: the entry goes, as the World Editor's files have no level-0 skills.
  applyChange(u, PALADIN, { field: "skill", id: "AHhb", level: 0 });
  assert.deepEqual(get(u).abilities, [{ id: "AHds", autocast: 0, level: 1 }]);
});

test("lowering a hero's level takes back the skill levels it no longer has, in one change", () => {
  const u = unit("Hpal", { level: 6, abilities: [{ id: "AHhb", autocast: 0, level: 3 }, { id: "AHds", autocast: 0, level: 2 }, { id: "AHre", autocast: 0, level: 1 }] });
  assert.equal(checkChange(u, PALADIN, { field: "level", value: 3 }), null);
  applyChange(u, PALADIN, { field: "level", value: 3 });
  // At level 3: the bolt down to 2, no ultimate, one point left for the second skill.
  assert.deepEqual(get(u).abilities, [{ id: "AHhb", autocast: 0, level: 2 }, { id: "AHds", autocast: 0, level: 1 }]);
  assert.equal(get(u).level, 3);
  // An autocast setting of a non-skill ability stays, and isn't counted against the points.
  const kept = fitSkills([{ id: "Adef", autocast: 1, level: 0 }, { id: "AHhb", autocast: 0, level: 3 }], PALADIN, 1);
  assert.deepEqual(kept, [{ id: "Adef", autocast: 1, level: 0 }, { id: "AHhb", autocast: 0, level: 1 }]);
});

test("the default attributes are the hero's at its level", () => {
  assert.deepEqual(attributesAt(PALADIN, 1), [22, 13, 17]);
  assert.deepEqual(attributesAt(PALADIN, 10), [46, 26, 33]);
  const u = unit("Hpal");
  applyChange(u, PALADIN, { field: "attributes", value: [30, 20, 10] });
  assert.deepEqual([get(u).strength, get(u).agility, get(u).intelligence], [30, 20, 10]);
  applyChange(u, PALADIN, { field: "attributes", value: null });
  assert.deepEqual([get(u).strength, get(u).agility, get(u).intelligence], [0, 0, 0], "0 is \"use default\"");
});

test("a hero's hit points and mana grow with its attributes, as the World Editor's \"of …\" shows", () => {
  // Seen: a level 5 Paladin with strength 30, intelligence 25 is "of 850" and "of 375".
  assert.deepEqual(heroPools(PALADIN, unit("Hpal", { level: 5, strength: 30, agility: 20, intelligence: 25 })), [850, 375]);
  // Default attributes: those of its level (level 1: 22 and 17).
  assert.deepEqual(heroPools(PALADIN, unit("Hpal")), [100 + 22 * 25, 17 * 15]);
  assert.equal(heroPools(facts(), unit("hfoo")), null);
});

test("random item ids read as what they drop", () => {
  assert.equal(randomItemLabel("YiI2"), "Random item (permanent, level 2)");
  assert.equal(randomItemLabel("YYI/"), "Random item (any class, any level)");
  assert.equal(randomItemLabel("ratf"), undefined);
  assert.equal(randomItemLabel("YzI2"), undefined);
});

test("redistributing spreads 100 over the set, the first items taking the rest", () => {
  const set = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `itm${i}`, chance: 7 }));
  assert.deepEqual(redistribute(set(3)).map((x) => x.chance), [34, 33, 33]);
  assert.deepEqual(redistribute(set(1)).map((x) => x.chance), [100]);
  assert.deepEqual(redistribute(set(4)).map((x) => x.chance), [25, 25, 25, 25]);
  assert.deepEqual(redistribute([]), []);
  for (let n = 1; n <= 12; n++) assert.equal(setTotal(redistribute(set(n))), 100, `${n} items`);
  assert.deepEqual(redistribute(set(2)).map((x) => x.id), ["itm0", "itm1"], "the items stay");
});

test("drops: a map table, own sets or nothing, and the file's fields follow", () => {
  const u = unit("hfoo"), f = facts();
  assert.deepEqual(dropsOf(u), { mode: "none" });
  assert.match(checkChange(u, f, { field: "drops", value: { mode: "table", table: 4 } }, { tables: [0, 1] }) ?? "", /no item table #4/);
  applyChange(u, f, { field: "drops", value: { mode: "table", table: 1 } });
  assert.deepEqual([get(u).itemTable, get(u).itemSets], [1, []]);
  assert.deepEqual(dropsOf(u), { mode: "table", table: 1 });
  const sets = [[{ id: "rat9", chance: 34 }, { id: "YiI2", chance: 66 }], []];
  applyChange(u, f, { field: "drops", value: { mode: "custom", sets } });
  assert.deepEqual([get(u).itemTable, get(u).itemSets], [-1, sets]);
  sets[0][0].chance = 1;
  assert.equal((get(u).itemSets as { chance: number }[][])[0][0].chance, 34, "the entry has its own copy");
  // An empty set is kept: the World Editor writes one for "own sets" with nothing in them.
  assert.deepEqual(dropsOf(unit("hfoo", { itemSets: [[]] })), { mode: "custom", sets: [[]] });
  assert.match(checkChange(u, f, { field: "drops", value: { mode: "custom", sets: [[{ id: "ratf", chance: 101 }]] } }) ?? "", /0 to 100/);
  assert.equal(checkChange(u, f, { field: "drops", value: { mode: "custom", sets: [[{ id: "ratf", chance: 80 }, { id: "rat6", chance: 80 }]] } }), null, "a total past 100 is let through");
  assert.equal(checkChange(u, f, { field: "drops", value: { mode: "custom", sets: [[{ id: "0x00000000", chance: 50 }]] } }), null, "an empty slot");
  applyChange(u, f, { field: "drops", value: { mode: "none" } });
  assert.deepEqual([get(u).itemTable, get(u).itemSets], [-1, []]);
});

test("inventory slots stay in order and empty slots leave the list", () => {
  const u = unit("Hpal");
  applyChange(u, PALADIN, { field: "slot", slot: 3, id: "ratf" });
  applyChange(u, PALADIN, { field: "slot", slot: 0, id: "ankh" });
  applyChange(u, PALADIN, { field: "slot", slot: 5, id: "pghe" });
  assert.deepEqual(get(u).inventory, [{ slot: 0, id: "ankh" }, { slot: 3, id: "ratf" }, { slot: 5, id: "pghe" }]);
  applyChange(u, PALADIN, { field: "slot", slot: 3, id: "bgst" });
  applyChange(u, PALADIN, { field: "slot", slot: 0, id: null });
  assert.deepEqual(get(u).inventory, [{ slot: 3, id: "bgst" }, { slot: 5, id: "pghe" }]);
});

test("several objects change all together, or none when one refuses", () => {
  const a = unit("hfoo"), b = unit("Hpal", { level: 1 });
  const items = [{ entry: a, facts: facts() }, { entry: b, facts: PALADIN }];
  assert.deepEqual(commonFields(items), ["hp", "acquire", "drops"]);
  const r = changeAll(items, { field: "hp", value: 40 });
  assert.ok("changed" in r && r.changed.length === 2);
  assert.deepEqual([get(a).hp, get(b).hp], [40, 40]);
  // The footman can't have a level: the hero isn't changed either.
  const before = [propSnapshot(a), propSnapshot(b)];
  const refused = changeAll([{ entry: b, facts: PALADIN }, { entry: a, facts: facts() }], { field: "level", value: 2 });
  assert.ok("error" in refused && /hfoo: Only heroes/.test(refused.error));
  assert.deepEqual([propSnapshot(a), propSnapshot(b)], before);
  // Nothing to change: nothing reported, so no undo step.
  const same = changeAll(items, { field: "hp", value: 40 });
  assert.ok("changed" in same && same.changed.length === 0);
});

test("skills and attributes are common only to one type; inventory to as many slots", () => {
  const h1 = { entry: unit("Hpal"), facts: PALADIN }, h2 = { entry: unit("Hpal"), facts: PALADIN };
  const other = { entry: unit("Hmkg"), facts: { ...PALADIN, skills: [{ id: "AHtb", levels: 3, req: 1, skip: 0 }] } };
  assert.ok(commonFields([h1, h2]).includes("skills"));
  const mixed = commonFields([h1, other]);
  assert.ok(!mixed.includes("skills") && !mixed.includes("attributes") && mixed.includes("level") && mixed.includes("inventory"));
  const pack = { entry: unit("hpea"), facts: facts({ slots: 2 }) };
  assert.ok(!commonFields([h1, pack]).includes("inventory"));
});
