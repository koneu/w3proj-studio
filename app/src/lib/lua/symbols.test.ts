import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyEnv } from "../jass/check";
import { luaDeclarations, luaDottedAt, luaMemberBase, luaMembers, luaSpot, luaSymbols } from "./symbols";

test("members after a table's name: math.fl offers floor, a text's tables their functions", () => {
  assert.equal(luaMemberBase("local x = math.fl"), "math");
  assert.equal(luaMemberBase("print(string."), "string");
  assert.equal(luaMemberBase("  obj:ne"), "obj");
  assert.equal(luaMemberBase("A.b.c"), "A.b");
  assert.equal(luaMemberBase("local x = floor"), null);
  assert.equal(luaMemberBase("x = 1.5"), null);
  assert.equal(luaMemberBase("s = a..b."), null);
  const text = "M = {}\nfunction M.run()\nend\nfunction M.sub.go()\nend\nfunction M:new()\nend\n";
  const symbols = luaSymbols(emptyEnv(), text);
  const math = luaMembers(symbols, "math").map((m) => m.name);
  assert.ok(math.includes("floor"), math.join(" "));
  assert.ok(math.includes("pi"));
  assert.ok(!math.includes("math"));
  for (const lib of ["string", "table", "os", "io", "coroutine", "utf8"]) assert.ok(luaMembers(symbols, lib).length > 0, lib);
  assert.deepEqual(luaMembers(symbols, "M").map((m) => [m.name, m.table]), [["run", false], ["sub", true], ["new", false]]);
  assert.deepEqual(luaMembers(symbols, "M.sub").map((m) => m.name), ["go"]);
  assert.deepEqual(luaMembers(symbols, "Missing"), []);
  // Not "mathx.abs" for "math".
  assert.deepEqual(luaMembers([{ name: "mathx.abs" }], "math"), []);
});

/** Text with | where the cursor is. */
const at = (s: string) => { const pos = s.indexOf("|"); return luaSpot(s.replace("|", ""), pos); };

test("strings with either quote, and the call they're in", () => {
  assert.deepEqual(at('AddSpecialEffect("Abilities\\\\Fi|", x, y)'), { inString: true, inRawcode: false, prefix: "Abilities\\Fi", from: 18, quote: '"', call: { name: "AddSpecialEffect", argIndex: 0 } });
  assert.equal(at("print('ab|')").prefix, "ab");
  assert.equal(at("print('ab|')").inString, true);
  assert.equal(at('f("a", "b|")').call?.argIndex, 1);
});

test("FourCC's string is a rawcode", () => {
  const s = at("CreateUnit(p, FourCC('hf|'), 0, 0, 0)");
  assert.equal(s.inRawcode, true);
  assert.equal(s.inString, false);
  assert.equal(s.prefix, "hf");
  assert.equal(s.quote, "'");
  assert.deepEqual(s.call, { name: "CreateUnit", argIndex: 1 });
});

test("code: the word and the call", () => {
  const s = at("local u = CreateUnit(p, Fou|");
  assert.equal(s.prefix, "Fou");
  assert.deepEqual(s.call, { name: "CreateUnit", argIndex: 1 });
  assert.equal(at("M.run(|").call?.name, "M.run");
});

test("comments: nothing to complete", () => {
  assert.deepEqual([at("-- Foo|").inString, at("-- Foo|").prefix], [false, ""]);
  assert.equal(at("--[[ long\n comment| ]]").prefix, "");
  assert.equal(at("--[[ c ]] Foo|").prefix, "Foo");
  assert.equal(at("-- 'x\nFoo|").prefix, "Foo");
});

test("a text's declarations", () => {
  const text = `-- function NotThis()
local s = "function AlsoNot()"
local a, b = 1, 2
Score = 0
function M.run(unit, ...)
  local inner = unit
end
local function helper(x)
end
if Score == 1 then end
`;
  const d = luaDeclarations(text);
  const names = (kind: string) => d.filter((s) => s.kind === kind).map((s) => s.name);
  assert.deepEqual(names("function"), ["M.run", "helper"]);
  assert.deepEqual(names("local"), ["s", "a", "b", "inner"]);
  assert.deepEqual(names("global"), ["Score"]);
  assert.deepEqual(names("param"), ["unit", "x"]);
  const run = d.find((s) => s.name === "M.run")!;
  assert.equal(text.slice(run.at!, run.at! + 5), "M.run");
  assert.equal(run.detail, "function M.run(unit, ...)");
  const unit = d.find((s) => s.name === "unit")!;
  assert.equal(text.slice(unit.scope![0], unit.scope![1]).trim().split("\n").pop(), "end");
  assert.ok(text.slice(unit.scope![0], unit.scope![1]).startsWith("function M.run"));
  assert.ok(!text.slice(unit.scope![0], unit.scope![1]).includes("helper"));
  const a = d.find((s) => s.name === "a")!, b = d.find((s) => s.name === "b")!;
  assert.deepEqual([text[a.at!], text[b.at!]], ["a", "b"]);
});

test("table fields: assignments, methods and nested tables are members of their table", () => {
  const text = "T = {}\nT.x = 1\nT.a.b.c = 2\nfunction T.f()\n  self.n = 3\n  if T.y == 1 then end\nend\nfunction T:m()\nend\nlocal v = T.z\nother = 5\n-- T.c = 1\nlocal s = \"T.q = 1\"\n";
  const symbols = luaSymbols(emptyEnv(), text);
  assert.deepEqual(luaMembers(symbols, "T").map((m) => [m.name, m.table]).sort(), [["a", true], ["f", false], ["m", false], ["x", false]]);
  assert.deepEqual(luaMembers(symbols, "T.a").map((m) => [m.name, m.table]), [["b", true]]);
  assert.deepEqual(luaMembers(symbols, "T.a.b").map((m) => m.name), ["c"]);
  assert.deepEqual(luaMembers(symbols, "self").map((m) => m.name), ["n"]);
  // Unrelated names get nothing; `==` and a plain global are no field.
  assert.deepEqual(luaMembers(symbols, "other"), []);
  assert.deepEqual(luaMembers(symbols, "U"), []);
  const x = luaDeclarations(text).find((d) => d.name === "T.x")!;
  assert.equal(x.at, text.indexOf("T.x"));
  assert.equal(x.detail, "field T.x");
});

test("hover name: the dotted name up to the part under the mouse", () => {
  const text = "local y = math.floor(M.run.go(1)) + a..b + 1.5";
  const at = (needle: string, d = 1) => luaDottedAt(text, text.indexOf(needle) + d)?.text;
  assert.equal(at("floor"), "math.floor");
  assert.equal(at("math"), "math");
  assert.equal(at("run"), "M.run");
  assert.equal(at("go"), "M.run.go");
  assert.equal(at("b +"), "b"); // not a..b
  assert.equal(luaDottedAt(text, text.indexOf("1.5")), null);
  assert.equal(luaDottedAt("obj:run()", 5)?.text, "obj:run");
  assert.equal(luaDottedAt("a + b", 3), null);
  // The declarations carry what hover shows for it.
  const sym = luaSymbols(emptyEnv(), text).find((s) => s.name === "math.floor");
  assert.equal(sym?.detail, "Lua: math.floor");
});
