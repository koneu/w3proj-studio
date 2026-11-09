import assert from "node:assert/strict";
import { test } from "node:test";
import type { FieldMeta } from "../../lib/objects/metadata";
import { autoFill, autoFillText, mergeObjects, addCustomObject, copyOf, fieldLevel, fieldValue, negativeRefused, objectToEdit, pastedObject, removeObject, setObjectField, answerHolds, assertPlanFits, describeUse, rawOnlySkin, signature, kindsOf, summary, summaryTypes, withoutSkinEntries, writeInto, type EditFile, type EditObject } from "./objectedit";
import type { Plan, PlanItem } from "../../lib/objects/copydeps";

const field = (id: string, valueType: string, repeat = 0, data = 0) => ({ id, label: id.toUpperCase(), valueType, repeat, data }) as FieldMeta;
const file = (version = 3): EditFile => ({ format: "w3proj.objects/1", version, original: [], custom: [] });

test("values take their field's type", () => {
  assert.equal(fieldValue(field("uhpm", "int"), "500"), 500);
  assert.equal(fieldValue(field("usca", "real"), -1.5), -1.5);
  assert.equal(fieldValue(field("unam", "string"), 12), "12");
  assert.throws(() => fieldValue(field("uhpm", "int"), 1.5), /whole number/);
  assert.throws(() => fieldValue(field("uhpm", "int"), "many"), /takes a number/);
  assert.throws(() => fieldValue(field("uhpm", "int"), ""), /takes a number/);
  assert.throws(() => fieldValue(field("uhpm", "int"), true), /takes a number/);
  assert.throws(() => fieldValue(field("usca", "unreal"), -1), /negative/);
});

test("Allow negative real values: unreal fields take values below 0 only with the setting", () => {
  assert.throws(() => fieldValue(field("usca", "unreal"), -1, { allowNegative: false }), /Allow negative real values/);
  assert.equal(fieldValue(field("usca", "unreal"), -1, { allowNegative: true }), -1);
  assert.equal(fieldValue(field("usca", "unreal"), "-0.5", { allowNegative: true }), -0.5);
  // The setting changes nothing else: other types, 0 and up, what isn't a number.
  assert.equal(fieldValue(field("usca", "unreal"), 0), 0);
  assert.equal(fieldValue(field("uhpm", "int"), -3), -3);
  assert.throws(() => fieldValue(field("usca", "unreal"), "x", { allowNegative: true }), /takes a number/);
  assert.equal(negativeRefused("unreal", -1, false) !== null, true);
  assert.equal(negativeRefused("unreal", -1, true), null);
  assert.equal(negativeRefused("real", -1, false), null);
});

test("levels: from 1 where a field has them, none elsewhere", () => {
  assert.equal(fieldLevel(field("Hbz1", "real", 3), undefined), 1);
  assert.equal(fieldLevel(field("Hbz1", "real", 3), 2), 2);
  assert.throws(() => fieldLevel(field("Hbz1", "real", 3), 0), /level from 1/);
  assert.equal(fieldLevel(field("uhpm", "int"), undefined), 0);
  assert.throws(() => fieldLevel(field("uhpm", "int"), 2), /no levels/);
});

test("a game object gets an entry, in the form of the file's version", () => {
  const f = file();
  const o = objectToEdit(f, "hfoo", true);
  assert.deepEqual(o, { base: "hfoo", mods: [] });
  assert.equal(objectToEdit(f, "hfoo", true), o);
  assert.equal(f.original.length, 1);
  assert.deepEqual(objectToEdit(file(2), "hfoo", true), { base: "hfoo", end: "hfoo", mods: [] });
  assert.throws(() => objectToEdit(f, "zzzz", false), /no object/);
});

test("setting, changing and resetting a value", () => {
  const f = file();
  const hp = field("uhpm", "int");
  const o = objectToEdit(f, "hfoo", true);
  setObjectField(o, "w3u", hp, 0, 420, "420");
  assert.deepEqual(o.mods, [], "the game's own value needs no entry");
  setObjectField(o, "w3u", hp, 0, 500, "420");
  assert.deepEqual(o.mods, [{ field: "uhpm", type: "int", value: 500 }]);
  setObjectField(o, "w3u", hp, 0, 600, "420");
  assert.equal((o.mods as { value: unknown }[])[0].value, 600);
  setObjectField(o, "w3u", hp, 0, null, "420");
  assert.deepEqual(o.mods, []);
});

