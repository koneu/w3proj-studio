// Validate Map Triggers: each kind of finding on a made-up TriggerData, with a valid trigger as the
// control (it must come out clean, or "found" means nothing), and the places a click goes to.

import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTriggerData } from "./triggerdata";
import { fits, lineLabel, scriptsThatRun, validateTriggers } from "./validate";
import type { Eca, Param, TriggerFile, TriggerItem } from "./wtg";

// Made up for this test; the layout of UI\TriggerData.txt.
const DATA = parseTriggerData(`
[TriggerTypes]
integer=0,1,1,Integer
real=0,1,1,Real
string=0,1,1,String
unit=0,1,1,Unit
player=0,1,1,Player
sound=0,1,0,Sound
widget=0,0,1,Widget
unitcode=0,1,1,Unit-Type,integer
musicfile=0,0,0,Music File,string
VarAsString_Real=0,0,0,Variable (Real)
AnyGlobal=0,0,0,Any Variable
boolexpr=0,0,0,Boolean Expression
[TriggerParams]
PlayerRed=0,player,Player(0),Red
UnitNull=0,unit,null,No Unit
[TriggerEvents]
UnitDies=0,unit
RealChanges=0,VarAsString_Real,real
[TriggerConditions]
IsAlive=0,unit
[TriggerActions]
KillUnit=0,unit
_KillUnit_DisplayName="Kill Unit"
Give=0,unit,player
MakeUnit=0,unitcode,integer
PlayMusic=0,musicfile
Damage=0,widget,real
SetVariable=0,AnyGlobal,Null
NewInTft=1,unit
IfThenElseMultiple=0
[TriggerCalls]
LastUnit=0,0,unit
OwnerOf=0,0,player,unit
UnitCount=0,0,integer,player
`);

const P = {
  preset: (value: string): Param => ({ type: 0, value }),
  variable: (value: string, index?: Param): Param => ({ type: 1, value, ...(index ? { index } : {}) }),
  call: (name: string, params: Param[] = [], kind = 3): Param => ({ type: 2, value: name, call: { kind, name, hasParams: true, params, trailer: 0 } }),
  value: (value: string): Param => ({ type: 3, value }),
  unset: (): Param => ({ type: -1, value: "" }),
};
const eca = (kind: number, name: string, params: Param[], children: Eca[] = [], extra: Partial<Eca> = {}): Eca => ({ kind, name, enabled: true, params, children, ...extra });
const trigger = (name: string, ecas: Eca[], extra: Partial<TriggerItem> = {}): TriggerItem => ({
  type: 8, name, description: "", isComment: 0, id: 1, enabled: true, isCustom: false, initiallyOff: false, runOnInit: false, parent: 0, ecas, ...extra,
} as TriggerItem);
const fileOf = (items: TriggerItem[], version = 7, reforged = true): TriggerFile => ({
  reforged, version, counts: [], unknown: 2, items,
  variables: [
    { name: "Hero", type: "unit", unknown: 1, isArray: false, arraySize: 1, initialized: false, initialValue: "", id: 0, parent: -1 },
    { name: "HERO", type: "player", unknown: 1, isArray: false, arraySize: 1, initialized: false, initialValue: "", id: 1, parent: -1 },
    { name: "Heroes", type: "unit", unknown: 1, isArray: true, arraySize: 4, initialized: false, initialValue: "", id: 2, parent: -1 },
    { name: "Health", type: "real", unknown: 1, isArray: false, arraySize: 1, initialized: false, initialValue: "", id: 3, parent: -1 },
    { name: "Theme", type: "sound", unknown: 1, isArray: false, arraySize: 1, initialized: false, initialValue: "", id: 4, parent: -1 },
  ],
});

/** A trigger that uses everything correctly. */
const valid = () => trigger("Valid", [
  eca(0, "UnitDies", [P.variable("gg_unit_hfoo_0001")]),
  eca(0, "RealChanges", [P.variable("Health"), P.value("0.5")]),
  eca(1, "IsAlive", [P.call("LastUnit")]),
  eca(2, "KillUnit", [P.variable("Heroes", P.value("2"))]),
  eca(2, "Give", [P.variable("Hero"), P.variable("HERO")]),
  eca(2, "MakeUnit", [P.value("hfoo"), P.call("UnitCount", [P.preset("PlayerRed")])]),
  eca(2, "PlayMusic", [P.variable("gg_snd_Theme")]),
  eca(2, "Damage", [P.preset("UnitNull"), P.value("12.5")]),
  eca(2, "SetVariable", [P.variable("Hero"), P.call("LastUnit")]),
  eca(2, "IfThenElseMultiple", [], [eca(1, "IsAlive", [P.variable("Hero")], [], { group: 0 }), eca(2, "KillUnit", [P.variable("Hero")], [], { group: 1 })]),
  // A disabled line isn't in the map script: not judged.
  eca(2, "NoSuchThing", [P.unset()], [], { enabled: false }),
]);

test("control: a trigger using everything correctly has nothing to report", () => {
  assert.deepEqual(validateTriggers(fileOf([valid()]), DATA), []);
});

