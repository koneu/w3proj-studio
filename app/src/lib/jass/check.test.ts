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

// The rest of what the game's compiler refuses, each with the exact message (the Problems view shows it as it is).
const exact: [string, string, string[]][] = [
  ["a type extending an unknown one", "type foo extends bar\n", ["Unknown type bar"]],
  ["nothing as a parameter type", "function F takes nothing x returns nothing\nendfunction\n", // A broken header leaves its body outside any function.
    ["Expected \"returns\", found \"x\"", "Expected a function, globals or type, found \"endfunction\""]],
  ["nothing as a local's type", fn("    local nothing x"), ["\"nothing\" isn't a type here"]],
  ["code outside a function", "KillUnit(null)\n", ["Code must be inside a function"]],
  ["a stray word at the top", "endif\n", ["Expected a function, globals or type, found \"endif\""]],
  ["a function defined twice", "function F takes nothing returns nothing\nendfunction\nfunction F takes nothing returns nothing\nendfunction\n", ["F is already defined"]],
  ["a global array with a value", "globals\n    integer array a = 1\nendglobals\n", ["Arrays can't have an initial value"]],
  ["a local array with a value", fn("    local integer array a = 1"), ["Arrays can't have an initial value"]],
  ["a constant without a value", "globals\n    constant integer C\nendglobals\n", ["Constants need a value"]],
  ["a global of the wrong type", "globals\n    unit u = 5\nendglobals\n", ["u is unit, the value is integer"]],
  ["globals never closed", "globals\n    integer a\n", ["Missing endglobals"]],
  ["a function inside a function", fn("function G takes nothing returns nothing"),
    ["Missing endfunction for T", "Expected a function, globals or type, found \"endfunction\""]],
  ["calling a variable", fn("    local integer i\n    call i()"), ["i is a variable, not a function"]],
  ["a function used as a value", fn("    local integer i = DoNothing"), ["DoNothing is a function: use DoNothing(…) or function DoNothing"]],
  ["an unknown name indexed", fn("    local integer i = nope[1]"), ["Unknown variable nope"]],
  ["an array read without an index", fn("    local integer array a\n    local integer i = a"), ["a is an array: a[index]"]],
  ["an index on a plain local", fn("    local integer b\n    local integer i = b[0]"), ["b isn't an array"]],
  ["a real index", fn("    local integer array a\n    local integer i = a[1.5]"), ["Array index must be integer, not real"]],
  ["a real index in set", fn("    local integer array a\n    set a[1.5] = 1"), ["Array index must be integer, not real"]],
  ["or on integers", fn("    if 1 or true then\n    endif"), ["\"or\" needs boolean values, not integer and boolean"]],
  ["and on strings", fn('    if true and "x" then\n    endif'), ["\"and\" needs boolean values, not boolean and string"]],
  ["less-than on strings", fn('    if "a" < "b" then\n    endif'), ["\"<\" compares numbers, not string and string"]],
  ["multiplying a boolean", fn("    local integer i = 2 * true"), ["\"*\" needs numbers, not integer and boolean"]],
  ["minus on a string", fn('    local string s = -"x"'), ["\"-\" needs a number, not string"]],
  ["adding a unit to a string", fn('    local string s = "a" + GetTriggerUnit()'), ["Can't add string and unit"]],
  ["a value missing", fn("    local integer i ="), ["Expected a value before the end of the line"]],
  ["a keyword as a value", fn("    local integer i = endif"), ["Expected a value, found \"endif\""]],
  ["something after a statement", fn("    call DoNothing() 1"), ["Unexpected \"1\""]],
  ["a word that's no statement", fn("    loop2"), ["Expected a statement, found \"loop2\""]],
  ["an unexpected character", fn("    local integer i = 1 # + 2"),["Unexpected character \"#\""]],
  ["an object code never closed", fn("    local integer i = 'hfoo"), ["Unclosed object code ('hfoo')"]],
  ["a function reference to an unknown one", fn("    call TimerStart(CreateTimer(), 1.0, false, function Nope)"), ["Unknown function Nope"]],
  // A block left open is one mistake: endfunction still closes the function (it once also said "Missing endfunction").
  ["missing endloop", fn("    loop\n    call DoNothing()"), ["Missing endloop"]],
  ["missing endif, exactly", fn("    if true then\n    call DoNothing()"), ["Missing endif"]],
  ["missing endif after else", fn("    if true then\n    else\n    call DoNothing()"), ["Missing endif"]],
  // An unclosed object code ends at its line: the next line is read on its own (it once swallowed the line end).
  ["an object code never closed, and the next line", fn("    local integer i = 'hfoo\n    local integer j = 'a'"), ["Unclosed object code ('hfoo')"]],
];

for (const [name, src, want] of exact) {
  test(`reports exactly: ${name}`, () => assert.deepEqual(messages(src), want));
}

