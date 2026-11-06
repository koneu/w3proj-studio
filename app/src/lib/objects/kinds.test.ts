// loadKind on a made-up game: what the Object Editor gets from the metadata tables.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { W3Api } from "../../extensions/api";
import { loadKind, nextFreeId, valueTypeOf } from "./metadata";

/** SLK text of a table: the first row is the header. */
function slk(rows: string[][]) {
  const out = ["ID;PWXL;N;E"];
  rows.forEach((row, y) => row.forEach((v, x) => { if (v !== "") out.push(`C;X${x + 1};Y${y + 1};K${/^-?\d+(\.\d+)?$/.test(v) ? v : `"${v}"`}`); }));
  return [...out, "E"].join("\r\n");
}

const META = ["ID", "field", "slk", "index", "repeat", "data", "category", "displayName", "sort", "type", "minVal", "maxVal", "useUnit", "useHero", "useBuilding", "useItem", "useSpecific", "notSpecific"];
const metaRow = (row: Partial<Record<(typeof META)[number], string>>) => META.map((c) => row[c] ?? "");

const FILES: Record<string, string> = {
  "UI\\WorldEditStrings.txt": [
    "[WorldEditStrings]",
    "WESTRING_OE_CAT_STATS=Stats",
    "WESTRING_UEVAL_GOLD=Gold Cost",
    "WESTRING_UEVAL_ALIAS=WESTRING_UEVAL_GOLD",
    "WESTRING_RACE_X=Air,&Air",
    "WESTRING_DOOD_CAT=Trees",
    "WESTRING_DOOD_ONE=A Tree",
  ].join("\n"),
  "UI\\WorldEditGameStrings.txt": "",
  "UI/WorldEditData.txt": "[DoodadCategories]\nt=WESTRING_DOOD_CAT,icon.blp\n",
  "Units\\UnitMetaData.slk": slk([META,
    metaRow({ ID: "ugol", field: "goldcost", slk: "UnitBalance", category: "stats", displayName: "WESTRING_UEVAL_ALIAS", sort: "2", type: "int", minVal: "0", maxVal: "100", useUnit: "1", useHero: "1", useBuilding: "1" }),
    metaRow({ ID: "uhpm", field: "HP", slk: "UnitBalance", category: "stats", displayName: "WESTRING_NOT_THERE", sort: "1", type: "unreal", useUnit: "1" }),
    metaRow({ ID: "uhab", field: "heroAbilList", slk: "UnitAbilities", category: "stats", sort: "3", type: "abilityList", useHero: "1" }),
    metaRow({ ID: "ubdg", field: "isbldg", slk: "UnitBalance", sort: "4", type: "bool", useBuilding: "1" }),
    metaRow({ ID: "unam", field: "Name", slk: "Profile", sort: "5", type: "string", useUnit: "1" }),
    metaRow({ ID: "uart", field: "Art", slk: "Profile", sort: "6", type: "string", useUnit: "1" }),
    metaRow({ ID: "ubut", field: "Buttonpos", slk: "Profile", index: "1", sort: "7", type: "int", useUnit: "1" }),
    metaRow({ ID: "iuse", field: "uses", slk: "ItemData", sort: "8", type: "int", useItem: "1" }),
    metaRow({ ID: "uoff", field: "off", slk: "UnitBalance", sort: "9", type: "int" }),
  ]),
  "Units\\UnitData.slk": slk([["unitID", "race", "comment(s)"], ["hfoo", "human", "Footman"], ["Hpal", "human", "HeroPaladin"], ["htow", "human", ""], ["nspi", "", ""]]),
  "Units\\UnitBalance.slk": slk([["unitBalanceID", "goldcost", "HP", "isbldg"], ["hfoo", "135", "420", "0"], ["Hpal", "425", "-", "0"], ["htow", "385", "1500", "1"]]),
  "Units\\UnitUI.slk": slk([["unitUIID", "campaign", "name"], ["hfoo", "0", "footman"], ["nspi", "1", ""]]),
  "Units\\UnitWeapons.slk": slk([["unitWeaponID"]]),
  "Units\\UnitAbilities.slk": slk([["unitAbilID", "heroAbilList"], ["Hpal", "AHhb,AHds"]]),
  "Units\\ItemData.slk": slk([["itemID", "class", "Level", "uses"], ["ratf", "Permanent", "3", "_"]]),
  "Units\\AbilityMetaData.slk": slk([META,
    metaRow({ ID: "Hbz1", field: "DataA", slk: "AbilityData", repeat: "1", data: "0", sort: "1", type: "int" }),
    metaRow({ ID: "Hbz2", field: "Data", slk: "AbilityData", repeat: "1", data: "2", sort: "2", type: "real", useSpecific: "AHbz,AHab" }),
    metaRow({ ID: "aoth", field: "cool", slk: "AbilityData", sort: "3", type: "int", notSpecific: "AHbz" }),
  ]),
  "Units\\AbilityData.slk": slk([["alias", "levels", "race", "hero", "item", "cool", "DataA1", "DataB1", "DataB2"], ["AHbz", "3", "human", "1", "0", "9", "1", "2", "4"], ["Aspb", "", "orc", "0", "1", "", "", "", ""]]),
  "Units\\DoodadThing.txt": "",
  "Doodads\\DoodadMetaData.slk": slk([META, metaRow({ ID: "dcat", field: "category", slk: "Doodads", sort: "1", type: "string" })]),
  "Doodads\\Doodads.slk": slk([["doodID", "category", "Name", "comment"], ["LTlt", "t", "WESTRING_DOOD_ONE", ""], ["LMis", "", "WESTRING_GONE", "Plain name"]]),
  "Units\\UpgradeMetaData.slk": slk([META]),
  "Units\\UpgradeData.slk": slk([["upgradeid", "maxlevel", "race"], ["Rhme", "3", "human"], ["Rxxx", "", ""]]),
};

