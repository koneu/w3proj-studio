// A file of map/objects/ in Source Control: which object it holds, and its changes field by field.

import assert from "node:assert/strict";
import { test } from "node:test";
import { diffObjects, flatOfObjectFile, objectFileOf } from "./objdiff";

test("the object is told by its file's path, the upper-case mark left out", () => {
  assert.deepEqual(objectFileOf("map/objects/units/custom/h00A~1.json"), { ext: "w3u", noun: "unit", section: "custom", id: "h00A" });
  assert.deepEqual(objectFileOf("maps/One.w3x/map/objects/abilities/original/AHbz~c.json"), { ext: "w3a", noun: "ability", section: "original", id: "AHbz" });
  for (const other of ["map/objects/objects.json", "map/objects/units/custom/order.txt", "map/Objects/InventoryItems/x.json", "map/war3map.w3u.json"]) {
    assert.equal(objectFileOf(other), null, other);
  }
});

test("both halves' changes are compared, and a new file is an added object", () => {
  const file = (hp: number, name: string) => JSON.stringify({
    id: "h000", base: "hfoo", data: { mods: [{ field: "uhpm", type: "int", value: hp }] }, skin: { mods: [{ field: "unam", type: "string", value: name }] },
  });
  const changed = diffObjects(flatOfObjectFile("custom", file(500, "A")), flatOfObjectFile("custom", file(600, "B")));
  assert.deepEqual(changed.map((c) => [c.id, c.what, c.fields.map((f) => [f.field, f.before, f.after])]),
    [["h000", "changed", [["uhpm", 500, 600], ["unam", "A", "B"]]]]);
  const added = diffObjects(flatOfObjectFile("custom", ""), flatOfObjectFile("custom", file(1, "C")));
  assert.deepEqual(added.map((c) => [c.id, c.what]), [["h000", "added"]]);
});
