import assert from "node:assert/strict";
import { test } from "node:test";
import { miniGameEnv } from "../jass/mini-game.fixture";
import { checkLua, luaApiFrom, luaKnownNames } from "./check";

const messages = (s: string) => checkLua(s).map((p) => p.message);

test("valid Lua has no problems", () => {
  const ok = `
-- a comment with end and ( in it
--[[ a long one: function ]]
--[==[ with ]] inside ]==]
local t = { a = 1, ["b"] = function(x) return x end, [[long key]] }
function M.f(a, ...)
  if a then print("end") elseif not a then print('(') else print(1.5e3) end
  for i = 1, 3 do t[i] = i end
  while false do break end
  repeat local y = 1 until y == 1
  do local z = [==[ ]] end ]==] end
  return t.a .. "x" .. 0x1F
end
`;
  assert.deepEqual(checkLua(ok), []);
});

test("names that every JavaScript object has aren't Lua", () => {
  assert.deepEqual(checkLua("local function f(self, constructor, toString)\n  return constructor\nend\n"), []);
});

test("varargs, concatenation and labels before keywords", () => {
  assert.deepEqual(checkLua("function f(...)\n  if ... then return end\n  for _, v in ... do end\n  local s = a .. b\nend\n"), []);
  assert.deepEqual(checkLua("do\n  goto done\n  ::done:: end\n"), []);
});

test("a comment ending in a dot isn't a field access", () => {
  assert.deepEqual(checkLua("-- Does a thing.\nfunction f()\nend\n"), []);
  assert.deepEqual(checkLua("t.end = 1\nprint(t:then())\n"), []);
});

test("blocks that don't close, or close too often", () => {
  assert.deepEqual(messages("function f()\n  if x then\n  end\n"), ['"function" isn\'t closed']);
  assert.deepEqual(messages("function f()\nend\nend\n"), ['"end" without anything to close']);
  assert.deepEqual(messages("repeat\nend\n"), ['Expected "until" for the "repeat" before it, found "end"']);
  assert.deepEqual(messages("else\n"), ['"else" outside an if']);
});

test("brackets", () => {
  assert.deepEqual(messages("print(1\n"), ['"(" isn\'t closed']);
  assert.deepEqual(messages("print(1))\n"), ['")" without anything to close']);
  assert.deepEqual(messages("t = { (1 }\n"), ['Expected ")" for the "(" before it, found "}"']);
});

test("strings and comments", () => {
  assert.deepEqual(messages('print("abc\nprint(1)\n').slice(0, 1), ["String isn't closed"]);
  assert.deepEqual(messages('x = "a\\"b"\n'), []);
  assert.deepEqual(messages("--[[ never closed\n"), ["Comment isn't closed"]);
  assert.deepEqual(messages("x = [[ never closed\n"), ["String isn't closed"]);
});

test("one mistake gives few reports, at the right place", () => {
  const src = "function f()\n  if x then\n    y()\n\nfunction g()\nend\n";
  const p = checkLua(src);
  assert.ok(p.length <= 3, String(p.length));
  assert.equal(src.slice(p[0].from, p[0].to), "function");
});

// ---- Names ----

/** The game's API as the tests know it: the mini common.j and Blizzard.j, and one common.ai native. */
const API = luaApiFrom(miniGameEnv(), "native UnitAlive takes unit id returns boolean\nfunction NotNative takes nothing returns nothing\nendfunction\n");
/** The unknown names `src` calls, checked against the API and the globals of `scripts`. */
const unknown = (src: string, scripts: string[] = []) => checkLua(src, luaKnownNames(API, scripts)).map((p) => {
  assert.equal(p.severity, "warning", p.message);
  return src.slice(p.from, p.to);
});

test("names: calls of names nothing defines are reported, as a warning at the name", () => {
  const src = "function F()\n  Nope(1)\nend\n";
  const p = checkLua(src, luaKnownNames(API));
  assert.deepEqual(p.map((x) => [x.message, x.severity, src.slice(x.from, x.to)]), [["Unknown function Nope", "warning", "Nope"]]);
  // Each kind of call: arguments, a string, a table; also inside expressions and after "..".
  assert.deepEqual(unknown('A(1)\nB "x"\nC { 1 }\nlocal s = "a" .. D()\nreturn E(F())\n'), ["A", "B", "C", "D", "E", "F"]);
  // Control: without the known names (or with null: can't tell) only the syntax is checked.
  assert.deepEqual(checkLua(src), []);
  assert.deepEqual(checkLua(src, null), []);
});

test("names: the game's API and Lua's own", () => {
  assert.deepEqual(unknown([
    "Player(0)", "I2S(1)", "BJDebugMsg('x')", "UnitAlive(u)", "local id = FourCC('hfoo')", "udg_x = __jarray(0)",
    "print(tostring(1), tonumber('2'), type(x), select('#', ...))", "for k, v in pairs(t) do end", "for i, v in ipairs(t) do end",
    "pcall(f)", "xpcall(f, print)", "error('x')", "assert(true)", "setmetatable({}, {})", "getmetatable(t)", "rawget(t, 1)", "rawset(t, 1, 2)",
    "next(t)", "unpack(t)", "table.unpack(t)", "require('x')", "collectgarbage()", "coroutine.wrap(f)()", "math.floor(1)", "string.format('%d', 1)",
    "os.clock()", "utf8.char(65)", "debug.traceback()",
  ].join("\n")), []);
  // common.ai's JASS functions aren't in the game's Lua, only its natives.
  assert.deepEqual(unknown("NotNative()\n"), ["NotNative"]);
});

