import assert from "node:assert/strict";
import { test } from "node:test";
import type { JassSymbol } from "../../lib/jass/env";
import { describeProblems, findSymbols } from "./scriptinfo";

const script = ["globals", "endglobals", "function First takes nothing returns nothing", "    call Oops()", "endfunction", "", "    stray", "function Second takes nothing returns nothing", "    local x y", "endfunction"].join("\n");
const at = (text: string) => script.indexOf(text);

test("a problem says its line, its code and whose it is", () => {
  const got = describeProblems(script, [{ from: at("call Oops"), message: "unknown function", severity: "error" }], new Map([["First", "Fire"]]));
  assert.deepEqual(got, { errors: 1, warnings: 0, problems: [{ severity: "error", message: "unknown function", line: 4, code: "call Oops()", function: "First", trigger: "Fire" }] });
});

test("errors go first, and code outside functions belongs to none", () => {
  const got = describeProblems(script, [
    { from: at("stray"), message: "a", severity: "warning" },
    { from: at("local x"), message: "b", severity: "error" },
  ], new Map());
  assert.deepEqual([got.errors, got.warnings], [1, 1]);
  assert.equal(got.problems[0].message, "b");
  assert.equal(got.problems[0].function, "Second");
  assert.equal("function" in got.problems[1], false);
});

test("long lists are cut, the counts aren't", () => {
  const many = Array.from({ length: 50 }, () => ({ from: 0, message: "x", severity: "error" }));
  const got = describeProblems(script, many, new Map());
  assert.equal(got.errors, 50);
  assert.equal(got.problems.length, 30);
});

test("each offset is on its line, and in the function around it", () => {
  const offsets = [
    0, // line 1, outside
    at("endglobals") - 1, // the line break ending line 1 is on line 1
    at("endglobals"),
    at("function First"), // a function's own line is in it
    at("call Oops") + 4,
    at("endfunction"), // so is its endfunction
    script.indexOf("\n\n") + 1, // the empty line after it isn't
    at("stray"),
    at("function Second") - 1,
    at("local x"),
    script.length - 1, // the last endfunction
    script.length,
    script.length + 5, // past the end: the last line
  ];
  const got = describeProblems(script, offsets.map((from, i) => ({ from, message: String(i), severity: "error" })), new Map());
  assert.deepEqual(got.problems.map((p) => [p.line, p.function ?? null, p.code]), [
    [1, null, "globals"],
    [1, null, "globals"],
    [2, null, "endglobals"],
    [3, "First", "function First takes nothing returns nothing"],
    [4, "First", "call Oops()"],
    [5, "First", "endfunction"],
    [6, null, ""],
    [7, null, "stray"],
    [7, null, "stray"],
    [9, "Second", "local x y"],
    [10, "Second", "endfunction"],
    [10, "Second", "endfunction"],
    [10, "Second", "endfunction"],
  ]);
});

test("a big script with many problems takes work in proportion to its size, not lines times problems", () => {
  const fns = 2000, perFn = 20;
  const body = Array.from({ length: perFn }, (_, i) => `    call Foo(${i})`);
  const text = Array.from({ length: fns }, (_, f) => [`function F${f} takes nothing returns nothing`, ...body, "endfunction"].join("\n")).join("\n");
  const lines = fns * (perFn + 2);
  // A problem on every call line: as many problems as the script has lines, about.
  const found: { from: number; message: string; severity: string }[] = [];
  for (let i = text.indexOf("call Foo"); i >= 0; i = text.indexOf("call Foo", i + 1)) found.push({ from: i, message: "x", severity: "error" });
  const work = { steps: 0 };
  const got = describeProblems(text, found, new Map([["F1999", "Last"]]), work);
  assert.equal(got.errors, fns * perFn);
  assert.deepEqual(got.problems[0], { severity: "error", message: "x", line: 2, code: "call Foo(0)", function: "F0" });
  assert.deepEqual(got.problems[29], { severity: "error", message: "x", line: 2 + 22 + 9, code: "call Foo(9)", function: "F1" });
  // One pass over the lines for their starts, one for the functions, a binary search per problem.
  assert.ok(work.steps > 0, "the work is counted");
  const bound = 2 * lines + found.length * (Math.ceil(Math.log2(lines)) + 1);
  assert.ok(work.steps <= bound, `${work.steps} steps, more than ${bound}`);
});

test("the function of a problem late in a long function is found from the lines before", () => {
  const text = [`function Long takes nothing returns nothing`, ...Array.from({ length: 5000 }, () => "    set x = 1"), "endfunction"].join("\n");
  const work = { steps: 0 };
  const got = describeProblems(text, Array.from({ length: 1000 }, () => ({ from: text.length - 20, message: "x", severity: "error" })), new Map(), work);
  assert.equal(got.problems[0].function, "Long");
  assert.equal(got.problems[0].line, 5001);
  assert.ok(work.steps > 0 && work.steps <= 2 * 5002 + 1000 * 14, `${work.steps} steps`);
});

const sym = (name: string, kind: JassSymbol["kind"]): JassSymbol => ({ name, kind, detail: `${kind} ${name}` });

test("names match in any case, the closest first, and locals and keywords stay out", () => {
  const all = [sym("LoadUnitHandle", "native"), sym("InitHashtable", "native"), sym("hashtable", "type"), sym("HashtableX", "function"), sym("x", "local"), sym("if", "keyword")];
  assert.deepEqual(findSymbols(all, "hashtable").map((s) => s.name), ["hashtable", "HashtableX", "InitHashtable"]);
  assert.deepEqual(findSymbols(all, "hashtable", "native").map((s) => s.name), ["InitHashtable"]);
  assert.deepEqual(findSymbols(all, "x", "local"), []);
  assert.deepEqual(findSymbols(all, "load")[0], { name: "LoadUnitHandle", kind: "native", signature: "native LoadUnitHandle" });
});
