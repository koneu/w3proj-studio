import assert from "node:assert/strict";
import { test } from "node:test";
import { createVariables, missingVariableNames, usedVariableNames, variablesOf } from "./pastevars";
import type { Eca, TriggerFile, Variable } from "./wtg";

const v = (name: string, extra: Partial<Variable> = {}): Variable =>
  ({ name, type: "integer", unknown: 1, isArray: false, arraySize: 1, initialized: false, initialValue: "", id: 0, parent: -1, ...extra });
const eca = (params: Eca["params"], children: Eca[] = []): Eca => ({ kind: 2, name: "SetVariable", enabled: true, params, children });
const file = (reforged: boolean, variables: Variable[]): TriggerFile => ({
  reforged, version: 7, counts: [{ count: 1, deleted: [] }, { count: 1, deleted: [] }, { count: 1, deleted: [] }, { count: 1, deleted: [] }, { count: 1, deleted: [] }, { count: 1, deleted: [] }, { count: 1, deleted: [] }] as never,
  unknown: 2, variables,
  items: reforged ? [{ type: 4, id: (3 << 24) | 0, name: "Variables", isComment: 0, expanded: 1, parent: -1 } as never] : [],
});

const lines: Eca[] = [
  eca([{ type: 1, value: "score" }, { type: 2, value: "", call: { kind: 3, name: "OperatorInt", hasParams: true, params: [{ type: 1, value: "bonus", index: { type: 1, value: "slot" } }] } }]),
  eca([{ type: 1, value: "gg_trg_Foo" }], [eca([{ type: 1, value: "Score" }])]),
];

test("used variables are found through calls, indices and children, without generated globals", () => {
  assert.deepEqual(usedVariableNames(lines), ["score", "bonus", "slot"]);
});

test("variablesOf copies what the source map has; missing compares without case", () => {
  const src = file(false, [v("score", { initialValue: "5", initialized: true }), v("bonus", { isArray: true, arraySize: 4 })]);
  const got = variablesOf(src, lines);
  assert.deepEqual(got.map((x) => x.name), ["score", "bonus"]);
  assert.notEqual(got[0], src.variables[0]);
  assert.deepEqual(missingVariableNames(file(false, [v("SCORE")]), lines), ["bonus", "slot"]);
});

test("createVariables carries type, array and initial value; Reforged files get a tree item too", () => {
  const carried = [v("score", { initialValue: "5", initialized: true }), v("bonus", { type: "real", isArray: true, arraySize: 4 })];
  const dst = file(true, []);
  const made = createVariables(dst, carried, ["score", "bonus", "slot"]);
  assert.deepEqual(made, ["score", "bonus"]);
  assert.equal(dst.variables[0].initialValue, "5");
  assert.equal(dst.variables[1].isArray, true);
  assert.equal(dst.variables[1].type, "real");
  const items = dst.items.filter((i) => i.type === 64);
  assert.equal(items.length, 2);
  assert.ok(dst.variables.every((x) => items.some((i) => i.id === x.id && i.name === x.name)));
  assert.notEqual(dst.variables[0].id, dst.variables[1].id);
  // Nothing twice, and a map that has the name keeps its own.
  assert.deepEqual(createVariables(dst, carried, ["SCORE"]), []);
  assert.equal(dst.variables.length, 2);
});

test("createVariables in an old file numbers by position; a Reforged file without category is refused whole", () => {
  const old = file(false, [v("a")]);
  createVariables(old, [v("b")], ["b"]);
  assert.equal(old.variables[1].id, 1);
  assert.equal(old.items.length, 0);
  const bare = file(true, []);
  bare.items = [];
  assert.throws(() => createVariables(bare, [v("b")], ["b"]), /category/);
  assert.equal(bare.variables.length, 0);
});
