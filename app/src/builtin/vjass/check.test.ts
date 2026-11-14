// "Check with JassHelper": the script it compiles (the checked text inside the map's script) and where JassHelper's
// errors are put. The logs are the game's jasshelper.exe's own (2026-11-14); app-smoke's vjassCheck runs it for real.

import assert from "node:assert/strict";
import { test } from "node:test";
import { generateScript, type ScriptInput } from "../../lib/script/jass";
import { parseTriggerData } from "../../lib/triggers/triggerdata";
import type { CustomTextFile, TriggerFile, TriggerItem } from "../../lib/triggers/wtg";
import { checkMessages, markTexts, placeErrors } from "./check";

const data = parseTriggerData(`
[TriggerTypes]
integer=0,1,1,Integer
[TriggerEvents]
MapInitializationEvent=0,nothing
[TriggerActions]
DoNothing=0,nothing
`);
const item = (name: string, extra: Partial<TriggerItem> = {}): TriggerItem =>
  ({ type: 8, name, description: "", isComment: 0, id: 0, enabled: true, isCustom: true, initiallyOff: false, runOnInit: false, parent: 0, ecas: [], ...extra });

const LIB_A = "library A\r\n    function AF takes nothing returns nothing\r\n    endfunction\r\nendlibrary\r\n";
// No line break at its end, as a text typed in the editor may be.
const LIB_B = "library B requires A\r\n    function BF takes nothing returns nothing\r\n        call AF()\r\n        call KillUnit(gg_unit_hfoo_0001)\r\n        call AF()\r\n    endfunction\r\nendlibrary";
const PLAIN = "function Trig_Plain_Actions takes nothing returns nothing\r\n    call BF()\r\nendfunction\r\nfunction InitTrig_Plain takes nothing returns nothing\r\nendfunction\r\n";

const libA = item("Lib A", { type: 32 }), usesA = item("Uses A"), plain = item("Plain"), gui = item("Gui", { isCustom: false });
const triggers: TriggerFile = { reforged: true, version: 7, counts: [], unknown: 2, variables: [], items: [gui, usesA, libA, plain] };
const custom: CustomTextFile = { reforged: true, version: 1, comment: "", header: "// the map's header\r\nfunction Head takes nothing returns nothing\r\nendfunction\r\n", texts: [null, LIB_B, LIB_A, PLAIN] };
const footman = { id: "hfoo", variation: 0, position: [0, 0, 0], angle: 0, player: 0, hp: -1, mana: -1, gold: 0, targetAcquisition: -1, level: 1, inventory: [], abilities: [], color: -1, waygate: -1, editorId: 1 };
const script = (t: TriggerFile, c: CustomTextFile) => generateScript({
  info: { name: "M", author: "", description: "", version: 31, flags: 0, tileset: "L", cameraBounds: [-1024, -1024, 1024, 1024], soundEnvironment: "", lightEnvironment: "",
    players: [{ id: 0, controller: 1, race: 1, fixedStart: 0, name: "P", start: [0, 0], allyLow: 0, allyHigh: 0 }], forces: [{ flags: 0, players: 1, name: "F" }] },
  data, lights: { terrain: "T.mdl", unit: "U.mdl" }, triggers: t, custom: c, units: [footman], kindOf: () => "unit",
} as unknown as ScriptInput);
const NONCE = "n0nce";
const lineOf = (text: string, line: string) => text.split("\r\n").indexOf(line) + 1;

test("the checked script is the map's: the other texts in its order, the placed unit's global, the checked text in it", () => {
  const marked = markTexts(triggers, custom, usesA, NONCE);
  const input = script(marked.triggers, marked.custom);
  // What the text alone doesn't have (the old check compiled only it): the library it requires, the global it names.
  assert.ok(!LIB_B.includes("library A") && !/unit\s+gg_unit_hfoo_0001/.test(LIB_B));
  assert.match(input, /^library A\r$/m);
  assert.match(input, /^\s*unit\s+gg_unit_hfoo_0001\s*=\s*null\r$/m);
  assert.match(input, /^function main takes nothing returns nothing\r$/m);
  // But for the marks it is the script the map's own compile gets, line for line.
  const marks = input.split("\r\n").filter((l) => l.startsWith("//w3proj-check"));
  // The script item first (Custom Script Code), the header, then the triggers; the GUI trigger has no text.
  assert.deepEqual(marks.map((l) => l.split(" ").slice(2).join(" ")), ["3 begin", "3 end", "0 begin", "0 end", "2 begin", "2 end", "4 begin", "4 end"]);
  assert.equal(input.split("\r\n").filter((l) => !l.startsWith("//w3proj-check")).join("\r\n"), script(triggers, custom));
  assert.equal(marked.own, 2);
  assert.deepEqual(marked.names, ["the map header", '"Gui"', '"Uses A"', '"Lib A"', '"Plain"']);
  // Nothing given was changed.
  assert.equal(custom.texts[1], LIB_B);
  assert.equal(triggers.items[1], usesA);
});

test("a text that is switched off is checked as if it were on; the map's script leaves it out", () => {
  const off = { ...usesA, enabled: false };
  const file = { ...triggers, items: [gui, off, libA, plain] };
  assert.ok(!script(file, custom).includes("library B"));
  const marked = markTexts(file, custom, off, NONCE);
  assert.ok(script(marked.triggers, marked.custom).includes("library B requires A"));
  assert.equal(off.enabled, false);
  assert.equal(marked.own, 2);
});

