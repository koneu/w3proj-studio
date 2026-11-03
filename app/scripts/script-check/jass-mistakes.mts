// Deliberate mistakes the JASS checker must report (one per case), and correct code it must accept.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
const C = await import(pathToFileURL(process.argv[2] + "/jass/check.ts").href);
const env = C.envFrom([readFileSync("Blizzard.j", "utf8")], C.envFrom([readFileSync("common.j", "utf8")]));
const fn = (body: string, head = "function T takes nothing returns nothing") => `${head}\n${body}\nendfunction\n`;
const bad: [string, string][] = [
  ["missing call", fn("    KillUnit(null)")],
  ["missing set", fn("    local integer i\n    i = 1")],
  ["unknown function", fn("    call KilUnit(null)")],
  ["unknown variable", fn("    set udg_Nope = 1")],
  ["argument count", fn("    call KillUnit()")],
  ["argument type", fn("    call KillUnit(5)")],
  ["assign type", fn("    local unit u = 5")],
  ["string + integer", fn("    local string s = \"a\" + 1")],
  ["condition type", fn("    if 1 then\n    endif")],
  ["return value in nothing", fn("    return 1")],
  ["missing return value", fn("    return", "function T takes nothing returns integer")],
  ["return type", fn("    return \"x\"", "function T takes nothing returns integer")],
  ["local after statement", fn("    call DoNothing()\n    local integer i")],
  ["exitwhen outside loop", fn("    exitwhen true")],
  ["missing endif", fn("    if true then\n    call DoNothing()")],
  ["missing endfunction", "function T takes nothing returns nothing\n    call DoNothing()\n"],
  ["unclosed string", fn("    call BJDebugMsg(\"abc)")],
  ["array without index", fn("    local integer array a\n    set a = 1")],
  ["index on non-array", fn("    local integer i\n    set i[0] = 1")],
  ["set constant", fn("    set bj_PI = 3.0")],
  ["code from function with args", fn("    call TimerStart(CreateTimer(), 1.0, false, function KillUnit)")],
  ["used before defined", "function A takes nothing returns nothing\n    call B()\nendfunction\nfunction B takes nothing returns nothing\nendfunction\n"],
  ["unknown type", fn("    local unitt u")],
  ["rawcode length", fn("    local integer i = 'hfo'")],
  ["compare unit with string", fn("    if GetTriggerUnit() == \"x\" then\n    endif")],
  ["duplicate local", fn("    local integer i\n    local integer i")],
];
const good: [string, string][] = [
  ["int to real", fn("    local real r = 1")],
  ["null handle", fn("    local unit u = null\n    local string s = null")],
  ["subtype", fn("    local widget w = GetTriggerUnit()")],
  ["loop exitwhen in if", fn("    local integer i = 0\n    loop\n        if i > 3 then\n            exitwhen true\n        endif\n        set i = i + 1\n    endloop")],
  ["code", fn("    call TimerStart(CreateTimer(), 1.0, false, function DoNothing)")],
  ["hex and rawcodes", fn("    local integer a = 0xFF + $10 + 'hfoo' + 'a'")],
  ["string concat", fn("    local string s = \"a\" + I2S(1) + null")],
];
let ok = 0;
for (const [name, src] of bad) {
  const d = C.checkJass(src, env);
  if (d.length) { ok++; console.log(`ok   ${name.padEnd(30)} ${d[0].message}`); } else console.log(`MISS ${name}`);
}
for (const [name, src] of good) {
  const d = C.checkJass(src, env);
  if (!d.length) ok++; else console.log(`FALSE ${name}: ${d.map((x: any) => x.message).join("; ")}`);
}
console.log(`${ok}/${bad.length + good.length}`);
