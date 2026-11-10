import assert from "node:assert/strict";
import { test } from "node:test";
import { heroConstants, typeFacts, type FactsData } from "./typefacts";

// Rows as the game's tables have them (Units\UnitBalance.slk, UnitAbilities.slk, AbilityData.slk), with a few of
// a map's own objects: a footman made a hero-less pack animal, a custom waygate ability, a custom inventory.
const UNITS: Record<string, Record<string, string>> = {
  Hpal: { uhpm: "100", umpm: "0", ustr: "22", uagi: "13", uint: "17", ustp: "2.7", uagp: "1.5", uinp: "1.8", uabi: "AInv", uhab: "AHhb,AHds,AHre,AHad", ubdg: "0", uaen: "1" },
  hfoo: { uhpm: "420", umpm: "", uabi: "Adef,Aihn", ubdg: "0", uaen: "1", uacq: "500", ulev: "2" },
  nshe: { uhpm: "15", ulev: "0" },
  hpea: { uhpm: "220", uabi: "Ahar,Arep,Ahrl,Amil", ubdg: "0", uaen: "3" },
  ngol: { uhpm: "150000", uabi: "Agld,Avul", ubdg: "1", uaen: "0" },
  h000: { uhpm: "500", uabi: "A001", ubdg: "0" },
  n000: { uhpm: "150000", uabi: "A002,Avul", ubdg: "1" },
  sloc: {},
};
const ABILITIES: Record<string, { code: string; fields: Record<string, string> }> = {
  AInv: { code: "AInv", fields: { inv1: "6" } }, Aihn: { code: "AInv", fields: { inv1: "2" } },
  A001: { code: "AInv", fields: { inv1: "4" } }, A002: { code: "Awrp", fields: {} },
  Avul: { code: "Avul", fields: {} },
  AHhb: { code: "AHhb", fields: { alev: "3", arlv: "1", alsk: "0" } }, AHds: { code: "AHds", fields: { alev: "3", arlv: "1" } },
  AHre: { code: "AHre", fields: { alev: "1", arlv: "6" } }, AHad: { code: "AHad", fields: { alev: "3", arlv: "1" } },
};
const data: FactsData = {
  unit: (id, field) => UNITS[id]?.[field] ?? "",
  destructable: (id, field) => (id === "LTlt" && field === "bhps" ? "50" : ""),
  ability: (id, field) => ABILITIES[id]?.fields[field] ?? "",
  abilityCode: (id) => ABILITIES[id]?.code ?? id,
  goldMines: new Set(["ngol", "ugol", "egol"]),
  waygates: new Set(["nwgt"]),
  toggleable: new Set(["Adef", "Ahea", "Ainf"]),
  maxHeroLevel: 10, levelSkip: 2, hpPerStr: 25, manaPerInt: 15,
};

test("a hero: its attributes, skills and six slots", () => {
  const f = typeFacts("Hpal", "w3u", data);
  assert.equal(f.hero, true);
  assert.equal(f.slots, 6);
  assert.deepEqual(f.attributes, { str: 22, agi: 13, int: 17, strPlus: 2.7, agiPlus: 1.5, intPlus: 1.8, hpPerStr: 25, manaPerInt: 15 });
  // The ultimate last, as the World Editor lists them (the table has Resurrection third).
  assert.deepEqual(f.skills.map((s) => [s.id, s.levels, s.req]), [["AHhb", 3, 1], ["AHds", 3, 1], ["AHad", 3, 1], ["AHre", 1, 6]]);
  assert.equal(f.maxLevel, 10);
});

test("an inventory ability, by its code, gives the World Editor's six slots: a footman's, a custom one's; a peasant has none", () => {
  assert.equal(typeFacts("hfoo", "w3u", data).slots, 6);
  assert.equal(typeFacts("h000", "w3u", data).slots, 6);
  assert.equal(typeFacts("hpea", "w3u", data).slots, 0);
  assert.equal(typeFacts("hfoo", "w3u", data).hero, false);
  assert.equal(typeFacts("hfoo", "w3u", data).maxHp, 420);
});

test("the abilities a type can be placed with switched on: those the script has orders for, in the type's order", () => {
  // As the World Editor's Abilities tab: a footman's Defend, nothing of a peasant's; a hero's inventory has no box.
  assert.deepEqual(typeFacts("hfoo", "w3u", data).toggles, ["Adef"]);
  assert.deepEqual(typeFacts("hpea", "w3u", data).toggles, []);
  assert.deepEqual(typeFacts("Hpal", "w3u", data).toggles, []);
  assert.deepEqual(typeFacts("sloc", "w3u", data).toggles, []);
});

test("gold mines and waygates by the map's lists or by their abilities; invulnerable and attacking by the data", () => {
  assert.equal(typeFacts("ngol", "w3u", data).goldMine, true);
  assert.equal(typeFacts("ngol", "w3u", data).building, true);
  assert.equal(typeFacts("ngol", "w3u", data).invulnerable, true);
  assert.equal(typeFacts("hfoo", "w3u", data).goldMine, false);
  assert.equal(typeFacts("hfoo", "w3u", data).invulnerable, false);
  assert.equal(typeFacts("n000", "w3u", data).waygate, true, "a custom unit with a waygate ability");
  assert.equal(typeFacts("nwgt", "w3u", data).waygate, true);
  assert.deepEqual(["hfoo", "ngol", "Hpal"].map((id) => typeFacts(id, "w3u", data).attacks), [true, false, true]);
  assert.equal(typeFacts("hfoo", "w3u", data).acquireRange, 500);
  assert.equal(typeFacts("LTlt", "w3b", data).maxHp, 50, "a destructable's hit points");
});

test("a unit type's level, a camp's level adds up: 0 is a level, nothing written is unknown", () => {
  assert.equal(typeFacts("hfoo", "w3u", data).level, 2);
  assert.equal(typeFacts("nshe", "w3u", data).level, 0);
  assert.equal(typeFacts("hpea", "w3u", data).level, undefined);
  assert.equal(typeFacts("LTlt", "w3b", data).level, undefined);
});

test("start locations, items, destructables and doodads aren't units", () => {
  for (const [id, kind] of [["sloc", "w3u"], ["ratf", "w3t"], ["LTlt", "w3b"], ["CPct", "w3d"]]) {
    const f = typeFacts(id, kind, data);
    assert.equal(f.kind, kind);
    assert.equal(f.hero || f.goldMine || f.waygate || f.slots > 0, false, id);
  }
});

test("the map's gameplay constants win over the game's", () => {
  const game = "[Misc]\r\nMaxHeroLevel=10\r\nHeroAbilityLevelSkip=2\r\nStrHitPointBonus=25\r\nIntManaBonus=15\r\n";
  const base = { maxHeroLevel: 10, levelSkip: 2, hpPerStr: 25, manaPerInt: 15 };
  assert.deepEqual(heroConstants(game, null), base);
  assert.deepEqual(heroConstants(game, "[Misc]\nMaxHeroLevel=25\nStrHitPointBonus=30.5\n"), { ...base, maxHeroLevel: 25, hpPerStr: 30.5 });
  assert.deepEqual(heroConstants("", "[Misc]\nHeroAbilityLevelSkip=1\n"), { ...base, levelSkip: 1 });
  assert.deepEqual(heroConstants("[Misc]\nMaxHeroLevel=junk\n", null), base, "what can't be read is the game's default");
});