const PROFILE: Record<string, string> = {
  "War3.w3mod:Units/HumanUnitFunc.txt": '[hfoo]\nArt=base.blp\nArt:hd=hd.blp\nButtonpos=2,3\nName="old"\n[Rhme]\nBufftip=Iron Forged Swords\n',
  "War3.w3mod:Units/HumanUnitStrings.txt": "[Hpal]\nName=Paladin\n[hkni]\nName=\"Knight, Sir\"\n",
  "War3.w3mod:_Locales/dede.w3mod:Units/HumanUnitStrings.txt": "[hfoo]\nName=Fusssoldat\n",
  "War3.w3mod:Units/SubFolder/Other.txt": "[hfoo]\nName=not this one\n",
};

function fakeW3(graphicsMode = "hd", missing: string[] = []) {
  const reads: string[] = [];
  const w3 = {
    settings: { get: (key: string) => (key === "game.graphicsMode" ? graphicsMode : undefined) },
    game: {
      list: async () => Object.keys(PROFILE),
      readText: async (path: string) => {
        reads.push(path);
        const text = FILES[path] ?? PROFILE[path];
        if (text === undefined || missing.includes(path)) throw new Error(`no ${path}`);
        return text;
      },
    },
  };
  return { w3: w3 as unknown as W3Api, reads };
}

// The module keeps what it loaded, as the app wants it to: one game for all of these.
const game = fakeW3();
const unit = () => loadKind(game.w3, "w3u");
const named = async (id: string) => (await unit()).fieldById.get(id)!;

test("a kind is read once, however often it's asked for", async () => {
  await unit();
  const after = game.reads.length;
  await unit();
  assert.equal(game.reads.length, after);
});

test("fields keep the metadata's order and facts", async () => {
  const k = await unit();
  assert.deepEqual(k.fields.map((f) => f.id), ["uhpm", "ugol", "uhab", "ubdg", "unam", "uart", "ubut"]);
  const gold = await named("ugol");
  assert.equal(gold.category, "Stats");
  assert.equal(gold.valueType, "int");
  assert.deepEqual(gold.range, { min: 0, max: 100 });
  assert.equal(gold.slk, "UnitBalance");
});

test("a field's label comes from the game's strings, or from its column", async () => {
  assert.equal((await named("ugol")).label, "Gold Cost", "through a string naming another string");
  assert.equal((await named("uhpm")).label, "HP", "a WESTRING the game doesn't ship");
  assert.equal((await named("uhab")).label, "heroAbilList", "no display name at all: the column as it is");
});

