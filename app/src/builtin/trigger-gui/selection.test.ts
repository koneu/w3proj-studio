import assert from "node:assert/strict";
import { test } from "node:test";
import { chosenFrom, clickSelection, holdOf, setOf } from "./selection";
import type { Eca, TriggerItem } from "../../lib/triggers/wtg";

const eca = (kind: number, name: string, children: Eca[] = [], group?: number): Eca =>
  ({ kind, name, enabled: true, params: [], children, ...(group === undefined ? {} : { group }) });
const trigger = (ecas: Eca[]) => ({ ecas } as unknown as TriggerItem);
// Events: 0, 1; Actions: 2, 3, 4 (3 is an If with a condition and two actions in Then, one in Else).
const t = trigger([
  eca(0, "E0"), eca(0, "E1"), eca(2, "A2"),
  eca(2, "IfThenElseMultiple", [eca(1, "C0", [], 0), eca(2, "T0", [], 1), eca(2, "T1", [], 1), eca(2, "F0", [], 2)]),
  eca(2, "A4"),
]);
const names = (paths: number[][]) => paths.map((p) => p.join("."));

test("a set is the lines of one list and kind, or of one branch", () => {
  assert.deepEqual(names(setOf(t, [2])), ["2", "3", "4"]);
  assert.deepEqual(names(setOf(t, [0])), ["0", "1"]);
  assert.deepEqual(names(setOf(t, [3, 1])), ["3.1", "3.2"]);
  assert.deepEqual(setOf(t, [9]), []);
});

test("Ctrl takes a line in and out; Shift takes the range of its set; others start anew", () => {
  const ctrl = { ctrl: true, shift: false }, shift = { ctrl: false, shift: true };
  assert.deepEqual(clickSelection(t, [[2]], [2], [4], ctrl), { paths: [[2], [4]], lead: [4] });
  assert.deepEqual(clickSelection(t, [[2], [4]], [4], [4], ctrl), { paths: [[2]], lead: [2] });
  assert.equal(clickSelection(t, [[2]], [2], [2], ctrl), null, "the last line out leaves one selected alone");
  assert.deepEqual(clickSelection(t, [[2]], [2], [4], shift), { paths: [[2], [3], [4]], lead: [4] });
  assert.deepEqual(clickSelection(t, [[4]], [4], [2], shift)?.paths, [[2], [3], [4]]);
  assert.equal(clickSelection(t, [[2]], [2], [1], ctrl), null, "an event doesn't join actions");
  assert.equal(clickSelection(t, [[3, 1]], [3, 1], [3, 3], shift), null, "another branch doesn't join");
  assert.equal(clickSelection(t, [[2]], [2], [4], { ctrl: false, shift: false }), null);
  assert.equal(clickSelection(t, [], null, [4], ctrl), null);
});

test("a held selection counts while its lines are where they were, and ends when they are replaced", () => {
  const held = holdOf(t, [[2], [4]])!;
  assert.deepEqual(chosenFrom(t, [4], held).map((c) => c.eca.name), ["A2", "A4"]);
  assert.deepEqual(chosenFrom(t, [3], held).map((c) => c.eca.name), ["IfThenElseMultiple"], "the lead must be one of them");
  const undone = trigger(t.ecas.map((e) => structuredClone(e)));
  assert.deepEqual(chosenFrom(undone, [4], held).map((c) => c.eca.name), ["A4"], "an undo replaced the lines");
  assert.deepEqual(chosenFrom(t, null, held), []);
  assert.equal(holdOf(t, [[2]]), null);
});
