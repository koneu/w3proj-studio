// Per-file diagnostics of the trigger folders: each script file linted with its own lines (frontmatter line 1), vJASS
// left to JassHelper, Lua's syntax and unknown calls, and the map script's findings in a copied text told once, at the file's line.

import assert from "node:assert/strict";
import { test } from "node:test";
import { envFrom } from "../jass/check";
import { luaApiFrom, luaKnownNames } from "../lua/check";
import { hasFrontmatter, lintTexts, placeScriptDiagnostics, type TriggerText } from "./textcheck";

const GAME = envFrom(["type unit extends handle\nnative DoNothing takes nothing returns nothing\nnative CreateTrigger takes nothing returns trigger\ntype trigger extends handle\n"]);
const FRONT = `// @w3proj {"type":8,"name":"Spawn","enabled":true,"initiallyOff":false,"runOnInit":false}`;

test("a JASS file is linted with its own lines, the frontmatter being line 1", () => {
  const text = `${FRONT}\r\nfunction Trig_Spawn_Actions takes nothing returns nothing\r\n    call NoSuchThing()\r\nendfunction\r\n`;
  const found = lintTexts([{ path: "map/triggers/Spawn.j", text, global: "gg_trg_Spawn" }], "jass", GAME, true);
  assert.deepEqual(found.map((d) => [d.path, d.line, d.message]), [["map/triggers/Spawn.j", 3, "Unknown function NoSuchThing"]]);
  // The text editor's offset: CRLF counts as one character.
  const lf = text.replace(/\r\n/g, "\n");
  assert.equal(found[0].offset, lf.indexOf("NoSuchThing"));
  // Its own functions and its trigger's global are known; another file's come from the map script.
  const own = `function Helper takes nothing returns nothing\nendfunction\nfunction InitTrig_Spawn takes nothing returns nothing\n    set gg_trg_Spawn = CreateTrigger()\n    call Helper()\n    call FromElsewhere()\nendfunction\n`;
  assert.deepEqual(lintTexts([{ path: "map/triggers/Spawn.j", text: own, global: "gg_trg_Spawn" }], "jass", GAME, true).map((d) => d.message), ["Unknown function FromElsewhere"]);
  const withScript = envFrom(["function FromElsewhere takes nothing returns nothing\nendfunction\n"], GAME);
  assert.deepEqual(lintTexts([{ path: "map/triggers/Spawn.j", text: own, global: "gg_trg_Spawn" }], "jass", withScript, true), []);
  // Without its global the same text has an unknown variable (control).
  assert.deepEqual(lintTexts([{ path: "map/triggers/Spawn.j", text: own }], "jass", withScript, true).map((d) => d.message), ["Unknown variable gg_trg_Spawn"]);
});

test("udg_ and gg_ names are judged only when asked; other unknown names always", () => {
  const text = "function F takes nothing returns nothing\n    set udg_Count = 1\n    call gg_Thing()\n    call Nope()\nendfunction\n";
  assert.deepEqual(lintTexts([{ path: "map/triggers/F.j", text }], "jass", GAME, false).map((d) => d.message), ["Unknown function Nope"]);
  assert.equal(lintTexts([{ path: "map/triggers/F.j", text }], "jass", GAME, true).length, 3, "control: with the script they are");
});

