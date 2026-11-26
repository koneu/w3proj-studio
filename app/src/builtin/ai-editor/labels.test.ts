import assert from "node:assert/strict";
import { test } from "node:test";
import { newWai } from "../../lib/ai/wai";
import { removeGroup } from "./labels";

test("removing a group moves the minimum forces down, but not \"First Hero Only\"", () => {
  const ai = newWai();
  ai.groups.push({ index: 1, name: "Raid", units: [] }, { index: 2, name: "Big", units: [] });
  ai.minForces = 2;
  removeGroup(ai, 0);
  assert.equal(ai.minForces, 1, "control: a group's index moves down");
  ai.minForces = 0x41494148;
  removeGroup(ai, 0);
  assert.equal(ai.minForces, 0x41494148);
});
