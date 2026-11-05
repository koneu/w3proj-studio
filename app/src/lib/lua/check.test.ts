import assert from "node:assert/strict";
import { test } from "node:test";
import { checkLua } from "./check";

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