test("abilities and doodads store level and data with each value; sets are looked through", () => {
  const f = file();
  const o = objectToEdit(f, "AHbz", true);
  setObjectField(o, "w3a", field("Hbz1", "real", 3, 2), 2, 7, "5");
  assert.deepEqual(o.mods, [{ field: "Hbz1", type: "real", value: 7, level: 2, data: 2 }]);
  const inSet: EditObject = { base: "gxyz", sets: [{ flag: 0, mods: [] }, { flag: 1, mods: [{ field: "gnam", type: "string", value: "a", level: 0 }] }] };
  setObjectField(inSet, "w3q", field("gnam", "string"), 0, "b", "");
  assert.equal(inSet.sets![1].mods[0].value, "b");
  assert.equal(inSet.sets![0].mods.length, 0);
});

test("new objects, and removing them or a game object's changes", () => {
  const f = file(2);
  assert.deepEqual(addCustomObject(f, "hfoo", "h000"), { base: "hfoo", id: "h000", end: "h000", mods: [] });
  objectToEdit(f, "hpea", true);
  assert.equal(removeObject(f, "h000"), true);
  assert.equal(removeObject(f, "hpea"), true);
  assert.equal(removeObject(f, "hpea"), false);
  assert.deepEqual([f.custom.length, f.original.length], [0, 0]);
});

const text = (v: string) => (v === "TRIGSTR_007" ? "Hero of the Storm" : null);

test("a copy holds its own text, and leaves the original alone", () => {
  const o = { base: "hfoo", id: "h000", mods: [{ field: "unam", type: "string", value: "TRIGSTR_007" }, { field: "uhpm", type: "int", value: 500 }] };
  const copy = copyOf(o, text);
  assert.equal(copy.mods?.[0].value, "Hero of the Storm");
  assert.equal(copy.mods?.[1].value, 500);
  assert.equal(o.mods[0].value, "TRIGSTR_007");
});

test("a copy of an object with sets holds its texts too", () => {
  const o = { base: "hfoo", sets: [{ flag: 0, mods: [{ field: "unam", type: "string", value: "TRIGSTR_007" }] }] };
  assert.equal(copyOf(o, text).sets?.[0].mods[0].value, "Hero of the Storm");
});

test("a string that isn't a reference stays as it is", () => {
  const o = { base: "hfoo", mods: [{ field: "umdl", type: "string", value: "units\\human\\Footman" }] };
  assert.equal(copyOf(o, text).mods?.[0].value, "units\\human\\Footman");
});

test("a pasted object is new, whatever it was copied from", () => {
  const custom = { base: "hfoo", id: "h000", mods: [{ field: "uhpm", type: "int", value: 500 }] };
  const pasted = pastedObject(custom, "h001", 3);
  assert.deepEqual([pasted.base, pasted.id, pasted.mods?.[0].value], ["hfoo", "h001", 500]);
  assert.notEqual(pasted.mods, custom.mods, "a separate object: changing one mustn't change the other");
  const standard = pastedObject({ base: "hfoo", mods: [] }, "h002", 3);
  assert.deepEqual([standard.base, standard.id], ["hfoo", "h002"]);
});

test("older files keep their end marker right", () => {
  assert.equal(pastedObject({ base: "hfoo", id: "h000", end: "h000", mods: [] }, "h001", 2).end, "h001");
  assert.ok(!("end" in pastedObject({ base: "hfoo", id: "h000", end: "h000", mods: [] }, "h001", 3)));
});

test("Auto Fill: each level from the one before, its number and a constant", () => {
  assert.deepEqual(autoFill({ from: 1, to: 3, base: 100, previous: 1, level: 0, constant: 25 }).map((r) => r.value), [100, 125, 150]);
  assert.deepEqual(autoFill({ from: 1, to: 3, base: 10, previous: 2, level: 0, constant: 0 }).map((r) => r.value), [10, 20, 40]);
  assert.deepEqual(autoFill({ from: 1, to: 3, base: 0, previous: 0, level: 5, constant: 1 }).map((r) => r.value), [0, 11, 16], "a level's number, not its distance");
  assert.deepEqual(autoFill({ from: 2, to: 4, base: 7, previous: 1, level: 0, constant: 0 }).map((r) => r.level), [2, 3, 4], "levels before the start stay out");
  assert.equal(autoFill({ from: 3, to: 3, base: 1, previous: 9, level: 9, constant: 9 }).length, 1);
});

