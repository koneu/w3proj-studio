import assert from "node:assert/strict";
import { test } from "node:test";
import { ProjectGuard, idsInText, markUnused, objectRefs, type Node } from "./data";

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

test("project guard: a build for the previous project is dropped after a switch", () => {
  const g = new ProjectGuard("A");
  const slow = g.begin();
  assert.equal(g.valid(slow, "A"), true);
  assert.equal(g.switched("A"), false, "same project: no switch");
  assert.equal(g.switched("B"), true);
  assert.equal(g.valid(slow, "B"), false, "old build, even though the root now differs from its own");
  assert.equal(g.valid(slow, "A"), false);
  const fresh = g.begin();
  assert.equal(g.valid(fresh, "B"), true);
});

test("project guard: switching back and forth keeps only the last build", () => {
  const g = new ProjectGuard("A");
  const a1 = g.begin();
  g.switched("B"); const b = g.begin();
  g.switched("A"); const a2 = g.begin();
  assert.equal(g.valid(a1, "A"), false);
  assert.equal(g.valid(b, "A"), false);
  assert.equal(g.valid(a2, "A"), true);
});

test("project guard: rows of another project are not owned", () => {
  const g = new ProjectGuard("A");
  assert.equal(g.owns("A", "A"), true);
  g.switched("B");
  assert.equal(g.owns("A", "B"), false);
  assert.equal(g.owns("B", "B"), true);
});

test("project guard: rows aren't owned while another project is open but unannounced", () => {
  const g = new ProjectGuard("A");
  // Opening B failed half way: the workspace holds B, the guard was never told, A's rows still show.
  assert.equal(g.owns("A", "B"), false);
  assert.equal(g.owns("A", "A"), true);
});

test("project guard: a project that is open but not yet announced is stale until switched", () => {
  const g = new ProjectGuard("A");
  assert.equal(g.stale("A"), false);
  assert.equal(g.stale("B"), true, "open() already set B, onDidChange has not fired");
  g.switched("B");
  assert.equal(g.stale("B"), false);
});
