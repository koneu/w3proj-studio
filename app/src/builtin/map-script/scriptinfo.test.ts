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

const sym = (name: string, kind: JassSymbol["kind"]): JassSymbol => ({ name, kind, detail: `${kind} ${name}` });

test("names match in any case, the closest first, and locals and keywords stay out", () => {
  const all = [sym("LoadUnitHandle", "native"), sym("InitHashtable", "native"), sym("hashtable", "type"), sym("HashtableX", "function"), sym("x", "local"), sym("if", "keyword")];
  assert.deepEqual(findSymbols(all, "hashtable").map((s) => s.name), ["hashtable", "HashtableX", "InitHashtable"]);
  assert.deepEqual(findSymbols(all, "hashtable", "native").map((s) => s.name), ["InitHashtable"]);
  assert.deepEqual(findSymbols(all, "x", "local"), []);
  assert.deepEqual(findSymbols(all, "load")[0], { name: "LoadUnitHandle", kind: "native", signature: "native LoadUnitHandle" });
});
