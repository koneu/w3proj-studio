import assert from "node:assert/strict";
import { test } from "node:test";
import type { DisplayContext } from "../../lib/triggers/display";
import { ACTION, CONDITION, EVENT, type TriggerData } from "../../lib/triggers/triggerdata";
import type { Eca, TriggerFile, TriggerItem } from "../../lib/triggers/wtg";
import { addScriptTrigger, addVariable, findTrigger, removeTrigger, removeVariable, scriptWarning, triggerDetail, triggerList } from "./triggerinfo";

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

test("a new script trigger goes last in its category, with its text at the same place", () => {
  const made = () => {
    const f = structuredClone(file);
    f.items.splice(1, 0, { type: 4, id: 2, name: "Later", isComment: 0, expanded: 1, parent: -1 });
    return f;
  };
  const f = made(), scripts = { reforged: false, version: 1, comment: "", header: "", texts: ["a", "b", "c"] };
  const t = addScriptTrigger(f, scripts, "New", "code");
  assert.equal(f.items[f.items.indexOf(t) - 1].name, "A note");
  assert.deepEqual([t.type, t.isCustom, t.parent], [8, true, 1]);
  const order = f.items.filter((i) => i.type === 8).map((i) => i.name);
  assert.deepEqual(order, ["Init", "Script", "Lost", "New"].filter((n) => order.includes(n)));
  assert.equal(scripts.texts[order.indexOf("New")], "code");
  assert.equal(scripts.texts.length, 4);
  assert.equal(addScriptTrigger(made(), { ...scripts, texts: [] }, "Inside", "", "later").parent, 2);
  assert.throws(() => addScriptTrigger(made(), scripts, "init", "x"), /already something named/);
  assert.throws(() => addScriptTrigger(made(), scripts, "X", "x", "Nowhere"), /no category/);
});

test("a script without its init function is said to be a library", () => {
  assert.equal(scriptWarning("Flame Wall", "function InitTrig_Flame_Wall takes nothing returns nothing"), null);
  assert.match(scriptWarning("Flame Wall", "function Other takes nothing returns nothing") ?? "", /InitTrig_Flame_Wall/);
});

test("reforged files get a real trigger too, not a script item, and count it", () => {
  const f = { reforged: true, counts: Array.from({ length: 8 }, () => ({ count: 0, deleted: [] })), variables: [], items: [{ type: 4, id: 2 << 24, name: "C", isComment: 0, expanded: 1, parent: -1 }] } as unknown as TriggerFile;
  const t = addScriptTrigger(f, { reforged: true, version: 1, comment: "", header: "", texts: [] }, "New", "code");
  assert.equal(t.type, 8);
  assert.equal(t.isCustom, true);
  assert.equal(t.id, 3 << 24);
  assert.equal(f.counts[3].count, 1);
});

test("removing a trigger takes its text along, not another's", () => {
  const f = structuredClone(file), scripts = { reforged: false, version: 1, comment: "", header: "", texts: ["a", "b", "c"] };
  removeTrigger(f, scripts, findTrigger(f, "Script")!);
  assert.deepEqual(scripts.texts, ["a", "c"]);
  assert.equal(findTrigger(f, "Script"), null);
  assert.equal(findTrigger(f, "Lost")?.name, "Lost");
});

test("a variable in use stays, and the answer says where", () => {
  const v = { name: "Heat", type: "real", isArray: false, arraySize: 1, initialValue: "" };
  const f = structuredClone(file), scripts = { header: "", texts: [] as string[] } as unknown as Parameters<typeof removeVariable>[1];
  addVariable(f, v);
  addScriptTrigger(f, scripts, "Burn", "call BJDebugMsg(R2S(udg_Heat))", undefined);
  assert.throws(() => removeVariable(f, scripts, "Heat"), /Heat is still used by: Burn/);
  (scripts as { texts: string[] }).texts.fill("call DoNothing()");
  (scripts as { header: string }).header = "// udg_Heat";
  assert.throws(() => removeVariable(f, scripts, "Heat"), /custom script/);
  (scripts as { header: string }).header = "// udg_Heater is another";
  assert.equal(removeVariable(f, scripts, "heat"), "Heat", "any case, and only the whole name counts");
  assert.ok(!f.variables.some((x) => x.name === "Heat"));
  assert.throws(() => removeVariable(f, scripts, "Heat"), /no variable/);
  f.variables.forEach((x, i) => assert.equal(x.id, i));
});

test("a Reforged variable leaves its category, and its number isn't used again", () => {
  const v = { name: "Heat", type: "real", isArray: false, arraySize: 1, initialValue: "" };
  const r = { reforged: true, counts: Array.from({ length: 8 }, () => ({ count: 0, deleted: [] as number[] })), variables: [], items: [{ type: 4, id: 2 << 24, name: "Home", isComment: 0, expanded: 1, parent: -1 }] } as unknown as TriggerFile;
  addVariable(r, v);
  const id = r.variables[0].id;
  removeVariable(r, { header: "", texts: [] } as unknown as Parameters<typeof removeVariable>[1], "Heat");
  assert.equal(r.items.length, 1);
  assert.deepEqual(r.counts[6].deleted, [id]);
});

test("variables: names are unique; Reforged lists them in a category and counts them", () => {
  const v = { name: "Heat", type: "real", isArray: false, arraySize: 1, initialValue: "" };
  const f = structuredClone(file);
  addVariable(f, v);
  assert.deepEqual([f.variables[1].name, f.variables[1].parent, f.variables[1].id], ["Heat", -1, 1]);
  assert.throws(() => addVariable(f, { ...v, name: "heat" }), /already a variable/);
  assert.equal(f.variables[1].initialized, false);
  const r = { reforged: true, counts: Array.from({ length: 8 }, () => ({ count: 0, deleted: [] })), variables: [], items: [{ type: 4, id: 2 << 24, name: "C", isComment: 0, expanded: 1, parent: -1 }] } as unknown as TriggerFile;
  addVariable(r, { ...v, initialValue: "1.0" });
  assert.deepEqual([r.variables[0].id, r.variables[0].parent, r.variables[0].initialized], [6 << 24, 2 << 24, true]);
  assert.equal(r.items[1].type, 64);
  assert.equal(r.counts[6].count, 1);
});

test("a trigger in script gives its text", () => {
  const got = triggerDetail(trigger("Script", 1, { isCustom: true }), "function x takes nothing returns nothing", ctx, (v) => v);
  assert.equal(got.script, "function x takes nothing returns nothing");
  assert.equal("actions" in got, false);
});
