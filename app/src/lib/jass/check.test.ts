import assert from "node:assert/strict";
import { test } from "node:test";
import { checkJass, declarations, emptyEnv, envFrom, envWithout, sigText } from "./check";
import { codeSpot, paramOf } from "./callsite";
import { jassSymbols, triggerOfFunctions } from "./env";
import { miniGameEnv } from "./mini-game.fixture";

const env = miniGameEnv();
const fn = (body: string, head = "function T takes nothing returns nothing") => `${head}\n${body}\nendfunction\n`;
const messages = (src: string, e = env) => checkJass(src, e).map((d) => d.message);

// One mistake each; the checker has to name what's wrong, not just object.
const mistakes: [string, string, RegExp][] = [
  ["missing call", fn("    KillUnit(null)"), /call/i],
  ["missing set", fn("    local integer i\n    i = 1"), /set/i],
  ["unknown function", fn("    call KilUnit(null)"), /KilUnit/],
  ["unknown variable", fn("    set udg_Nope = 1"), /udg_Nope/],
  ["argument count", fn("    call KillUnit()"), /argument/i],
  ["argument type", fn("    call KillUnit(5)"), /integer|unit/i],
  ["assign type", fn("    local unit u = 5"), /integer|unit/i],
  ["string + integer", fn('    local string s = "a" + 1'), /string|integer/i],
  ["condition type", fn("    if 1 then\n    endif"), /boolean/i],
  ["return value in nothing", fn("    return 1"), /return/i],
  ["missing return value", fn("    return", "function T takes nothing returns integer"), /return/i],
  ["return type", fn('    return "x"', "function T takes nothing returns integer"), /string|integer/i],
  ["local after statement", fn("    call DoNothing()\n    local integer i"), /local/i],
  ["exitwhen outside loop", fn("    exitwhen true"), /exitwhen|loop/i],
  ["missing endif", fn("    if true then\n    call DoNothing()"), /endif/i],
  ["missing endfunction", "function T takes nothing returns nothing\n    call DoNothing()\n", /endfunction/i],
  ["unclosed string", fn('    call BJDebugMsg("abc)'), /string/i],
  ["array without index", fn("    local integer array a\n    set a = 1"), /array|index/i],
  ["index on non-array", fn("    local integer i\n    set i[0] = 1"), /array|index/i],
  ["set constant", fn("    set bj_PI = 3.0"), /constant/i],
  ["code from function with args", fn("    call TimerStart(CreateTimer(), 1.0, false, function KillUnit)"), /KillUnit|argument|takes/i],
  ["used before defined", "function A takes nothing returns nothing\n    call B()\nendfunction\nfunction B takes nothing returns nothing\nendfunction\n", /\bB\b/],
  ["unknown type", fn("    local unitt u"), /unitt/],
  ["rawcode length", fn("    local integer i = 'hfo'"), /code|4|length/i],
  ["compare unit with string", fn('    if GetTriggerUnit() == "x" then\n    endif'), /compar|unit|string/i],
  ["duplicate local", fn("    local integer i\n    local integer i"), /\bi\b/],
];

for (const [name, src, why] of mistakes) {
  test(`reports: ${name}`, () => {
    const found = messages(src);
    assert.ok(found.length, "nothing reported");
    assert.ok(found.some((m) => why.test(m)), `unexpected reason: ${found.join("; ")}`);
  });
}

const correct: [string, string][] = [
  ["int to real", fn("    local real r = 1")],
  ["null handle", fn('    local unit u = null\n    local string s = null')],
  ["subtype", fn("    local widget w = GetTriggerUnit()")],
  ["loop exitwhen in if", fn("    local integer i = 0\n    loop\n        if i > 3 then\n            exitwhen true\n        endif\n        set i = i + 1\n    endloop")],
  ["code", fn("    call TimerStart(CreateTimer(), 1.0, false, function DoNothing)")],
  ["hex and rawcodes", fn("    local integer a = 0xFF + $10 + 'hfoo' + 'a'")],
  ["string concat", fn('    local string s = "a" + I2S(1) + null')],
];

for (const [name, src] of correct) {
  test(`accepts: ${name}`, () => assert.deepEqual(messages(src), []));
}

test("a report points at the mistake", () => {
  const src = fn("    call KilUnit(null)");
  const [d] = checkJass(src, env);
  assert.equal(src.slice(d.from, d.to), "KilUnit");
});

test("the world starts empty: nothing is known without an environment", () => {
  assert.notDeepEqual(messages(fn("    call DoNothing()"), emptyEnv()), []);
});

test("a script's own functions are known to the code after them", () => {
  const src = "function A takes integer x returns integer\n    return x\nendfunction\n" + fn("    local integer i = A(1)");
  assert.deepEqual(messages(src), []);
});

test("environments stack, and a script can be taken out of one again", () => {
  const lib = "function Lib takes nothing returns nothing\nendfunction\n";
  const withLib = envFrom([lib], env, ["lib"]);
  assert.equal(withLib.functions.get("Lib")?.source, "lib");
  assert.deepEqual(messages(fn("    call Lib()"), withLib), []);
  assert.notDeepEqual(messages(fn("    call Lib()"), envWithout(withLib, lib)), []);
});

test("declarations lists a script's names with where they are", () => {
  const src = "globals\n    integer g = 0\nendglobals\nfunction F takes integer a returns nothing\n    local unit u\nendfunction\n";
  const got = new Map(declarations(src, env).map((d) => [d.name, d]));
  assert.equal(got.get("g")?.kind, "global");
  assert.equal(got.get("F")?.kind, "function");
  assert.equal(got.get("a")?.kind, "param");
  assert.equal(got.get("u")?.kind, "local");
  const f = got.get("F")!;
  assert.equal(src.slice(f.from, f.to), "F");
  assert.ok(got.get("u")!.scope![0] < got.get("u")!.from);
});

test("sigText writes a signature", () => {
  assert.equal(sigText("F", { params: [{ name: "a", type: "integer" }, { name: "b", type: "unit" }], returns: "real" }), "F takes integer a, unit b returns real");
  assert.equal(sigText("G", { params: [], returns: "nothing" }), "G takes nothing returns nothing");
});

test("codeSpot knows the call and the argument under the cursor", () => {
  const text = "call SetUnitState( GetTriggerUnit(), UNIT_STATE_LIFE, 1 )";
  const spot = codeSpot(text, text.indexOf("UNIT_STATE"));
  assert.equal(spot.call?.name, "SetUnitState");
  assert.equal(spot.call?.argIndex, 1);
  assert.deepEqual(paramOf("native F takes integer a, unit b returns nothing", 1), { name: "b", type: "unit" });
  assert.equal(paramOf("native F takes nothing returns nothing", 0), undefined);
});

test("triggerOfFunctions finds the trigger a function belongs to", () => {
  const script = [
    "//===========================================================================", "// Trigger: Spawn Wave", "//===========================================================================",
    "function Trig_Spawn_Wave_Actions takes nothing returns nothing", "endfunction", "",
  ].join("\r\n");
  assert.equal(triggerOfFunctions(script).get("Trig_Spawn_Wave_Actions"), "Spawn Wave");
});

test("jassSymbols lists the script's functions, not the game's natives", () => {
  const names = jassSymbols(env, fn("    call DoNothing()")).map((s) => s.name);
  assert.ok(names.includes("T"), names.slice(0, 10).join());
});