test("vJASS files are left to JassHelper; Lua files get the syntax check only", () => {
  const vjass = "library L\n    function F takes nothing returns nothing\n        call Nope()\n    endfunction\nendlibrary\n";
  assert.deepEqual(lintTexts([{ path: "map/triggers/L.j", text: vjass }], "jass", GAME, true), []);
  assert.deepEqual(lintTexts([{ path: "map/triggers/L.vjass", text: "function F takes nothing returns nothing\n call Nope()\nendfunction\n" }], "jass", GAME, true), []);
  const lua = `-- @w3proj {"type":32,"name":"S"}\nfunction S()\n  if x then\n    UnknownName()\nend\n`;
  const found = lintTexts([{ path: "map/triggers/S.lua", text: lua }], "lua", null, true);
  assert.equal(found.length, 1);
  assert.deepEqual([found[0].path, found[0].line], ["map/triggers/S.lua", 2]);
  assert.match(found[0].message, /"function" isn't closed/);
  assert.deepEqual(lintTexts([{ path: "map/triggers/S.lua", text: lua.replace("  if x then\n", "") }], "lua", null, true), [], "names aren't looked at");
  // With the names known (the game's API, the script's and the files' globals), an unknown call is a warning at its line.
  const names = luaKnownNames(luaApiFrom(GAME, ""), ["function Defined() end\n"]);
  const own = lua.replace("  if x then\n", "  Defined()\n");
  const named = lintTexts([{ path: "map/triggers/S.lua", text: own }], "lua", null, true, names);
  assert.deepEqual(named.map((d) => [d.line, d.severity, d.message]), [[4, "warning", "Unknown function UnknownName"]]);
});

test("a zero byte (U+10FF00 in the file) doesn't move a finding or make one", () => {
  const text = "function F takes nothing returns nothing\nendfunction\n\u{10FF00}\u{10FF00}";
  assert.deepEqual(lintTexts([{ path: "map/triggers/F.j", text }], "jass", GAME, true), []);
});

test("frontmatter is the first line only, in the file's language", () => {
  assert.equal(hasFrontmatter(`${FRONT}\nx`, false), true);
  assert.equal(hasFrontmatter(`${String.fromCharCode(0xfeff)}${FRONT}\nx`, false), true);
  assert.equal(hasFrontmatter(`x\n${FRONT}`, false), false);
  assert.equal(hasFrontmatter(`${FRONT}\nx`, true), false);
  assert.equal(hasFrontmatter(`-- @w3proj {}\nx`, true), true);
});

test("the map script's findings in a copied text are told at the file's line, once", () => {
  const body = "function A takes nothing returns nothing\n    call Later()\n    call Nope()\nendfunction\n";
  const texts: TriggerText[] = [
    { path: "map/triggers/header.j", text: "// header\n" },
    { path: "map/triggers/A.j", text: `${FRONT}\n${body}` },
  ];
  // The generator writes CRLF; the text's own breaks are LF.
  const script = `globals\nendglobals\n// header\n${body}function main takes nothing returns nothing\n    call Broken()\nendfunction\n`.replace(/\n/g, "\r\n");
  const at = (what: string) => script.indexOf(what);
  const diags = [
    { from: at("Later"), message: "Later is defined further down: functions must come before their use", severity: "error" as const },
    { from: at("Nope"), message: "Unknown function Nope", severity: "error" as const },
    { from: at("Broken"), message: "Unknown function Broken", severity: "error" as const },
  ];
  const perFile = lintTexts([texts[1]], "jass", GAME, true);
  assert.deepEqual(perFile.map((d) => [d.line, d.message]), [[3, "Unknown function Later"], [4, "Unknown function Nope"]]);
  const { kept, moved } = placeScriptDiagnostics(script, texts, "jass", diags, perFile);
  assert.deepEqual(kept.map((d) => d.message), ["Unknown function Broken"], "outside every text: the script's");
  // Line 3 is the file's already (its own lint said it): dropped; line 4 too. Without the file's findings both move.
  assert.deepEqual(moved, []);
  const again = placeScriptDiagnostics(script, texts, "jass", diags, []);
  assert.deepEqual(again.moved.map((d) => [d.path, d.line, d.message]), [
    ["map/triggers/A.j", 3, "Later is defined further down: functions must come before their use"],
    ["map/triggers/A.j", 4, "Unknown function Nope"],
  ]);
  const file = texts[1].text;
  assert.equal(again.moved[0].offset, file.indexOf("Later"), "the reveal is the file's offset");
  // A text that isn't in the script as it is has no place: nothing moves.
  assert.deepEqual(placeScriptDiagnostics(script, [{ path: "map/triggers/A.j", text: `${FRONT}\nfunction Other takes nothing returns nothing\nendfunction\n` }], "jass", diags, []).kept.length, 3);
});
