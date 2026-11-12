import assert from "node:assert/strict";
import { test } from "node:test";
import { isSkinFileOf, SkinIds } from "./skinids";

test("a type's skin section: its own spelling, else another case among its kind's", () => {
  const abilities = new SkinIds("w3a", [["AChV", "ability"], ["AChv", "ability"], ["AIsy", "ability"], ["Bnss", "buff"], ["Xnul", undefined]]);
  assert.equal(abilities.section("AChv"), "AChv", "both spellings are abilities: each its own");
  assert.equal(abilities.section("AChV"), "AChV");
  assert.equal(abilities.section("Aisy"), "AIsy");
  assert.equal(abilities.section("BNss"), undefined, "a buff's section isn't an ability's");
  assert.equal(abilities.section("XNUL"), "Xnul", "a section without a skinType counts");
  assert.equal(abilities.section("Anone"), undefined);
  const buffs = new SkinIds("w3h", [["Bnss", "buff"], ["XEsn", "effect"], ["AIsy", "ability"]]);
  assert.equal(buffs.section("BNss"), "Bnss");
  assert.equal(buffs.section("Xesn"), "XEsn");
  assert.equal(buffs.section("Aisy"), undefined);
});

test("a kind's skin files, by any spelling of their path", () => {
  assert.ok(isSkinFileOf("w3d", "War3.w3mod:Doodads/DoodadSkins.txt"));
  assert.ok(isSkinFileOf("w3d", "Doodads\\DoodadSkins.txt"));
  assert.ok(!isSkinFileOf("w3d", "War3.w3mod:_Locales/enUS.w3mod:Doodads/DoodadSkinStrings.txt"));
  assert.ok(!isSkinFileOf("w3u", "War3.w3mod:Doodads/DoodadSkins.txt"));
  assert.ok(isSkinFileOf("w3h", "War3.w3mod:Units/AbilitySkin.txt") && isSkinFileOf("w3a", "war3.w3mod:units/abilityskin.txt"));
  assert.ok(!isSkinFileOf("w3x", "Units\\UnitSkin.txt"));
});