test("Auto Fill on text puts the level where the mark is", () => {
  assert.deepEqual(autoFillText("Deals # damage, # times", "#", 1, 2).map((r) => r.value), ["Deals 1 damage, 1 times", "Deals 2 damage, 2 times"]);
  assert.deepEqual(autoFillText("Same", "", 1, 2).map((r) => r.value), ["Same", "Same"], "no mark, no change");
});

test("importing replaces by id or base, adds the rest, and shares nothing", () => {
  const file = { format: "x", version: 3, custom: [{ base: "hfoo", id: "h000", mods: [] }], original: [{ base: "hpea", mods: [] as { field: string; type: string; value: number }[] }] };
  const incoming = { custom: [{ base: "hrif", id: "h000", mods: [] }, { base: "hkni", id: "h001", mods: [] }], original: [{ base: "hpea", mods: [{ field: "uhpm", type: "int", value: 9 }] }, { base: "hfoo", mods: [] }] };
  assert.deepEqual(mergeObjects(file, incoming), { added: 2, replaced: 2 });
  assert.equal(file.custom[0].base, "hrif");
  assert.equal(file.custom.length, 2);
  assert.equal(file.original[0].mods![0].value, 9);
  incoming.original[0].mods![0].value = 1;
  assert.equal(file.original[0].mods![0].value, 9);
});

const item = (fate: PlanItem["fate"]): PlanItem => ({ ext: "w3a", object: { base: "AHhb", id: "A001" }, fate });
const plan = (writes: Plan["writes"], fates: PlanItem["fate"][] = []): Plan => ({ items: fates.map(item), conflicts: [], renames: new Map(), writes });

test("a paste's objects go into the file of their kind: new ones at the end, overwritten ones in place", () => {
  const f = file();
  f.custom.push({ base: "AHhb", id: "A001", mods: [{ field: "anam", type: "string", value: "old" }] }, { base: "AHhb", id: "A002", mods: [] });
  const p = plan([
    { ext: "w3a", object: { base: "AHhb", id: "A001", mods: [{ field: "anam", type: "string", value: "new" }] }, overwrites: "A001" },
    { ext: "w3a", object: { base: "AHhb", id: "A003", end: "A003" } },
    { ext: "w3u", object: { base: "hfoo", id: "h000" } },
  ]);
  assert.deepEqual(kindsOf(p), ["w3a", "w3u"]);
  const made = writeInto(f, "w3a", p);
  assert.deepEqual(f.custom.map((o) => o.id), ["A001", "A002", "A003"]);
  assert.equal(f.custom[0].mods![0].value, "new");
  assert.equal(made.length, 2);
  assert.equal(f.custom[2].end, undefined, "a version 3 file has no end marker");
  const old = file(2);
  writeInto(old, "w3a", plan([{ ext: "w3a", object: { base: "AHhb", id: "A009" } }]));
  assert.equal(old.custom[0].end, "A009", "an older file keeps its end marker");
  assert.equal(f.custom.length, 3, "the file of another kind is left alone");
  assert.deepEqual(writeInto(file(), "w3q", p), []);
});

test("an overwrite of an id the file no longer has adds the object", () => {
  const f = file();
  writeInto(f, "w3a", plan([{ ext: "w3a", object: { base: "AHhb", id: "A001" }, overwrites: "A001" }]));
  assert.deepEqual(f.custom.map((o) => o.id), ["A001"]);
});

test("the message after a paste counts what was pasted, what came along and what was there", () => {
  assert.equal(summary(plan([], ["chosen"])), "Pasted 1 object.");
  assert.equal(summary(plan([], ["chosen", "chosen", "add", "renamed", "same"])), "Pasted 2 objects and 2 objects they refer to; 1 object they refer to was in the map already.");
  assert.equal(summary(plan([], ["chosen", "overwritten", "kept", "same"])), "Pasted 1 object and 1 object they refer to; 2 objects they refer to were in the map already.");
  assert.equal(summaryTypes(plan([], ["add", "add", "same"])), "Added 2 objects to the map for the pasted ones; 1 was there already.");
  assert.equal(summaryTypes(plan([], ["add"])), "Added 1 object to the map for the pasted ones.");
});

test("the message after a map piece's paste counts overwritten and renamed objects as added", () => {
  assert.equal(summaryTypes(plan([], ["add", "overwritten", "renamed", "kept"])), "Added 3 objects to the map for the pasted ones; 1 was there already.");
});

