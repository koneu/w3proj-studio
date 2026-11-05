import assert from "node:assert/strict";
import { test } from "node:test";
import { luaDeclarations, luaSpot } from "./symbols";

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
