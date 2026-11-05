import assert from "node:assert/strict";
import { test } from "node:test";
import type { FieldMeta } from "../../lib/objects/metadata";
import { changedFields, gameFields, mapObjectList, objectName, type MapObjects } from "./objectinfo";

const field = (id: string, label: string, repeat = 0) => ({ id, label, repeat }) as FieldMeta;
const kind = { names: new Map([["hfoo", "Footman"], ["AHbz", "Blizzard"]]), fieldById: new Map([["unam", field("unam", "Name")], ["uhpm", field("uhpm", "Hit Points")]]) };
const resolve = (v: string) => (v === "TRIGSTR_001" ? "|cffff0000Red|r Guard" : v);

const file: MapObjects = {
  custom: [{ base: "hfoo", id: "h000", mods: [{ field: "unam", value: "TRIGSTR_001" }, { field: "uhpm", value: 500 }] }],
  original: [{ base: "hfoo", mods: [{ field: "uhpm", value: 450 }] }],
};

test("names: the map's own, without colour codes, else the base's", () => {
  assert.equal(objectName(file.custom![0], kind, resolve), "Red Guard");
  assert.equal(objectName(file.original![0], kind, resolve), "Footman");
  assert.equal(objectName({ base: "xxxx" }, kind, resolve), "xxxx");
});

test("the map's list has new objects and changed game objects", () => {
  assert.deepEqual(mapObjectList(file, kind, resolve), [
    { id: "h000", base: "hfoo", name: "Red Guard", custom: true, changes: 2 },
    { id: "hfoo", name: "Footman", custom: false, changes: 1 },
  ]);
  assert.deepEqual(mapObjectList({}, kind, resolve), []);
});

test("changed fields say what they are, level values and data sets included", () => {
  assert.deepEqual(changedFields(file.custom![0], kind, resolve), [
    { field: "unam", label: "Name", value: "Red Guard" },
    { field: "uhpm", label: "Hit Points", value: 500 },
  ]);
  const ability = { base: "AHbz", sets: [{ mods: [{ field: "Hbz1", level: 2, value: 7 }] }] };
  assert.deepEqual(changedFields(ability, kind, resolve), [{ field: "Hbz1", label: "Hbz1", level: 2, value: 7 }]);
});

test("game fields skip what's empty, and repeating fields show level 1", () => {
  const levels: number[] = [];
  const game = {
    fieldsFor: () => [field("uhpm", "Hit Points"), field("udam", "Damage", 3), field("unot", "Nothing")],
    defaultValue: (_: string, f: FieldMeta, level: number) => { levels.push(level); return f.id === "unot" ? "" : "420"; },
  };
  assert.deepEqual(gameFields("hfoo", game).map((f) => f.field), ["uhpm", "udam"]);
  assert.deepEqual(levels, [0, 1, 0]);
});
