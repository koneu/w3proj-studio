import assert from "node:assert/strict";
import { test } from "node:test";
import { newWai } from "../../lib/ai/wai";
import { aiTypeText, removeGroup } from "./labels";

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

test("the player AI type number is decoded as the editor shows it", () => {
  assert.equal(aiTypeText(3), "User / Standard");
  assert.equal(aiTypeText(5), "User / Custom");
  assert.equal(aiTypeText(12), "Computer / Current");
  const want = ["Computer / Standard", "User / Standard", "Computer / Standard", "User / Standard", "Computer / Custom", "User / Custom", "Computer / Custom", "User / Custom",
    "Computer / Current", "User / Current", "Computer / Current", "User / Current", "Computer / Current", "User / Current", "Computer / Current", "User / Current", "Computer / Standard"];
  for (let v = 0; v <= 16; v++) assert.equal(aiTypeText(v), want[v], `value ${v}`);
  assert.notEqual(aiTypeText(4), aiTypeText(0), "control: the AI bits matter");
});