test("items only take item fields, units only unit fields", async () => {
  const items = await loadKind(game.w3, "w3t");
  assert.deepEqual(items.fields.map((f) => f.id), ["iuse"]);
  assert.ok(!(await unit()).fieldById.has("iuse"));
  assert.ok(!(await unit()).fieldById.has("uoff"), "no use marked at all");
});

test("what a field applies to depends on the object", async () => {
  const k = await unit();
  const ids = (base: string) => k.fieldsFor(base).map((f) => f.id);
  assert.ok(ids("hfoo").includes("uhpm") && !ids("hfoo").includes("uhab"), "a unit");
  assert.ok(ids("Hpal").includes("uhab") && !ids("Hpal").includes("uhpm"), "a hero: capital first letter");
  assert.ok(ids("htow").includes("ubdg") && !ids("htow").includes("uhpm"), "a building");
  const abilities = await loadKind(game.w3, "w3a");
  const of = (base: string) => abilities.fieldsFor(base).map((f) => f.id);
  assert.deepEqual(of("AHbz"), ["Hbz1", "Hbz2"], "useSpecific in, notSpecific out");
  assert.deepEqual(of("Aspb"), ["Hbz1", "aoth"]);
});

test("base objects are the main table's, each with its name", async () => {
  const k = await unit();
  assert.deepEqual(k.baseIds, ["hfoo", "Hpal", "htow", "nspi"]);
  assert.equal(k.names.get("hfoo"), "Fusssoldat", "the locale's file comes last");
  assert.equal(k.names.get("Hpal"), "Paladin");
  assert.equal(k.names.get("hkni"), "Knight, Sir");
  assert.equal(k.names.get("Rhme"), "Iron Forged Swords", "a buff tip is a name too");
  assert.equal(k.names.get("nspi"), undefined);
});

test("doodads are named through their strings, or whatever else the table has", async () => {
  const k = await loadKind(game.w3, "w3d");
  assert.equal(k.names.get("LTlt"), "A Tree");
  assert.equal(k.names.get("LMis"), "Plain name", "the string is missing");
});

test("default values come from the table, level by level", async () => {
  const k = await unit();
  assert.equal(k.defaultValue("hfoo", await named("ugol"), 0), "135");
  assert.equal(k.defaultValue("Hpal", await named("uhpm"), 0), undefined, "- means none");
  assert.equal(k.defaultValue("nope", await named("ugol"), 0), undefined);
  const items = await loadKind(game.w3, "w3t");
  assert.equal(items.defaultValue("ratf", items.fieldById.get("iuse")!, 0), undefined, "_ means none");
  const abilities = await loadKind(game.w3, "w3a");
  const a = abilities.fieldById;
  assert.equal(abilities.defaultValue("AHbz", a.get("Hbz1")!, 1), "1", "a column naming its own letter: DataA + level");
  assert.equal(abilities.defaultValue("AHbz", a.get("Hbz2")!, 2), "4", "column Data + B + level");
});

test("profile values take the graphics mode, the list index, or the plain text", async () => {
  const k = await unit();
  assert.equal(k.defaultValue("hfoo", await named("uart"), 0), "hd.blp");
  assert.equal(k.defaultValue("hfoo", await named("ubut"), 0), "3", "second of a list");
  assert.equal(k.defaultValue("hfoo", await named("unam"), 0), "Fusssoldat");
  assert.equal(k.defaultValue("htow", await named("unam"), 0), undefined);
});

test("levels: abilities and upgrades count them, nothing else does", async () => {
  const abilities = await loadKind(game.w3, "w3a"), upgrades = await loadKind(game.w3, "w3q");
  assert.equal(abilities.levels("AHbz"), 3);
  assert.equal(abilities.levels("Aspb"), 1, "an empty cell");
  assert.equal(upgrades.levels("Rhme"), 3);
  assert.equal(upgrades.levels("Rxxx"), 1);
  assert.equal((await unit()).levels("hfoo"), 1);
});

