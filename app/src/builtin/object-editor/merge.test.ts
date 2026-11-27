import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeChanged, sameObjects } from "./merge";
import type { EditFile, EditMod, EditObject } from "./objectedit";

const mod = (field: string, value: number | string): EditMod => ({ field, type: typeof value === "string" ? "string" : "int", value });
const unit = (id: string, ...mods: EditMod[]): EditObject => ({ base: "hfoo", id, mods });
const file = (custom: EditObject[], original: EditObject[] = []): EditFile => ({ format: "w3proj.objects/1", version: 2, original, custom });
const values = (f: EditFile) => Object.fromEntries([...f.original, ...f.custom].map((o) => [o.id ?? o.base, Object.fromEntries((o.mods ?? []).map((m) => [m.field, m.value]))]));

test("objects the editor didn't change are theirs, those only it changed are its own; nothing is flagged", () => {
  const base = file([unit("h000", mod("uhpm", 1)), unit("h001", mod("uhpm", 1)), unit("h002", mod("uhpm", 1))]);
  const mine = file([unit("h000", mod("uhpm", 5)), unit("h001", mod("uhpm", 1)), unit("h002", mod("uhpm", 1)), unit("h009", mod("uhpm", 9))]);
  // They changed h001, removed h002 and added h003 and a game object's change.
  const theirs = file([unit("h000", mod("uhpm", 1)), unit("h001", mod("uhpm", 7)), unit("h003", mod("uhpm", 3))], [{ base: "hpea", mods: [mod("uhpm", 8)] }]);
  const r = mergeChanged(base, mine, theirs);
  assert.deepEqual(values(r.file), { hpea: { uhpm: 8 }, h000: { uhpm: 5 }, h001: { uhpm: 7 }, h003: { uhpm: 3 }, h009: { uhpm: 9 } });
  assert.deepEqual(r.conflicts, []);
});

test("an object changed on both sides keeps the editor's fields, takes their other ones and is flagged", () => {
  const base = file([unit("h000", mod("uhpm", 1), mod("unam", "A"), mod("ugol", 10))]);
  const mine = file([unit("h000", mod("uhpm", 2), mod("unam", "A"), mod("ugol", 10), mod("ulum", 4))]);
  const theirs = file([unit("h000", mod("uhpm", 3), mod("unam", "B"))]);
  const r = mergeChanged(base, mine, theirs);
  assert.deepEqual(values(r.file), { h000: { uhpm: 2, unam: "B", ulum: 4 } });
  assert.deepEqual(r.conflicts, [{ key: "c:h000", fields: ["uhpm"], theirs: theirs.custom[0], removedHere: false }]);
  // Both made the same change: nothing to flag.
  assert.deepEqual(mergeChanged(base, theirs, theirs).conflicts, []);
});

test("removed on one side and changed on the other: the editor's side stands, flagged", () => {
  const base = file([unit("h000", mod("uhpm", 1)), unit("h001", mod("uhpm", 1))]);
  const mine = file([unit("h001", mod("uhpm", 2))]);
  const theirs = file([unit("h000", mod("uhpm", 3))]);
  const r = mergeChanged(base, mine, theirs);
  assert.deepEqual(values(r.file), { h001: { uhpm: 2 } });
  assert.deepEqual(r.conflicts.map((c) => [c.key, c.removedHere, c.theirs?.id ?? null]), [["c:h000", true, "h000"], ["c:h001", false, null]]);
});

test("two new objects given one id: the editor's stands whole, theirs can be taken", () => {
  const mine = file([unit("h000", mod("uhpm", 2))]);
  const theirs = file([{ base: "hpea", id: "h000", mods: [mod("ugol", 3)] }]);
  const r = mergeChanged(file([]), mine, theirs);
  assert.deepEqual(r.file.custom, mine.custom);
  assert.equal(r.conflicts[0].theirs?.base, "hpea");
});

test("fields in flagged sets merge by set; a game object without fields counts as none", () => {
  const sets = (a: number, b: number): EditObject => ({ base: "hfoo", id: "h000", sets: [{ flag: 0, mods: [mod("uhpm", a)] }, { flag: 1, mods: [mod("uhpm", b)] }] });
  const r = mergeChanged(file([sets(1, 1)]), file([sets(1, 5)]), file([sets(4, 1)]));
  assert.deepEqual(r.file.custom, [sets(4, 5)]);
  assert.deepEqual(r.conflicts.map((c) => c.fields), [[]]);
  assert.ok(sameObjects(file([], [{ base: "hpea", mods: [] }]), file([])));
  assert.ok(sameObjects(file([unit("h000", mod("a", 1), mod("b", 2))]), file([unit("h000", mod("b", 2), mod("a", 1))])), "the order of fields doesn't matter");
  assert.ok(!sameObjects(file([unit("h000", mod("a", 1))]), file([unit("h000", mod("a", 2))])));
});