const alsoCorrect: [string, string][] = [
  ["comments, a leading dot and $ hex", fn("    // a comment\n    local real r = .5 + 1.25 // and another\n    local integer i = $FF")],
  ["elseif and else", fn("    if true then\n    elseif false then\n        call DoNothing()\n    else\n        call DoNothing()\n    endif")],
  ["an integer compared with null (vJASS structs)", fn("    local integer this = 0\n    if this == null or null != this then\n    endif")],
  ["debug before a statement", fn("    debug call DoNothing()")],
  ["an escaped object code", fn("    local integer i = '\\\\'")],
  ["a string with an escaped quote", fn('    local string s = "a\\"b"')],
  ["a constant native and a constant function", "constant native C takes nothing returns integer\nconstant function D takes nothing returns integer\n    return C()\nendfunction\n"],
  ["a type the script declares", "type thing extends handle\nfunction F takes thing t returns handle\n    return t\nendfunction\n"],
  ["a global array set by index", "globals\n    integer array a\n    constant real R = 1\nendglobals\n" + fn("    set a[0] = 1\n    set a[1] = a[0] + 1")],
];

for (const [name, src] of alsoCorrect) {
  test(`accepts: ${name}`, () => assert.deepEqual(messages(src), []));
}

test("one mistake doesn't hide the next: a broken line is skipped, the rest is still checked", () => {
  const src = fn("    call KillUnit(\n    call KilUnit(null)") + fn("    set udg_Nope = 1", "function U takes nothing returns nothing");
  const found = messages(src);
  assert.equal(found.length, 3, found.join("; "));
  assert.match(found[1], /KilUnit/);
  assert.match(found[2], /udg_Nope/);
});

test("a whole script's own functions must come before their use; a fragment's needn't", () => {
  const later = "function A takes nothing returns nothing\n    call TimerStart(CreateTimer(), 1.0, false, function B)\nendfunction\nfunction B takes nothing returns nothing\nendfunction\n";
  assert.deepEqual(messages(later), ["B is defined further down: functions must come before their use"]);
  // The map script's env already holds B (envFrom of the whole script): the order still counts.
  const withB = envFrom(["function B takes nothing returns nothing\nendfunction\n"], env);
  assert.deepEqual(checkJass(fn("    call B()") + "function B takes nothing returns nothing\nendfunction\n", withB).map((d) => d.message),
    ["B is defined further down: functions must come before their use"]);
  // A trigger's custom text is a fragment: what the env knows may come from anywhere.
  assert.deepEqual(checkJass(fn("    call B()"), withB, { ordered: false }), []);
});

test("a syntax error points at a character even at the end of the text", () => {
  const src = "function F takes nothing returns nothing";
  const [d] = checkJass(src, env);
  assert.equal(d.from, src.length);
  assert.equal(d.to, src.length + 1, "never an empty range the editor can't show");
});

test("declarations skip syntax errors and report no semantic ones", () => {
  const src = "function F takes integer a returns nothing\n    local unitt u\n    call Nope(1 2)\n    local integer late\nendfunction\nglobals\n    unit u = 5\nendglobals\n";
  const names = declarations(src, env).map((d) => `${d.kind}:${d.name}`);
  assert.deepEqual(names, ["function:F", "param:a", "local:u", "local:late", "global:u"]);
});

test("envWithout leaves the game's declarations and takes only the script's own out", () => {
  const src = "globals\n    integer udg_X\nendglobals\nfunction Mine takes nothing returns nothing\nendfunction\n";
  const full = envFrom([src], env);
  const out = envWithout(full, src);
  assert.ok(!out.functions.has("Mine") && !out.globals.has("udg_X"));
  assert.ok(out.functions.has("KillUnit") && out.globals.has("bj_PI"));
  // Not changed in place.
  assert.ok(full.functions.has("Mine"));
});

// WoW Reforged's war3map.j (smoketest_models/wc3_wowr), which the game runs, has both of these.
test("a comparison's right side may be a not", () => {
  assert.deepEqual(messages(fn("    if true == not false and false != not true then\n    endif")), []);
  // Control: a comparison with nothing on its right side is still an error.
  assert.notDeepEqual(messages(fn("    if true == then\n    endif")), []);
  // "not" on a non-boolean is still reported there.
  assert.ok(messages(fn("    if true == not 1 then\n    endif")).some((m) => /not.*boolean/.test(m)));
});

test("two unrelated handle types compare with a warning, not an error; a handle with a string stays an error", () => {
  const found = checkJass(fn("    local player p = null\n    local group g = null\n    if p != g then\n    endif"), env);
  assert.deepEqual(found.map((d) => [d.severity, d.message]), [["warning", "Comparing player with group: never the same object"]]);
  const control = checkJass(fn('    local player p = null\n    if p == "x" then\n    endif'), env);
  assert.deepEqual(control.map((d) => d.severity), ["error"]);
});

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
