import assert from "node:assert/strict";
import { test } from "node:test";
import type { DisplayContext } from "../../lib/triggers/display";
import { ACTION, CONDITION, EVENT, type TriggerData } from "../../lib/triggers/triggerdata";
import type { Eca, TriggerFile, TriggerItem } from "../../lib/triggers/wtg";
import { findTrigger, triggerDetail, triggerList } from "./triggerinfo";

// No TriggerData here: functions show as name(arguments).
const ctx = { data: { find: () => undefined, categories: new Map() } as unknown as TriggerData } as DisplayContext;
const eca = (kind: number, name: string, over: Partial<Eca> = {}): Eca => ({ kind, name, enabled: true, params: [], children: [], ...over });
const trigger = (name: string, parent: number, over: Partial<TriggerItem> = {}) => ({
  type: 8, name, description: "", isComment: 0, id: 100, enabled: true, isCustom: false, initiallyOff: false, runOnInit: false, parent, ecas: [], ...over,
}) as TriggerItem;

const file = {
  variables: [{ name: "Count", type: "integer", isArray: false, initialValue: "0" }],
  items: [
    { type: 4, id: 1, name: "Setup", isComment: 0, expanded: 1, parent: -1 },
    trigger("Init", 1),
    trigger("Script", 1, { isCustom: true }),
    trigger("Lost", 77, { enabled: false }),
    { type: 16, name: "A note", description: "", isComment: 1, id: 5, enabled: true, isCustom: false, initiallyOff: false, runOnInit: false, parent: 1, ecas: [] },
  ],
} as unknown as TriggerFile;

test("the list goes by category, keeps triggers without one, and leaves comments out", () => {
  const list = triggerList(file, false);
  assert.equal(list.triggers, 3);
  assert.deepEqual(list.categories.map((c) => [c.category, c.triggers.map((t) => `${t.name}:${t.form}`)]),
    [["Setup", ["Init:gui", "Script:script"]], ["", ["Lost:gui"]]]);
  assert.equal("variables" in list, false);
  assert.deepEqual(triggerList(file, true).variables, [{ name: "Count", type: "integer", isArray: false, initialValue: "0" }]);
});

test("names are found whatever their case", () => {
  assert.equal(findTrigger(file, "init")?.name, "Init");
  assert.equal(findTrigger(file, "A note"), null);
  assert.equal(findTrigger(file, "nothing"), null);
});

test("a GUI trigger reads as its events, conditions and actions, nested and with what's off marked", () => {
  const t = trigger("Fight", 1, { description: "TRIGSTR_1", ecas: [
    eca(EVENT, "Start"),
    eca(CONDITION, "Check"),
    eca(ACTION, "Off", { enabled: false }),
    eca(ACTION, "IfThenElseMultiple", { children: [
      eca(CONDITION, "Test", { group: 0 }),
      eca(ACTION, "Win", { group: 1 }),
      eca(ACTION, "Lose", { group: 2 }),
    ] }),
  ] });
  const got = triggerDetail(t, null, ctx, () => "Starts the fight");
  assert.equal(got.description, "Starts the fight");
  assert.deepEqual(got.events, ["Start()"]);
  assert.deepEqual(got.conditions, ["Check()"]);
  assert.deepEqual(got.actions, [
    "(disabled) Off()",
    "IfThenElseMultiple()",
    "    If - Conditions",
    "        Test()",
    "    Then - Actions",
    "        Win()",
    "    Else - Actions",
    "        Lose()",
  ]);
});

test("a trigger in script gives its text", () => {
  const got = triggerDetail(trigger("Script", 1, { isCustom: true }), "function x takes nothing returns nothing", ctx, (v) => v);
  assert.equal(got.script, "function x takes nothing returns nothing");
  assert.equal("actions" in got, false);
});
