import assert from "node:assert/strict";
import { test } from "node:test";
import type { W3Api } from "../../extensions/api";
import { englishWords, loadKind } from "./metadata";

test("the object data asks for its game files at once, and merges them in order whichever lands first", async () => {
  // A stand-in game: the base layer's profile file and a locale's, which wins; each read waits until let go.
  const files: Record<string, string> = {
    "War3.w3mod:Units/HumanUpgradeFunc.txt": "[Rhme]\nName=Base name\nArt=base.blp",
    "War3.w3mod:_Locales/deDE.w3mod:Units/HumanUpgradeStrings.txt": "[Rhme]\nName=Locale name",
    "War3.w3mod:Units/CampaignUpgradeFunc.txt": "[Rhar]\nName=Plating",
  };
  const pending: { path: string; go: () => void }[] = [];
  const w3 = {
    settings: { get: () => undefined },
    game: {
      list: async () => [...Object.keys(files), "War3.w3mod:Units/elsewhere/Not.txt", "War3.w3mod:UI/Other.txt"],
      readText: (path: string) => new Promise<string>((resolve) => { pending.push({ path, go: () => resolve(files[path] ?? "") }); }),
    },
  } as unknown as W3Api;
  const loading = loadKind(w3, "w3q");
  await new Promise((r) => setTimeout(r, 10));
  const asked = pending.map((p) => p.path);
  // Strings, edit data, the three profile files, the kind's table and its metadata: none waited for another.
  for (const path of [...Object.keys(files), "UI\\WorldEditStrings.txt", "UI/WorldEditData.txt", "Units\\UpgradeData.slk", "Units\\UpgradeMetaData.slk"]) {
    assert.ok(asked.includes(path), `${path} is asked for before any read landed (asked: ${asked.join(", ")})`);
  }
  // The locale's file lands first; the base's after it must not win.
  for (const p of [...pending].reverse()) p.go();
  const kind = await loading;
  assert.equal(kind.names.get("Rhme"), "Locale name");
  assert.equal(kind.names.get("Rhar"), "Plating");
});

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
