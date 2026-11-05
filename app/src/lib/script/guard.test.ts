import assert from "node:assert/strict";
import { test } from "node:test";
import { lostFunctions, scriptHash } from "./guard";

test("code that isn't made from the triggers is noticed, in JASS and Lua", () => {
  const generated = "function main takes nothing returns nothing\nendfunction\n";
  assert.deepEqual(lostFunctions("function Helper takes nothing returns nothing\nendfunction\nfunction main takes nothing returns nothing\nendfunction\n", generated), ["Helper"]);
  assert.deepEqual(lostFunctions("function main()\nend\nlocal function hidden()\nend\nfunction Reader.prototype.read(self)\nend\n", "function main()\nend\n"), ["hidden", "Reader.prototype.read"]);
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

test("a script's hash follows its text", () => {
  assert.equal(scriptHash("abc"), scriptHash("abc"));
  assert.notEqual(scriptHash("abc"), scriptHash("abd"));
  assert.match(scriptHash(""), /^[0-9a-f]{8}$/);
});
