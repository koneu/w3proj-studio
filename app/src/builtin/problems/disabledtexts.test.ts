// A custom-text trigger that is disabled isn't in the map script (wowr4.6's "Knockback Documentation" is a readme in
// one: 164 JASS errors in the Problems view), so its file isn't checked. A damaged model's parse error says it is cut off.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { W3Api } from "../../extensions/api";
import { cutOff, triggerTexts } from "./checks";

test("triggerTexts leaves out the text of a disabled trigger", async () => {
  const w3 = { workspace: { readText: async (p: string) => `text of ${p}` } } as unknown as W3Api;
  const trigger = (name: string, enabled: boolean) => ({ type: 8, name, enabled, ecas: [] });
  const layout = {
    headerFile: null,
    file: { items: [trigger("On", true), trigger("Off", false), { type: 4, name: "folder" }] },
    files: ["map/triggers/On.j", "map/triggers/Off.j", null],
  };
  const got = await triggerTexts(w3, layout as never);
  assert.deepEqual(got.map((t) => t.path), ["map/triggers/On.j"]);
});

test("cutOff names a file that ends inside a chunk and leaves other messages alone", () => {
  assert.match(cutOff("BONE: 22620 bytes needed, 21349 left at 15515"), /cut off inside BONE, 1271 bytes short/);
  assert.equal(cutOff("bad magic"), "bad magic");
});