test("names: what the text defines, wherever it is", () => {
  const ok = [
    // Forward references: functions run after the whole script is loaded.
    "function Main()\n  Later()\n  AlsoLater()\nend\nfunction Later() end\nAlsoLater = function() end\n",
    // Recursion, local and global.
    "local function fact(n) if n < 2 then return 1 end return n * fact(n - 1) end\nfunction Fib(n) return n < 2 and n or Fib(n - 1) + Fib(n - 2) end\n",
    // Upvalues: a local of the function around.
    "function Make()\n  local cb = function() end\n  return function() cb() end\nend\n",
    // Shadowing: a parameter or local named like a global (also one never defined).
    "function F(Player, cb, ...)\n  Player(0)\n  cb()\n  local print = function() end\n  print()\nend\n",
    // Loop variables, both kinds.
    "for i, f in ipairs(list) do f(i) end\nfor g = 1, 2 do end\n",
    // A local declared after its use in the same block, and one with an attribute.
    "do\n  local x <const>, h = 1, nil\n  h()\nend\n",
    // Several targets, and globals made by assignment in a function.
    "function Init()\n  a, b = function() end, function() end\nend\nfunction Run() a() b() end\n",
    // Methods and fields are never judged, nor what they're called on.
    "Obj:method()\nObj.field()\nobj.a.b.c()\nM = {}\nfunction M.f() end\nfunction M:g() self:f() end\n",
    // Metatables: __call and __index.
    "local C = setmetatable({}, { __call = function(self, x) return x end, __index = function(t, k) return k end })\nC(1)\n",
    // Varargs and select.
    "function V(...)\n  local n = select('#', ...)\n  local t = { ... }\n  return n, t\nend\n",
    // Keywords as fields, labels and goto.
    "t.end = 1\nfor i = 1, 2 do\n  if i then goto continue end\n  ::continue::\nend\n",
    // A string, a comment or a long string with a call in it.
    "local s = 'Nope()' -- Nope()\nlocal l = [[ Nope() ]]\n--[==[ Nope() ]==]\n",
    // _G with a plain name defines it.
    "_G.Dyn = function() end\n_G['Dyn2'] = function() end\nDyn() Dyn2()\n",
  ];
  for (const src of ok) assert.deepEqual(unknown(src), [], src);
});

test("names: scopes end with their blocks", () => {
  assert.deepEqual(unknown("function A(cb)\n  cb()\nend\nfunction B()\n  cb()\nend\n"), ["cb"]);
  assert.deepEqual(unknown("for i, f in ipairs(t) do f() end\nf()\n"), ["f"]);
  assert.deepEqual(unknown("do\n  local h\nend\nh()\n"), ["h"]);
  assert.deepEqual(unknown("if x then\n  local h\nelse\n  h()\nend\n"), ["h"]);
  // A repeat's locals stay known in its condition.
  assert.deepEqual(unknown("repeat\n  local done\nuntil done()\n"), []);
});

test("names: another script's globals count (the map script for a trigger's text)", () => {
  assert.deepEqual(unknown("Helper()\n"), ["Helper"]);
  assert.deepEqual(unknown("Helper()\n", ["function Helper() end\n"]), []);
  assert.deepEqual(unknown("Helper()\n", ["local function Helper() end\n"]), [], "a file-level local of the script before the text");
});

test("names: a script with globals it can't see isn't judged", () => {
  for (const dyn of [
    "_G[name] = function() end", "_G[k], x = f, 1", "local env = _G", "setmetatable(_G, mt)", "rawset(_G, k, v)",
    "globals(function(_ENV) end)", "load('x = 1')()", "loadstring(s)()", "local l = load", "dofile('x')", "f(x, _G)", "pcall(f, a, load)",
  ]) {
    assert.deepEqual(unknown(`${dyn}\nNope()\n`), [], dyn);
    assert.equal(luaKnownNames(API, [dyn]), null, dyn);
  }
  // Reads by a computed name don't define anything; a script's own function named load does.
  assert.deepEqual(unknown("local f = _G['On' .. x]\n_ENV[k](1)\nNope()\n"), ["Nope"]);
  assert.deepEqual(unknown("local function load(f) end\nload('x')\nNope()\n"), ["Nope"]);
  assert.deepEqual(unknown("local module = {}\nmodule()\nNope()\n"), ["Nope"]);
  // No API: nothing judged.
  assert.equal(luaKnownNames(null, []), null);
});

test("names: long lists and deep brackets take one pass", () => {
  const n = 200000;
  const args = Array.from({ length: n }, (_, i) => `a${i}`).join(", ");
  const nested = `${"_G[".repeat(n)}k${"]".repeat(n)}`;
  const t0 = Date.now();
  assert.deepEqual(unknown(`f(${args})\nlocal x = ${nested}\n`), ["f"]);
  assert.equal(luaKnownNames(API, [`${"_G[".repeat(n)}`])?.size ?? null, null, "a bracket that doesn't close: can't tell");
  // Linear takes about a second; a quadratic pass over 200,000 items would take minutes. The bound is loose
  // on purpose: a gate runs next to other work and the machine can be slow (8.8 s seen under load 14).
  assert.ok(Date.now() - t0 < 60000, `${Date.now() - t0} ms`);
});

test("names: a script whose blocks don't close only gets the syntax report", () => {
  assert.deepEqual(checkLua("function F()\n  Nope()\n", luaKnownNames(API)).map((p) => p.message), ['"function" isn\'t closed']);
});