test("facets sort objects by what they are", async () => {
  const k = await unit();
  assert.deepEqual(k.facetDefs.map((f) => f.id), ["race", "type", "source"]);
  assert.deepEqual(k.facets("hfoo"), { race: "Human", type: "Unit", source: "Melee" });
  assert.deepEqual(k.facets("Hpal"), { race: "Human", type: "Hero", source: "Melee" });
  assert.deepEqual(k.facets("htow"), { race: "Human", type: "Building", source: "Melee" });
  assert.deepEqual(k.facets("nspi"), { race: "Neutral / Other", type: "Unit", source: "Campaign" });
  const abilities = await loadKind(game.w3, "w3a");
  assert.deepEqual(abilities.facets("AHbz"), { race: "Human", use: "Hero" });
  assert.deepEqual(abilities.facets("Aspb"), { race: "Orc", use: "Item" });
  const items = await loadKind(game.w3, "w3t");
  assert.deepEqual(items.facets("ratf"), { class: "Permanent", level: "Level 3" });
  const doodads = await loadKind(game.w3, "w3d");
  assert.deepEqual(doodads.facets("LTlt"), { category: "Trees" }, "through WorldEditData and its strings");
  assert.deepEqual(doodads.facets("LMis"), { category: "—" });
});

test("search text is every table's English words", async () => {
  const k = await unit();
  assert.equal(k.searchText("hfoo"), "footman");
  assert.equal(k.searchText("Hpal"), "hero paladin");
  assert.equal(k.searchText("nothing"), "");
});

test("an unknown kind is refused", async () => {
  await assert.rejects(loadKind(game.w3, "w3z"), /unknown object kind w3z/);
});

test("a kind that failed to load is tried again", async () => {
  const { w3 } = fakeW3("hd", ["Units\\UpgradeData.slk"]);
  // w3q is already loaded from `game`: another kind that isn't.
  const fresh = "w3b";
  FILES["Units\\DestructableMetaData.slk"] = FILES["Doodads\\DoodadMetaData.slk"];
  await assert.rejects(loadKind(w3, fresh), /no Units\\DestructableData.slk/);
  FILES["Units\\DestructableData.slk"] = slk([["DestructableID", "category"], ["LTbr", "D"]]);
  assert.deepEqual((await loadKind(w3, fresh)).baseIds, ["LTbr"]);
});

test("value types: enums and flags are stored as integers", () => {
  for (const t of ["int", "bool", "attackBits", "deathType", "targetListFlags"]) assert.equal(valueTypeOf(t), "int", t);
  assert.equal(valueTypeOf("real"), "real");
  assert.equal(valueTypeOf("unreal"), "unreal");
  assert.equal(valueTypeOf("abilityList"), "string");
});

test("new ids follow the World Editor's scheme", () => {
  assert.equal(nextFreeId("w3u", "hfoo", new Set()), "h000", "units keep their base's letter");
  assert.equal(nextFreeId("w3u", "Hpal", new Set()), "H000");
  assert.equal(nextFreeId("w3a", "AHbz", new Set()), "A000");
  assert.equal(nextFreeId("w3t", "ratf", new Set()), "I000");
  assert.equal(nextFreeId("w3b", "LTbr", new Set()), "B000");
  assert.equal(nextFreeId("w3d", "LTlt", new Set()), "D000");
  assert.equal(nextFreeId("w3q", "Rhme", new Set()), "R000");
  assert.equal(nextFreeId("w3h", "BHab", new Set()), "B000");
  assert.equal(nextFreeId("w3u", "hfoo", new Set(["h000", "h001"])), "h002", "the next free one");
  assert.equal(nextFreeId("w3u", "hfoo", new Set(Array.from({ length: 10 }, (_, i) => `h00${i}`))), "h00A", "digits, then letters");
  const firstRow = new Set(Array.from({ length: 36 }, (_, i) => `h0${"0"}${"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"[i]}`));
  assert.equal(nextFreeId("w3u", "hfoo", firstRow), "h010", "carries over");
});

test("the id space can run out", () => {
  const taken = { has: () => true } as unknown as Set<string>;
  assert.throws(() => nextFreeId("w3u", "hfoo", taken), /no free object ids left/);
});
