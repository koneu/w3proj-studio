import assert from "node:assert/strict";
import { test } from "node:test";
import { findGameFiles } from "./filesearch";

const files = [
  "War3.w3mod:Abilities/Spells/Human/FlameStrike/FlameStrike1.mdx",
  "War3.w3mod:_HD.w3mod:Abilities/Spells/Human/FlameStrike/FlameStrike1.mdx",
  "War3.w3mod:Abilities/Weapons/FireBallMissile/FireBallMissile.mdx",
  "War3.w3mod:ReplaceableTextures/CommandButtons/BTNFire.blp",
  "War3.w3mod:_Locales/deDE.w3mod:UI/TriggerStrings.txt",
];

test("files go by the path maps write, once each, and models as .mdl", () => {
  assert.deepEqual(findGameFiles(files, "flamestrike"), [{ path: "Abilities\\Spells\\Human\\FlameStrike\\FlameStrike1.mdl" }]);
});

test("every word must match, in any order and case", () => {
  assert.deepEqual(findGameFiles(files, "MISSILE fire"), [{ path: "Abilities\\Weapons\\FireBallMissile\\FireBallMissile.mdl" }]);
  assert.deepEqual(findGameFiles(files, "fire nothing"), []);
});

test("images stored as .dds go by the .blp maps name them", () => {
  const stored = ["War3.w3mod:_HD.w3mod:ReplaceableTextures/CommandButtons/BTNWallOfFire.dds", "War3.w3mod:ReplaceableTextures/CommandButtons/BTNWallOfFire.blp"];
  assert.deepEqual(findGameFiles(stored, "wallof", "blp"), [{ path: "ReplaceableTextures\\CommandButtons\\BTNWallOfFire.blp" }]);
  assert.equal(findGameFiles(stored, "wallof", "dds").length, 1);
});

test("a file in one graphics pack alone says so, and comes after those everyone has", () => {
  const got = findGameFiles(["War3.w3mod:_DE.w3mod:Doodads/Firewall/Aaa.mdx", "War3.w3mod:Doodads/Firewall/Zzz.mdx", "War3.w3mod:_HD.w3mod:Doodads/Firewall/Both.mdx", "War3.w3mod:_DE.w3mod:Doodads/Firewall/Both.mdx"], "firewall");
  assert.deepEqual(got, [
    { path: "Doodads\\Firewall\\Zzz.mdl" },
    { path: "Doodads\\Firewall\\Aaa.mdl", only: ["DE"] },
    { path: "Doodads\\Firewall\\Both.mdl", only: ["DE", "HD"] },
  ]);
});

test("an extension narrows it down, with or without its dot", () => {
  assert.deepEqual(findGameFiles(files, "fire", "blp"), [{ path: "ReplaceableTextures\\CommandButtons\\BTNFire.blp" }]);
  assert.deepEqual(findGameFiles(files, "fire", ".mdx").length, 1);
});
