import assert from "node:assert/strict";
import { test } from "node:test";
import { copyAs, ecasAsText, triggerAsText, type CopySource } from "./astext";
import { parseTriggerData } from "./triggerdata";
import type { Eca, TriggerFile, TriggerItem } from "./wtg";

// Made up, in TriggerData's layout: a category shown in front of lines, one hidden, an If block.
const data = parseTriggerData(`
[TriggerCategories]
TC_FOO=Foo,ReplaceableTextures\\WorldEditUI\\Actions-Nothing
TC_HIDDEN=Hidden,ReplaceableTextures\\WorldEditUI\\Actions-Nothing,1
[TriggerTypes]
integer=0,1,1,Integer
string=0,1,1,String
[TriggerEvents]
MapFooStart=0,nothing
_MapFooStart_DisplayName="Foo starts"
_MapFooStart_Category=TC_HIDDEN
[TriggerConditions]
IsFooReady=0,integer
_IsFooReady_DisplayName="Foo is ready"
_IsFooReady_Parameters="Foo ",~Number," is ready"
_IsFooReady_Category=TC_FOO
[TriggerActions]
LogFoo=0,string
_LogFoo_DisplayName="Log"
_LogFoo_Parameters="Log ",~Text
_LogFoo_Category=TC_FOO
IfThenElseMultiple=0
_IfThenElseMultiple_DisplayName="If / Then / Else, Multiple Functions"
_IfThenElseMultiple_Parameters="If (All Conditions are True) then do (Then Actions) else do (Else Actions)"
_IfThenElseMultiple_Category=TC_HIDDEN
`);
const ctx = { data };
const eca = (kind: number, name: string, params: Eca["params"] = [], extra: Partial<Eca> = {}): Eca => ({ kind, name, enabled: true, params, children: [], ...extra });
const log = (s: string, group?: number) => eca(2, "LogFoo", [{ type: 3, value: s }], group === undefined ? {} : { group });
const iff = eca(2, "IfThenElseMultiple", [], { children: [eca(1, "IsFooReady", [{ type: 3, value: "3" }], { group: 0 }), log("yes", 1)] });
const trigger: TriggerItem = {
  type: 8, name: "Foo Trigger", description: "", isComment: 0, id: 1, enabled: true, isCustom: false, initiallyOff: false, runOnInit: false, parent: 0,
  ecas: [eca(0, "MapFooStart"), log("first"), iff],
};
const file: TriggerFile = { reforged: false, version: 7, counts: [], unknown: 2, variables: [], items: [trigger] };

test("Copy As Text: a trigger as the World Editor's readable text, indented by nesting", () => {
  assert.equal(triggerAsText(trigger, ctx), [
    "Foo Trigger",
    "    Events",
    "        Foo starts",
    "    Conditions",
    "    Actions",
    "        Foo - Log first",
    "        If (All Conditions are True) then do (Then Actions) else do (Else Actions)",
    "            If - Conditions",
    "                Foo - Foo 3 is ready",
    "            Then - Actions",
    "                Foo - Log yes",
    // An empty branch is listed too, as the Trigger Editor shows it.
    "            Else - Actions",
    "",
  ].join("\n"));
});

test("Copy As Text: selected lines carry what they contain, from no indentation", () => {
  assert.equal(ecasAsText([iff.children[1]], ctx), "Foo - Log yes\n");
  assert.equal(ecasAsText([iff], ctx).split("\n")[0], "If (All Conditions are True) then do (Then Actions) else do (Else Actions)");
  assert.equal(ecasAsText([iff], ctx).split("\n").length, 7);
  // A function TriggerData doesn't know is named as stored, as the Trigger Editor shows it.
  assert.equal(ecasAsText([eca(2, "NoSuchThing")], ctx), "NoSuchThing()\n");
});

const src = (language: "jass" | "lua" = "jass", texts = new Map<TriggerItem, string>()): CopySource =>
  ({ display: ctx, file, language, customText: (t) => texts.get(t) ?? null });

test("Copy As Script: the trigger's functions from the map script's compiler, with \\n line ends", () => {
  const script = copyAs("script", src(), trigger)!;
  assert.ok(script.includes("function Trig_Foo_Trigger_Actions takes nothing returns nothing\n"), script);
  assert.ok(script.includes("function InitTrig_Foo_Trigger takes nothing returns nothing\n"), script);
  assert.ok(!script.includes("\r"));
  // Lua maps get Lua.
  const lua = copyAs("script", src("lua"), trigger)!;
  assert.ok(lua.includes("function Trig_Foo_Trigger_Actions()"), lua);
});

test("Copy As Script: selected lines alone, a nested one at the top level", () => {
  const script = copyAs("script", src(), trigger, [iff.children[1]])!;
  assert.ok(script.includes("function Trig_Foo_Trigger_Actions"), script);
  assert.ok(script.includes("LogFoo( \"yes\" )"), script);
  assert.ok(!script.includes("\"first\""), script);
  // Control: the whole trigger has the other line.
  assert.ok(copyAs("script", src(), trigger)!.includes("LogFoo( \"first\" )"));
});

test("Copy As …: custom text gives its own script and no GUI text; comments give nothing", () => {
  const custom: TriggerItem = { ...trigger, isCustom: true, ecas: [] };
  assert.equal(copyAs("script", src("jass", new Map([[custom, "// mine\r\ncall Foo()"]])), custom), "// mine\ncall Foo()");
  assert.equal(copyAs("text", src(), custom), null);
  const comment: TriggerItem = { ...trigger, type: 16, isComment: 1 };
  assert.equal(copyAs("text", src(), comment), null);
  assert.equal(copyAs("script", src(), comment), null);
  assert.equal(copyAs("text", src(), trigger), triggerAsText(trigger, ctx));
});
