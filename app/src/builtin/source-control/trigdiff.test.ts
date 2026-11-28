import assert from "node:assert/strict";
import { test } from "node:test";
import { diffTrigger, diffVariables, triggerFileKind } from "./trigdiff";

const eca = (kind: number, name: string, params: unknown[] = [], more: object = {}) => ({ kind, name, enabled: true, params, children: [], ...more });
const base = { name: "Start", description: "", enabled: true, initiallyOff: false, runOnInit: false, ecas: [eca(0, "MapInitializationEvent"), eca(1, "IsReady", [{ type: 0, value: "1" }]), eca(2, "MeleeStartingVisibility"), eca(2, "DisplayText", [{ type: 3, value: "\"hi\"" }])] };

test("a path is a GUI trigger, a variables file, or neither", () => {
  assert.equal(triggerFileKind("map/triggers/Init/Start.gui.json"), "gui");
  assert.equal(triggerFileKind("map/triggers/variables.json"), "variables");
  assert.equal(triggerFileKind("maps/Chapter1/map/triggers/Init/variables.json"), "variables");
  assert.equal(triggerFileKind("map/triggers/Init/_category.json"), null);
  assert.equal(triggerFileKind("map/war3map.w3u.json"), null);
  assert.equal(triggerFileKind("docs/Start.gui.json"), null);
});

test("the same trigger has nothing to say", () => {
  const d = diffTrigger(base, structuredClone(base));
  assert.deepEqual([d.header, d.lines], [[], []]);
  assert.deepEqual(d.counts, { event: [1, 1], condition: [1, 1], action: [2, 2] });
});

test("lines added, removed, changed and switched are told by kind and name", () => {
  const after = structuredClone(base);
  after.ecas[3].params = [{ type: 3, value: "\"hello\"" }]; // an action's text
  after.ecas[2].enabled = false; // an action turned off
  after.ecas.splice(1, 1); // the condition gone
  after.ecas.push(eca(0, "TimerExpires"), eca(2, "PlaySound"));
  const d = diffTrigger(base, after);
  assert.deepEqual(d.lines.map((l) => `${l.what} ${l.kind} ${l.name}${l.note ? ` (${l.note})` : ""}`).sort(), [
    "added action PlaySound", "added event TimerExpires", "changed action DisplayText", "removed condition IsReady", "switched action MeleeStartingVisibility (turned off)",
  ]);
  assert.deepEqual(d.counts, { event: [1, 2], condition: [1, 0], action: [2, 3] });
  assert.deepEqual(d.header, []);
});

test("what else of a trigger changed is in the header; a new or deleted trigger is said", () => {
  const d = diffTrigger(base, { ...base, name: "Begin", enabled: false, initiallyOff: true, description: "why" });
  assert.deepEqual(d.header, ["name: Start → Begin", "enabled: true → false", "initially on: true → false", "comment changed"]);
  assert.deepEqual(diffTrigger(null, base).header, ['new trigger "Start"']);
  assert.equal(diffTrigger(null, base).lines.length, 4);
  assert.deepEqual(diffTrigger(base, null).header, ['trigger "Start" deleted']);
  assert.ok(diffTrigger(base, null).lines.every((l) => l.what === "removed"));
});

test("two actions swapped are a move, not a removal and an addition; a change inside a block is a change of the block", () => {
  const swapped = structuredClone(base);
  [swapped.ecas[2], swapped.ecas[3]] = [swapped.ecas[3], swapped.ecas[2]];
  const d = diffTrigger(base, swapped);
  assert.deepEqual(d.lines.map((l) => [l.what, l.kind]), [["moved", "action"]]);
  const block = (text: string) => ({ ...base, ecas: [eca(2, "IfThenElseMultiple", [], { children: [{ ...eca(2, "DisplayText", [{ type: 3, value: text }]), group: 1 }] })] });
  assert.deepEqual(diffTrigger(block("a"), block("b")).lines.map((l) => `${l.what} ${l.name}`), ["changed IfThenElseMultiple"]);
});

test("variables are compared by name: added, removed, another type or starting value", () => {
  const line = (name: string, more: object = {}) => JSON.stringify({ name, type: "integer", isArray: false, arraySize: 1, initialized: false, initialValue: "", ...more });
  const before = [line("Counter", { initialized: true, initialValue: "3" }), line("Gone"), line("Same")].join("\n");
  const after = [line("Counter", { initialized: true, initialValue: "5" }), line("Same"), line("Heroes", { type: "unit", isArray: true, arraySize: 4 })].join("\r\n");
  assert.deepEqual(diffVariables(before, after), [
    { what: "changed", name: "Counter", note: "starts as 3 → starts as 5" },
    { what: "added", name: "Heroes", note: "unit array (4), no starting value" },
    { what: "removed", name: "Gone", note: "integer" },
  ]);
  assert.deepEqual(diffVariables("", ""), []);
  // A file kept as one list reads the same.
  assert.equal(diffVariables("[]", `[${line("New")}]`)[0].what, "added");
});
