import assert from "node:assert/strict";
import { test } from "node:test";
import { idsInText, markUnused, objectRefs, type Node } from "./data";

const ids = new Set(["Xs01", "Y01q", "h000"]);

test("object references: lists and single values, not the object itself", () => {
  const refs = objectRefs([{ ext: "w3u", label: "Unit", objects: [
    { id: "h000", base: "hfoo", mods: [{ value: "AHbz,Y01q,Xs01" }, { value: 12 }, { value: "h000" }] },
    { base: "hpea", mods: [{ value: "Y01q" }] },
  ] }], ids, (id) => id.toUpperCase());
  assert.deepEqual([...refs.get("Y01q")!.keys()].sort(), ["Unit: H000", "Unit: HPEA"]);
  assert.deepEqual(refs.get("Y01q")!.get("Unit: H000"), { kind: "object", ext: "w3u", id: "h000" });
  assert.equal(refs.has("h000"), false);
});

test("object references in a version 3 object's sets", () => {
  const refs = objectRefs([{ ext: "w3a", label: "Ability", objects: [{ id: "Xs01", base: "AHbz", sets: [{ mods: [{ value: "Y01q" }] }] }] }], ids, (id) => id);
  assert.deepEqual([...refs.get("Y01q")!.keys()], ["Ability: Xs01"]);
});

test("ids in texts: whole words of JASS, Lua and JSON only", () => {
  assert.deepEqual(idsInText("call CreateUnit(p, 'h000', 0, 0, 0)", ids), ["h000"]);
  assert.deepEqual(idsInText('CreateItem(FourCC("Xs01"), 0, 0) "id":"Y01q"', ids).sort(), ["Xs01", "Y01q"]);
  assert.deepEqual(idsInText("xh000 h0001 h000x", ids), []);
});

test("only custom objects count, wherever they are in the tree", () => {
  const tree: Node[] = [{ label: "Custom", children: [{ label: "Units", children: [
    { label: "a", ref: "aaaa", custom: true }, { label: "b", ref: "bbbb", custom: true },
  ] }] }, { label: "Placed", ref: "cccc" }];
  assert.equal(markUnused(tree, (id) => id === "aaaa"), 1);
  const units = tree[0].children![0].children!;
  assert.equal(units[0].unused, false);
  assert.equal(units[1].unused, true);
  assert.equal(tree[1].unused, undefined);
});
