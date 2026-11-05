import assert from "node:assert/strict";
import { test } from "node:test";
import type { FieldMeta } from "../../lib/objects/metadata";
import { addCustomObject, fieldLevel, fieldValue, objectToEdit, removeObject, setObjectField, type EditFile, type EditObject } from "./objectedit";

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
