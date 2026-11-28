import assert from "node:assert/strict";
import { test } from "node:test";
import { heroSkillsOf } from "./heroskills";

const game = new Map([["Hpal", ["AHhb", "AHds", "AHre", "AHad"]], ["Hamg", ["AHbz", "AHab", "AHwe", "AHmt"]]]);

test("a hero's skills: its own list where the map sets one, else its base unit's", () => {
  assert.deepEqual(heroSkillsOf("Hpal", game, null), game.get("Hpal"));
  assert.deepEqual(heroSkillsOf("H000", game, null), [], "a custom hero without the map's data");
  const units = {
    custom: [
      { id: "H000", base: "Hpal", mods: [{ field: "unam", value: "Knight" }] },
      { id: "H001", base: "Hamg", mods: [{ field: "uhab", value: "A000,AHbz,_" }] },
      { id: "H002", base: "Hpal", sets: [{ mods: [{ field: "uhab", value: "" }] }] },
    ],
    original: [{ base: "Hamg", mods: [{ field: "uhab", value: "AHbz, A001" }] }],
  };
  assert.deepEqual(heroSkillsOf("H000", game, units), game.get("Hpal"), "a custom hero learns its base's skills");
  assert.deepEqual(heroSkillsOf("H001", game, units), ["A000", "AHbz"], "its own list, custom skills too");
  assert.deepEqual(heroSkillsOf("H002", game, units), [], "a list the map emptied");
  assert.deepEqual(heroSkillsOf("Hamg", game, units), ["AHbz", "A001"], "a game hero the map changed");
  assert.deepEqual(heroSkillsOf("Hpal", game, units), game.get("Hpal"));
});
