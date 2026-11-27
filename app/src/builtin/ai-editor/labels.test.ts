import assert from "node:assert/strict";
import { test } from "node:test";
import { aiArgCount, aiTriggerData, newWai, parseWai, writeWai } from "../../lib/ai/wai";
import { parseTriggerData } from "../../lib/triggers/triggerdata";
import { quantityMode, quantityText, removeGroup, setQuantityMode } from "./labels";

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

test("an attack unit can be set to all but N, stored as quantity all and maximum N", () => {
  const u = { quantity: 3, max: 5 };
  assert.equal(quantityMode(u.quantity, u.max), "range");
  setQuantityMode(u, "allBut");
  assert.deepEqual(u, { quantity: 0xffffffff, max: 1 });
  assert.equal(quantityMode(u.quantity, u.max), "allBut");
  assert.equal(quantityText(u.quantity, u.max), "All but 1");
  u.max = 7;
  setQuantityMode(u, "allBut");
  assert.equal(u.max, 7, "choosing it again keeps the number");
  setQuantityMode(u, "all");
  assert.deepEqual(u, { quantity: 0xffffffff, max: 0xffffffff });
  assert.equal(quantityMode(u.quantity, u.max), "all");
  setQuantityMode(u, "fixed");
  assert.deepEqual(u, { quantity: 1, max: 1 });
});

test("all but N saves as the game's files store it and exports the same script", () => {
  const ai = newWai();
  const unit = { id: "ugho", quantity: 5, max: 5, condIndex: -1, cond: { name: "", call: null } };
  setQuantityMode(unit, "allBut");
  unit.max = 7;
  ai.groups = [{ index: 0, name: "G", units: [unit] }];
  const bytes = writeWai(ai);
  const at = bytes.findIndex((_, i) => String.fromCharCode(...bytes.subarray(i, i + 4)) === "ugho");
  assert.equal(Buffer.from(bytes.subarray(at + 4, at + 12)).toString("hex"), "ffffffff07000000");
  const g = parseWai(bytes, aiArgCount(aiTriggerData(parseTriggerData(""), "", parseTriggerData))).groups[0].units[0];
  assert.deepEqual([g.quantity, g.max], [0xffffffff, 7]);
});