test("each kind of mistake is found, at its line and parameter", () => {
  const t = trigger("Broken", [
    eca(0, "UnitDies", [P.unset()]),
    eca(2, "KillUnit", [P.preset("PlayerRed")]),
    eca(2, "Give", [P.variable("Hero"), P.call("LastUnit")]),
    eca(2, "KillUnit", [P.call("OwnerOf", [P.preset("NoSuchPreset")])]),
    eca(2, "MakeUnit", [P.value("hfoo"), P.value("ten")]),
    eca(2, "KillUnit", [P.variable("Heroes")]),
    eca(2, "KillUnit", [P.variable("Hero", P.value("1"))]),
    eca(2, "Vanish", []),
    eca(2, "KillUnit", []),
    eca(2, "KillUnit", [P.call("Gone")]),
    eca(2, "SetVariable", [P.variable("Hero"), P.preset("PlayerRed")]),
    eca(2, "IfThenElseMultiple", [], [eca(2, "KillUnit", [P.variable("")], [], { group: 2 })]),
  ]);
  const found = validateTriggers(fileOf([t]), DATA).map((i) => [i.kind, i.where, i.param?.join() ?? "", i.severity]);
  assert.deepEqual(found, [
    ["unset", "Event 1", "0", "error"],
    ["typeMismatch", "Action 1", "0", "error"],
    ["typeMismatch", "Action 2", "1", "error"],
    ["typeMismatch", "Action 3", "0", "error"],
    ["unknownPreset", "Action 3", "0,0", "error"],
    ["badValue", "Action 4", "1", "error"],
    ["arrayIndex", "Action 5", "0", "error"],
    ["arrayIndex", "Action 6", "0", "error"],
    ["unknownFunction", "Action 7", "", "error"],
    ["paramCount", "Action 8", "", "error"],
    ["unknownFunction", "Action 9", "0", "error"],
    ["typeMismatch", "Action 10", "1", "error"],
    ["unset", "Action 11 › Else 1", "0", "error"],
  ]);
  // The messages say what's wrong in the editor's words.
  const messages = validateTriggers(fileOf([t]), DATA).map((i) => i.message);
  assert.match(messages[1], /^Kill Unit, parameter 1 \(Unit\): Red is Player, not Unit$/);
  assert.match(messages[0], /isn't set$/);
});

test("disabled triggers are judged as warnings; Reign of Chaos files can't use The Frozen Throne's functions", () => {
  const off = trigger("Off", [eca(0, "UnitDies", [P.unset()])], { enabled: false });
  assert.deepEqual(validateTriggers(fileOf([off]), DATA).map((i) => [i.kind, i.severity]), [["unset", "warning"]]);
  const tft = trigger("Tft", [eca(0, "UnitDies", [P.variable("Hero")]), eca(2, "NewInTft", [P.variable("Hero")])]);
  assert.deepEqual(validateTriggers(fileOf([tft]), DATA), [], "a Frozen Throne file takes it");
  assert.deepEqual(validateTriggers(fileOf([tft], 4, false), DATA).map((i) => i.kind), ["frozenThrone"]);
});

test("a trigger without events is reported only when nothing runs it", () => {
  const lonely = trigger("Lonely Trigger", [eca(2, "KillUnit", [P.variable("Hero")])], { id: 2 });
  const caller = trigger("Caller", [eca(0, "UnitDies", [P.variable("Hero")]), eca(2, "KillUnit", [P.variable("gg_trg_Lonely_Trigger")])], { id: 3 });
  const kinds = (items: TriggerItem[], scripts?: (string | null)[] | null) => validateTriggers(fileOf(items), DATA, { scripts }).filter((i) => i.kind === "noEvents").map((i) => i.trigger.name);
  assert.deepEqual(kinds([lonely]), ["Lonely Trigger"]);
  assert.deepEqual(kinds([lonely, caller]), [], "run by a GUI trigger");
  assert.deepEqual(kinds([lonely], ["call TriggerExecute(gg_trg_Lonely_Trigger)"]), [], "run by script text");
  assert.deepEqual(kinds([lonely], ["call TriggerExecute(gg_trg_Lonely_Trigger2)"]), ["Lonely Trigger"], "another name isn't this one");
  assert.deepEqual(kinds([{ ...lonely, runOnInit: true }]), [], "runs at map initialization");
  assert.deepEqual(kinds([lonely], null), [], "the scripts couldn't be read: nobody is called unused");
  assert.equal(validateTriggers(fileOf([lonely]), DATA)[0].severity, "warning");
});

test("only what the map script has runs a trigger; a trigger that does nothing isn't reported", () => {
  // Found on the game's campaign maps against the World Editor's own war3map.j: triggers named only in disabled
  // lines, disabled triggers, Comment lines or script commented out are in no script, so nothing runs them.
  const lonely = trigger("Lonely Trigger", [eca(2, "KillUnit", [P.variable("Hero")])], { id: 2 });
  const run = (extra: Partial<Eca> = {}) => eca(2, "KillUnit", [P.variable("gg_trg_Lonely_Trigger")], [], extra);
  const caller = (ecas: Eca[], extra: Partial<TriggerItem> = {}) => trigger("Caller", [eca(0, "UnitDies", [P.variable("Hero")]), ...ecas], { id: 3, ...extra });
  const found = (items: TriggerItem[], opts: Parameters<typeof validateTriggers>[2] = { scripts: [] }) =>
    validateTriggers(fileOf(items), DATA, opts).filter((i) => i.kind === "noEvents").map((i) => `${i.trigger.name}: ${i.message}`);
  const reported = ["Lonely Trigger: has no events, and no trigger or script runs it"];
  // Control: an enabled line of an enabled trigger runs it, also nested.
  assert.deepEqual(found([lonely, caller([run()])]), []);
  assert.deepEqual(found([lonely, caller([eca(2, "IfThenElseMultiple", [], [run()])])]), [], "nested in an enabled block");
  assert.deepEqual(found([lonely, caller([run({ enabled: false })])]), reported, "a disabled line");
  assert.deepEqual(found([lonely, caller([eca(2, "IfThenElseMultiple", [], [run()], { enabled: false })])]), reported, "inside a disabled block");
  assert.deepEqual(found([lonely, caller([run()], { enabled: false })]), reported, "a disabled trigger");
  assert.deepEqual(found([lonely, caller([run()], { isComment: 1 })]), reported, "a comment");
  assert.deepEqual(found([lonely, caller([eca(2, "CommentString", [P.value("then runs gg_trg_Lonely_Trigger")])])]), reported, "a Comment line");
  // Script text: a call commented out runs nothing; in Lua the comment is --.
  assert.deepEqual(found([lonely], { scripts: ["call TriggerExecute(gg_trg_Lonely_Trigger) // runs it"] }), []);
  assert.deepEqual(found([lonely], { scripts: ["//call TriggerExecute(gg_trg_Lonely_Trigger)"] }), reported, "commented out in JASS");
  assert.deepEqual(found([lonely], { scripts: ["-- TriggerExecute(gg_trg_Lonely_Trigger)"], language: "lua" }), reported, "commented out in Lua");
  assert.deepEqual(found([lonely], { scripts: ["TriggerExecute(gg_trg_Lonely_Trigger)"], language: "lua" }), []);
  assert.deepEqual(found([lonely, caller([eca(2, "CustomScriptCode", [P.value("// call TriggerExecute(gg_trg_Lonely_Trigger)")])])]), reported, "a Custom Script line commented out");
  assert.deepEqual(found([lonely, caller([eca(2, "CustomScriptCode", [P.value("call TriggerExecute(gg_trg_Lonely_Trigger)")])])]), [], "a Custom Script line");
  // Events that are all disabled are no events.
  assert.deepEqual(found([{ ...lonely, ecas: [eca(0, "UnitDies", [P.variable("Hero")], [], { enabled: false }), ...lonely.ecas] }]),
    ["Lonely Trigger: has no enabled events, and no trigger or script runs it"]);
  // Nothing to run: no actions or conditions, only Comment lines, or only disabled ones (headings and leftovers).
  for (const ecas of [[], [eca(2, "CommentString", [P.value("Heading")])], [eca(2, "KillUnit", [P.variable("Hero")], [], { enabled: false })]]) {
    assert.deepEqual(found([{ ...lonely, ecas }]), [], JSON.stringify(ecas.map((e) => e.name)));
  }
  assert.deepEqual(found([{ ...lonely, ecas: [eca(1, "IsAlive", [P.variable("Hero")])] }]).length, 1, "a condition alone is something");
});

test("the script texts that run triggers: the header and enabled custom text triggers", () => {
  const items = [
    trigger("Gui", [], { id: 1 }),
    trigger("Custom", [], { id: 2, isCustom: true }),
    trigger("Off", [], { id: 3, isCustom: true, enabled: false }),
    trigger("Note", [], { id: 4, isCustom: true, isComment: 1 }),
  ];
  const custom = { reforged: true, version: 1, comment: "", header: "header", texts: ["gui text", "custom text", "off text", "note text"] };
  assert.deepEqual(scriptsThatRun(fileOf(items), custom), ["header", "custom text"]);
  assert.deepEqual(scriptsThatRun(fileOf(items), null), []);
});

test("types fit through their base type and the game's special argument types", () => {
  assert.ok(fits(DATA, "integer", "unitcode") && fits(DATA, "unitcode", "integer"));
  assert.ok(fits(DATA, "unit", "widget") && !fits(DATA, "player", "widget"));
  assert.ok(fits(DATA, "real", "VarAsString_Real") && !fits(DATA, "integer", "VarAsString_Real"));
  assert.ok(fits(DATA, "sound", "musicfile"));
  assert.ok(fits(DATA, "player", "intger"), "a type TriggerData doesn't list isn't judged");
  assert.ok(!fits(DATA, "player", "unit"));
});

test("line labels count within the section and within the branch", () => {
  const t = valid();
  assert.equal(lineLabel(t, [0]), "Event 1");
  assert.equal(lineLabel(t, [3]), "Action 1");
  assert.equal(lineLabel(t, [9, 1]), "Action 7 › Then 1");
});
