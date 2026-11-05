import assert from "node:assert/strict";
import { test } from "node:test";
import { clickSelection } from "../../lib/selection";
import { importPath, importTreePath, isJunkFile } from "./imports";

test("imports go below the import folder, numbered if taken", () => {
  const taken = new Set(["war3mapImported\\a.blp", "war3mapImported\\a (2).blp"]);
  assert.equal(importPath("C:\\x\\b.blp", (p) => taken.has(p)), "war3mapImported\\b.blp");
  assert.equal(importPath("C:/x/a.blp", (p) => taken.has(p)), "war3mapImported\\a (3).blp");
  assert.equal(importPath("noext", () => false, "war3campImported"), "war3campImported\\noext");
});

test("folder imports keep their structure", () => {
  assert.equal(importTreePath("Pack/fx/a.blp", () => false), "war3mapImported\\Pack\\fx\\a.blp");
  const taken = (p: string) => p === "war3mapImported\\Pack\\a.blp";
  assert.equal(importTreePath("Pack/a.blp", taken), "war3mapImported\\Pack\\a (2).blp");
});

test("folder imports skip system leftovers", () => {
  for (const f of ["Thumbs.db", "a/desktop.ini", ".DS_Store", ".git/config", "a/.svn/x.blp"]) assert.ok(isJunkFile(f), f);
  for (const f of ["a.blp", "a/b.c.blp", "thumbs.db.blp"]) assert.ok(!isJunkFile(f), f);
});

test("selection: plain, Ctrl and Shift clicks", () => {
  const order = ["a", "b", "c", "d"];
  const plain = { ctrl: false, shift: false }, ctrl = { ctrl: true, shift: false }, shift = { ctrl: false, shift: true };
  const one = clickSelection(order, new Set(["c"]), "c", "a", plain);
  assert.deepEqual([...one.selected], ["a"]);
  const two = clickSelection(order, one.selected, one.anchor, "c", ctrl);
  assert.deepEqual([...two.selected].sort(), ["a", "c"]);
  assert.deepEqual([...clickSelection(order, two.selected, two.anchor, "c", ctrl).selected], ["a"]);
  // Shift works both ways from the anchor, which stays.
  const range = clickSelection(order, new Set(["b"]), "b", "d", shift);
  assert.deepEqual([...range.selected], ["b", "c", "d"]);
  assert.deepEqual([...clickSelection(order, range.selected, range.anchor, "a", shift).selected], ["a", "b"]);
  // Ctrl+Shift adds the range; Shift without a usable anchor is a plain click.
  assert.deepEqual([...clickSelection(order, new Set(["d"]), "a", "b", { ctrl: true, shift: true }).selected].sort(), ["a", "b", "d"]);
  assert.deepEqual([...clickSelection(order, new Set(), "gone", "b", shift).selected], ["b"]);
});
