import assert from "node:assert/strict";
import { test } from "node:test";
import { englishWords } from "./metadata";

test("a unit's English names come from its tables, on any install", () => {
  const words = englishWords([{ unitID: "hfoo", "comment(s)": "Footman" }, { unitUIID: "hfoo", name: "footman", file: "units\human\Footman\Footman" }]);
  assert.equal(words, "footman", "the same word twice is one word");
});

test("names run together split at capitals", () => {
  const words = englishWords([{ "comment(s)": "HeroPaladin" }, { name: "paladin" }]);
  assert.ok(words.includes("hero paladin") && words.includes("paladin"));
});

test("every kind's column counts", () => {
  assert.equal(englishWords([{ alias: "AHbz", comments: "Arch Mage - Blizzard" }]), "arch mage - blizzard");
  assert.equal(englishWords([{ itemID: "ratf", comment: "Claws of Attack +15" }]), "claws of attack +15");
});

test("strings to look up aren't words, and neither is anything else", () => {
  assert.equal(englishWords([{ comment: "Tree Wall", Name: "WESTRING_DEST_ASHENVALE_TREE_WALL", file: "x.mdl" }]), "tree wall");
  assert.equal(englishWords([{ goldcost: "135", tip: "Trainiert Fußsoldaten" }]), "");
  assert.equal(englishWords([]), "");
});
