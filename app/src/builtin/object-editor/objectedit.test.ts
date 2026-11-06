import assert from "node:assert/strict";
import { test } from "node:test";
import type { FieldMeta } from "../../lib/objects/metadata";
import { autoFill, autoFillText, mergeObjects, addCustomObject, copyOf, fieldLevel, fieldValue, objectToEdit, pastedObject, removeObject, setObjectField, type EditFile, type EditObject } from "./objectedit";

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
