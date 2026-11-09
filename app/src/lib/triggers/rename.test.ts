// Renaming generated globals in triggers (rename.ts) and telling which objects were renamed since the
// last save (renamed.ts).

import assert from "node:assert/strict";
import { test } from "node:test";
import { applyRenames, countRenames, globalRenames, renameInText } from "./rename";
import { SavedNames } from "./renamed";
import type { Eca, Param, TriggerFile } from "./wtg";

const v = (value: string): Param => ({ type: 1, value });
const eca = (name: string, params: Param[], children: Eca[] = []): Eca => ({ kind: 2, name, enabled: true, params, children });
const file = (ecas: Eca[]): TriggerFile => ({
  reforged: true, version: 7, counts: [], unknown: 2, variables: [],
  items: [{ type: 8, name: "T", description: "", isComment: 0, id: 1, enabled: true, isCustom: false, initiallyOff: false, runOnInit: false, parent: 0, ecas }],
});

test("names become globals as the map script makes them; unchanged ones are left out", () => {
  assert.deepEqual([...globalRenames("rct", [["Arena Gate", "Arena Door"], ["Same", "Same"], ["A B", "A_B"]])], [["gg_rct_Arena_Gate", "gg_rct_Arena_Door"]]);
});

test("script text changes only whole identifiers, all renames in one pass", () => {
  const r = new Map([["gg_rct_A", "gg_rct_B"], ["gg_rct_B", "gg_rct_A"]]);
  assert.equal(renameInText("call F(gg_rct_A, gg_rct_B, gg_rct_AB, xgg_rct_A, gg_rct_A2)", r), "call F(gg_rct_B, gg_rct_A, gg_rct_AB, xgg_rct_A, gg_rct_A2)");
  assert.equal(renameInText("gg_rct_A", new Map()), "gg_rct_A");
});

test("GUI parameters (nested calls and array indexes too) always follow; script text only when asked", () => {
  const r = globalRenames("rct", [["Old", "New"]]);
  const make = () => file([
    eca("Move", [v("gg_rct_Old"), { type: 2, value: "Center", call: { kind: 3, name: "Center", hasParams: true, params: [v("gg_rct_Old")] } }]),
    eca("If", [], [eca("Pick", [{ type: 1, value: "Arr", index: v("gg_rct_Old") }, v("gg_rct_Older")])]),
    eca("CustomScriptCode", [{ type: 3, value: "call RemoveRect(gg_rct_Old)" }]),
  ]);
  const header = { text: "// gg_rct_Old here\nset x = gg_rct_Old" as string | null };
  const scripts = [{ get: () => header.text, set: (t: string) => { header.text = t; } }];
  const f = make();
  assert.deepEqual(countRenames(f, [header.text], r), { gui: 3, script: 3 });
  assert.deepEqual(applyRenames(f, scripts, r, false), { gui: 3, script: 0 });
  assert.equal(header.text, "// gg_rct_Old here\nset x = gg_rct_Old", "the script wasn't to change");
  assert.match(JSON.stringify(f), /gg_rct_Older/);
  assert.doesNotMatch(JSON.stringify(f).replace(/gg_rct_Older/g, ""), /gg_rct_Old"/);
  const g = make();
  assert.deepEqual(applyRenames(g, scripts, r, true), { gui: 3, script: 3 });
  assert.equal(header.text, "// gg_rct_New here\nset x = gg_rct_New");
  assert.equal((g.items[0] as { ecas: Eca[] }).ecas[2].params[0].value, "call RemoveRect(gg_rct_New)");
});

test("renamed since the last save: edited copies count as the object, undo's old one too; new objects don't", () => {
  type O = { name: string };
  const names = new SavedNames<O>();
  const a: O = { name: "A" }, b: O = { name: "B" };
  names.saved([a, b]);
  assert.deepEqual(names.renamed([a, b]), []);
  const a2 = names.copy(a, { ...a, name: "A2" });
  const fresh: O = { name: "Fresh" };
  assert.deepEqual(names.renamed([a2, b, fresh]), [["A", "A2"]]);
  // Saved: the copy's name is the saved one now; undo brings back the old object, a rename back.
  names.saved([a2, b, fresh]);
  assert.deepEqual(names.renamed([a2, b, fresh]), []);
  assert.deepEqual(names.renamed([a, b]), [["A2", "A"]]);
  // Deleted and made again with the same name: a new object, no rename.
  assert.deepEqual(names.renamed([{ name: "B2" }]), []);
});