test("step 1 errors: JassHelper's line is the input's, found by the marks", () => {
  const marked = markTexts(triggers, custom, usesA, NONCE);
  const input = script(marked.triggers, marked.custom);
  const own = lineOf(input, "library B requires A"), other = lineOf(input, "library A"), generated = lineOf(input, "function main takes nothing returns nothing");
  const log = `logs\\currentmapscript.j\r\nJASSHelper - Step 1 (textmacros, libraries, scopes)\r\nLine ${own}: Missing requirement: A (libraries cannot require scopes)\r\n`
    + `Line ${own + 6}: Missing: endlibrary\r\nLine ${other + 1}: Scope redeclared : 'X'\r\nLine ${generated}: Unexpected\r\n4\r\n`;
  const errors = placeErrors(log, input, input, NONCE);
  assert.deepEqual(errors, [
    { message: "Missing requirement: A (libraries cannot require scopes)", text: 2, line: 1 },
    { message: "Missing: endlibrary", text: 2, line: 7 },
    { message: "Scope redeclared : 'X'", text: 3, line: 2 },
    { message: "Unexpected", text: null, code: "function main takes nothing returns nothing" },
  ]);
  assert.deepEqual(checkMessages(errors, marked), {
    own: ["Line 1: Missing requirement: A (libraries cannot require scopes)", "Line 7: Missing: endlibrary"],
    others: ['in "Lib A", line 2: Scope redeclared : \'X\'', "in the map's script: Unexpected (at: function main takes nothing returns nothing)"],
  });
  // Without the marks (another run's script) nothing is taken for this text's.
  assert.ok(placeErrors(log, input, input, "other").every((e) => e.text === null));
});

test("later steps and pjass: lines of the script after step 1, found by the library's name or the marks and by what the line says", () => {
  const marked = markTexts(triggers, custom, usesA, NONCE);
  const input = script(marked.triggers, marked.custom);
  // As JassHelper leaves it: the libraries' code first, spaces as it likes, the marks where they were.
  const current = ["globals", "//globals from A:", "constant boolean LIBRARY_A=true", "//endglobals from A", "unit gg_unit_hfoo_0001= null", "endglobals",
    "//library A:", "    function AF takes nothing returns nothing", "    endfunction", "", "//library A ends",
    "//library B:", "    function BF takes nothing returns nothing", "        call AF()", "        call KillUnit(gg_unit_hfoo_0001)", "        call AF()", "    endfunction", "", "//library B ends",
    `//w3proj-check ${NONCE} 0 begin`, "// the map's header", "function Head takes nothing returns nothing", "endfunction", "", `//w3proj-check ${NONCE} 0 end`,
    `//w3proj-check ${NONCE} 2 begin`, `//w3proj-check ${NONCE} 2 end`,
    `//w3proj-check ${NONCE} 4 begin`, "function Trig_Plain_Actions takes nothing returns nothing", "    call BF( )", "endfunction", `//w3proj-check ${NONCE} 4 end`,
    "function main takes nothing returns nothing", "    call Nope()", "endfunction"].join("\r\n");
  const at = (line: string, nth = 0) => current.split("\r\n").map((l, k) => (l === line ? k + 1 : 0)).filter(Boolean)[nth];
  const log = `logs\\currentmapscript.j\r\npjass.exe\r\nLine ${at("        call KillUnit(gg_unit_hfoo_0001)")}:  Undeclared variable gg_unit_hfoo_0001\r\n`
    + `Line ${at("        call AF()", 1)}:  Second call\r\nLine ${at("    endfunction")}:  In library A\r\nLine ${at("    call BF( )")}:  Undeclared function BF\r\n`
    + `Line ${at("function Head takes nothing returns nothing")}:  In the header\r\nLine ${at("    call Nope()")}:  Undeclared function Nope\r\nLine 1881173120: Missing: endblock\r\n7\r\n`;
  const errors = placeErrors(log, input, current, NONCE);
  assert.deepEqual(errors, [
    { message: "Undeclared variable gg_unit_hfoo_0001", text: 2, line: 4 },
    // The second of two lines that say the same.
    { message: "Second call", text: 2, line: 5 },
    { message: "In library A", text: 3, line: 3 },
    { message: "Undeclared function BF", text: 4, line: 2 },
    { message: "In the header", text: 0, line: 2 },
    { message: "Undeclared function Nope", text: null, code: "call Nope()" },
    // A line number JassHelper made up.
    { message: "Missing: endblock", text: null },
  ]);
  const said = checkMessages(errors, marked);
  assert.deepEqual(said.own, ["Line 4: Undeclared variable gg_unit_hfoo_0001", "Line 5: Second call"]);
  assert.equal(said.others[0], 'in "Lib A", line 3: In library A');
  assert.equal(said.others[2], "in the map header, line 2: In the header");

  // A line JassHelper wrote anew (a private name with its prefix): the text is known, the line isn't.
  const renamed = current.replace("        call KillUnit(gg_unit_hfoo_0001)", "        call B___Hidden()");
  assert.deepEqual(placeErrors(`logs\\currentmapscript.j\r\npjass.exe\r\nLine 15:  Undeclared function B___Hidden\r\n1\r\n`, input, renamed, NONCE),
    [{ message: "Undeclared function B___Hidden", text: 2, code: "call B___Hidden()" }]);
  // The script it read can't be read: its lines aren't taken for the input's (this one is the checked text's first there).
  const first = lineOf(input, "library B requires A");
  assert.deepEqual(placeErrors(`x\r\npjass.exe\r\nLine ${first}:  Something\r\n1\r\n`, input, null, NONCE), [{ message: "Something", text: null }]);
  assert.equal(placeErrors(`x\r\nJASSHelper - Step 1 (textmacros, libraries, scopes)\r\nLine ${first}: Something\r\n1\r\n`, input, null, NONCE)[0].text, 2);
  // No line at all: what JassHelper said.
  assert.deepEqual(placeErrors("exit code 3", input, null, NONCE), [{ message: "exit code 3", text: null }]);
});
