import assert from "node:assert/strict";
import { test } from "node:test";
import { lostFunctions, scriptDecision, scriptHash } from "./guard";

test("code that isn't made from the triggers is noticed, in JASS and Lua", () => {
  const generated = "function main takes nothing returns nothing\nendfunction\n";
  assert.deepEqual(lostFunctions("function Helper takes nothing returns nothing\nendfunction\nfunction main takes nothing returns nothing\nendfunction\n", generated), ["Helper"]);
  assert.deepEqual(lostFunctions("function main()\nend\nlocal function hidden()\nend\nfunction Reader.prototype.read(self)\nend\n", "function main()\nend\n"), ["hidden", "Reader.prototype.read"]);
});

test("Lua functions kept in variables count too", () => {
  assert.deepEqual(lostFunctions("function main()\nend\nHelper = function()\nend\nlocal api = function(x)\nend\nM.run = function()\nend\n", "function main()\nend\n"), ["Helper", "api", "M.run"]);
});

test("what the generator writes may come and go", () => {
  const current = ["main", "config", "InitTrig_Foo", "Trig_Foo_Actions", "CreateRegions", "CreateUnitsForPlayer3", "CreateNeutralPassive",
    "Unit000012_DropItems", "ItemTable000001_DropItems", "InitUpgrades_Player2", "InitTechTree"].map((f) => `function ${f}()\nend`).join("\n");
  assert.deepEqual(lostFunctions(current, "function main()\nend"), []);
});

test("the same names in both, and nested functions, aren't lost", () => {
  assert.deepEqual(lostFunctions("function Helper()\nend", "function Helper()\n  print(1)\nend"), []);
  assert.deepEqual(lostFunctions("function main()\n  function inner()\n  end\nend", "function main()\nend"), []);
});

test("a script changed inside the functions the generator writes is kept, not replaced", () => {
  const made = "function main takes nothing returns nothing\n    call InitBlizzard()\nendfunction\n";
  const mine = made.replace("call InitBlizzard()", "call InitBlizzard()\n    call BJDebugMsg(\"mine\")");
  // The one this app wrote last (stamp matches): replaced. Changed since (stamp is the old one's): kept, nothing lost
  // by name, since main is the generator's.
  const old = "function main takes nothing returns nothing\nendfunction\n";
  assert.deepEqual(scriptDecision(old, made, scriptHash(old)), { action: "write" });
  assert.deepEqual(scriptDecision(mine, made, scriptHash(old)), { action: "keep", lost: [] });
  // No stamp yet (a fresh import): kept when it differs, the same needs nothing.
  assert.deepEqual(scriptDecision(mine, made, null), { action: "keep", lost: [] });
  assert.deepEqual(scriptDecision(made, made, null), { action: "same" });
  // A stamp with its line end, as written, still counts.
  assert.deepEqual(scriptDecision(old, made, `${scriptHash(old)}\n`), { action: "write" });
});

test("no script is written, one that can't be read is kept, force replaces, functions of its own are named", () => {
  const made = "function main takes nothing returns nothing\nendfunction\n";
  assert.deepEqual(scriptDecision(null, made, null), { action: "write" });
  assert.deepEqual(scriptDecision(undefined, made, null), { action: "keep", lost: [] });
  assert.deepEqual(scriptDecision(undefined, made, scriptHash("")), { action: "keep", lost: [] });
  assert.deepEqual(scriptDecision("x", made, null, true), { action: "write" });
  assert.deepEqual(scriptDecision(undefined, made, null, true), { action: "write" });
  const helper = `function Helper takes nothing returns nothing\nendfunction\n${made}`;
  assert.deepEqual(scriptDecision(helper, made, null), { action: "keep", lost: ["Helper"] });
});

test("a script's hash follows its text", () => {
  assert.equal(scriptHash("abc"), scriptHash("abc"));
  assert.notEqual(scriptHash("abc"), scriptHash("abd"));
  assert.match(scriptHash(""), /^[0-9a-f]{8}$/);
});
