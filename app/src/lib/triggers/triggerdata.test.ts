import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTriggerData } from "./triggerdata";

// The game's UI\WorldEditStrings.txt names the variable types attacktype and weapontype through a second
// entry (WESTRING_TRIGTYPE_attacktype=WESTRING_COD_TYPE_ATTACKTYPE): the Trigger Editor showed the key.
test("a type's display string that names another string is followed to its text", () => {
  const strings = new Map([
    ["WESTRING_TRIGTYPE_ATTACKTYPE", "WESTRING_COD_TYPE_ATTACKTYPE"],
    ["WESTRING_TRIGTYPE_WEAPONTYPE", "WESTRING_COD_TYPE_COMBATSOUND"],
    ["WESTRING_COD_TYPE_ATTACKTYPE", "Attack Type"],
    ["WESTRING_COD_TYPE_COMBATSOUND", "Combat Sound"],
    ["WESTRING_TRIGTYPE_INTEGER", "Integer"],
    // A loop in the file ends after a few steps.
    ["WESTRING_LOOP_A", "WESTRING_LOOP_B"],
    ["WESTRING_LOOP_B", "WESTRING_LOOP_A"],
  ]);
  const data = parseTriggerData(
    [
      "[TriggerTypes]",
      "attacktype=1,1,1,WESTRING_TRIGTYPE_attacktype",
      "weapontype=1,1,1,WESTRING_TRIGTYPE_weapontype",
      "integer=0,1,1,WESTRING_TRIGTYPE_integer",
      "looping=0,1,1,WESTRING_LOOP_A",
      "unknown=0,1,1,WESTRING_NOT_THERE",
    ].join("\n"),
    strings,
  );
  assert.equal(data.types.get("attacktype")?.name, "Attack Type");
  assert.equal(data.types.get("weapontype")?.name, "Combat Sound");
  assert.equal(data.types.get("integer")?.name, "Integer");
  assert.match(data.types.get("looping")?.name ?? "", /^WESTRING_LOOP_/);
  assert.equal(data.types.get("unknown")?.name, "WESTRING_NOT_THERE");
});