test("an id that came into the file since the plan was made stops the paste, and nothing is pushed", () => {
  const f = file();
  f.custom.push({ base: "AHhb", id: "A003", mods: [] });
  const p = plan([
    { ext: "w3a", object: { base: "AHhb", id: "A002" } },
    { ext: "w3a", object: { base: "AHhb", id: "A003" } },
  ]);
  assert.throws(() => writeInto(f, "w3a", p), /A003 is used in the map already/);
  assert.deepEqual(f.custom.map((o) => o.id), ["A003"], "the first object wasn't pushed either");
  const over = plan([{ ext: "w3a", object: { base: "AHhb", id: "A003" }, overwrites: "A003" }]);
  assert.doesNotThrow(() => writeInto(f, "w3a", over));
  assert.throws(() => writeInto(f, "w3a", plan([{ ext: "w3a", object: { base: "AHhb", id: "A004" }, overwrites: "A003" }])), /would write A004/);
});

test("the plan is held against the ids the map has when it is written", () => {
  const ids = new Map([["A001", "w3a"], ["h000", "w3u"], ["hfoo", "w3u"]]);
  const add = (id: string) => plan([{ ext: "w3a", object: { base: "AHhb", id } }]);
  assert.doesNotThrow(() => assertPlanFits(add("A002"), ids));
  assert.throws(() => assertPlanFits(add("A001"), ids), /A001 is used in the map/, "taken by a custom object since");
  assert.throws(() => assertPlanFits(add("hfoo"), ids), /hfoo is used/, "a game object's id");
  const over = (id: string, ext = "w3a") => plan([{ ext, object: { base: "AHhb", id }, overwrites: id }]);
  assert.doesNotThrow(() => assertPlanFits(over("A001"), ids));
  assert.throws(() => assertPlanFits(over("A009"), ids), /A009 is gone/);
  assert.throws(() => assertPlanFits(over("h000"), ids), /h000 is used/, "an overwrite finds another kind's object");
});

test("overwritten objects lose their Skin entry; a Skin file without them is left alone", () => {
  const skin: EditFile = { format: "w3proj.objects/1", version: 3, original: [{ base: "hfoo", mods: [] }], custom: [{ base: "AHhb", id: "A001", mods: [{ field: "anam", type: "string", value: "skin" }] }, { base: "AHhb", id: "A002", mods: [] }] };
  const rest = withoutSkinEntries(skin, new Set(["A001", undefined]))!;
  assert.deepEqual(rest.custom.map((o) => o.id), ["A002"]);
  assert.equal(rest.original.length, 1);
  assert.equal(skin.custom.length, 2, "the Skin file given is untouched");
  assert.equal(withoutSkinEntries(skin, new Set(["A009"])), null);
});

test("an earlier answer holds only while its objects are there as they were", () => {
  const a = { base: "AHhb", id: "A001", mods: [{ field: "anam", value: "x" }] };
  const targets = new Map([["A001", signature(a)], ["B001", signature({ base: "Bslo", id: "B001" })]]);
  const now = (changed?: unknown, gone = false) => (id: string) => (id === "A001" ? changed ?? a : gone ? undefined : { base: "Bslo", id: "B001" });
  assert.equal(answerHolds(targets, now()), true);
  assert.equal(answerHolds(targets, now({ ...a, mods: [{ field: "anam", value: "y" }] })), false, "an object edited since");
  assert.equal(answerHolds(targets, now(undefined, true)), false, "an object gone, as after an undo");
  assert.equal(answerHolds(new Map(), () => undefined), true);
  assert.notEqual(signature(undefined), signature({}), "nothing is not an empty object");
});

test("a Skin file kept raw only is told from one with a JSON form", () => {
  assert.equal(rawOnlySkin(["map/war3mapSkin.w3h"], "w3h"), true);
  assert.equal(rawOnlySkin(["map/war3mapSkin.w3h", "map/war3mapSkin.w3h.json"], "w3h"), false);
  assert.equal(rawOnlySkin(["map/war3map.w3h.json"], "w3h"), false, "no Skin file at all");
  assert.equal(rawOnlySkin(["map/war3mapSkin.w3a"], "w3h"), false, "another kind's");
});

test("the overwrite prompt names the use of an id, and says when the placements couldn't be read", () => {
  assert.equal(describeUse("B001", { objects: 1, placed: 0 }), "B001: 1 object, 0 placed");
  assert.equal(describeUse("B001", { objects: 2, placed: 3 }), "B001: 2 objects, 3 placed");
  assert.equal(describeUse("B001", { objects: 0, placed: null }), "B001: 0 objects, an unknown number of placed");
});
