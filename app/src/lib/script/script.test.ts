// Known answers for the map script generator. The expected lines are the World Editor's own forms;
// the whole of it is compared with real output by scripts/script-check.

import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTriggerData } from "../triggers/triggerdata";
import type { Eca, TriggerFile, TriggerItem } from "../triggers/wtg";
import { destructablesSection, type DestructableJson } from "./destructables";
import { dropFunction, dropFunctionOf, dropSection, itemTableFunction, randomGroupsSection } from "./drops";
import { banner, generateScript, generateSections, HEADER_SECTION, header, ident, literal, parseSoundLabels, placedName, scriptSoundDurations, splitSections, str, type PlacedJson, type ScriptInput } from "./jass";
import { CONCAT, expr, INT_DIV, jassToLua, RAW } from "./lua";
import { abilityOrders, autocastOrdersOf, buildingTypes, customColorTypes, destructableTints, gameCustomColors, gameTeamColors, heroAbilities, specialUnits, teamColors } from "./objects";
import { AMBIENCE, configSection, dayNightModels, mainSection, playersSection, type SetupInput } from "./setup";
import { techTreeSection, upgradesSection } from "./techs";
import { convertToCustom, triggerCustomText, triggersSection } from "./triggers";
import { fixed, itemsSection, unitsSection, type UnitJson } from "./units";

const EOL = "\r\n";
const data = parseTriggerData(`
[TriggerTypes]
integer=0,1,1,Integer
string=0,1,1,String
unitcode=0,1,1,Unit-Type,integer
[TriggerParams]
OperatorEqualENE=0,ComparisonOperator,==,Equal
[TriggerEvents]
MapInitializationEvent=0,nothing
[TriggerConditions]
OperatorCompareInteger=0,integer,ComparisonOperator,integer
[TriggerActions]
DoNothing=0,nothing
KillUnit=0,unit
`);

const has = (text: string, line: string) => assert.ok(text.split(EOL).includes(line), `no line "${line}" in:\n${text}`);
const hasNot = (text: string, part: string) => assert.ok(!text.includes(part), `"${part}" in:\n${text}`);

// ---- numbers and names ------------------------------------------------------------------

test("reals round like C: exact ties go to the even digit", () => {
  assert.equal(fixed(185.25, 1), "185.2");
  assert.equal(fixed(185.75, 1), "185.8");
  assert.equal(fixed(-3722.25, 1), "-3722.2");
  assert.equal(fixed(0.125, 2), "0.12");
  assert.equal(fixed(1.26, 1), "1.3");
});

test("reals are 32-bit: what a float holds is what's written", () => {
  assert.equal(fixed(0.1, 3), "0.100");
  assert.equal(fixed(1650.0000001, 1), "1650.0");
});

test("names become identifiers as the World Editor makes them", () => {
  assert.equal(ident("Spawn Point"), "Spawn_Point");
  assert.equal(ident("Boss Room (2)"), "Boss_Room__2_u");
  assert.equal(ident("Wave_"), "Wave_u");
  assert.equal(ident("trailing  "), "trailing");
  // By UTF-8 byte: two for each of these letters, three for a Chinese character.
  assert.equal(ident("Größe"), "Gr____e");
  assert.equal(ident("金矿1"), "______1");
});

test("strings are quoted with their special characters escaped", () => {
  assert.equal(str('say "hi"'), '"say \\"hi\\""');
  assert.equal(str("Sound\\x.wav"), '"Sound\\\\x.wav"');
});

test("typed values become JASS source", () => {
  assert.equal(literal(data, "string", "a"), '"a"');
  assert.equal(literal(data, "unitcode", "hfoo"), "'hfoo'");
  assert.equal(literal(data, "integer", "5"), "5");
});

test("placed objects are named by id and creation number", () => {
  assert.equal(placedName({ id: "hfoo", editorId: 12 }, "unit"), "gg_unit_hfoo_0012");
  // Doodad files v13 keep the number in the trailer.
  assert.equal(placedName({ id: "LTlt", editorId: 3, trailer: [118, 0, 0] } as PlacedJson, "dest"), "gg_dest_LTlt_0118");
});

// ---- whole scripts ----------------------------------------------------------------------

const info = (extra: object = {}) => ({
  name: "Test Map", author: "Someone", description: "D", version: 25, flags: 0, tileset: "L", cameraBounds: [-1024, -1024, 1024, 1024], soundEnvironment: "", lightEnvironment: "",
  players: [{ id: 0, controller: 1, race: 1, fixedStart: 0, name: "P", start: [0, 0], allyLow: 0, allyHigh: 0 }], forces: [{ flags: 0, players: 1, name: "F" }], ...extra,
});
const input = (extra: Partial<ScriptInput> = {}): ScriptInput => ({ info: info(), data, lights: { terrain: "T.mdl", unit: "U.mdl" }, ...extra });
const trigger = (name: string, ecas: Eca[], extra: Partial<TriggerItem> = {}): TriggerItem =>
  ({ type: 8, name, description: "", isComment: 0, id: 0, enabled: true, isCustom: false, initiallyOff: false, runOnInit: false, parent: 0, ecas, ...extra });
const wtg = (items: TriggerItem[]): TriggerFile => ({ reforged: false, version: 7, counts: [], unknown: 2, variables: [], items });
const eca = (kind: number, name: string, params: Eca["params"] = [], extra: Partial<Eca> = {}): Eca => ({ kind, name, enabled: true, params, children: [], ...extra });

test("the header names the map and its author, if any", () => {
  const h = header(input());
  has(h, "// Test Map");
  has(h, "//   Map Author: Someone");
  has(header(input({ info: info({ author: "" }) })), "//   Map Author: ");
  has(header(input({ string: (v) => (v === "Test Map" ? "Resolved" : v) })), "// Resolved");
});

test("splitting a script gives back the sections it was made of", () => {
  const sections = generateSections(input());
  const script = [...sections.values()].join("");
  const again = splitSections(script);
  for (const [k, v] of sections) if (v) assert.equal(again.get(k), v, k || "(header)");
});

test("the map's custom script header goes under a second banner after the objects, the first stays empty", () => {
  // As WormWar and BomberCommand have it: globals, an empty "Custom Script Code", the objects, the header, the triggers.
  const custom = { reforged: false, version: 1, comment: "", header: "\r\nfunction H takes nothing returns nothing\r\nendfunction\r\n", texts: [] };
  const regions = [{ name: "R", index: 0, left: 0, bottom: 0, right: 1, top: 1, weather: "", sound: "" }];
  const script = generateScript(input({ triggers: wtg([]), custom, regions }));
  const first = script.indexOf("//*  Custom Script Code"), second = script.indexOf("//*  Custom Script Code", first + 1);
  assert.ok(first > 0 && second > script.indexOf("function CreateRegions") && second < script.indexOf("//*  Triggers"), script);
  // The first banner, then the next section's straight away.
  assert.ok(script.slice(first).startsWith(["//*  Custom Script Code", "//*", "//" + "*".repeat(75), "", "//" + "*".repeat(75)].join(EOL)), script);
  // The header as the map has it, its leading empty line too, right after its banner, and one line break after it.
  assert.ok(script.includes(["//*  Custom Script Code", "//*", "//" + "*".repeat(75), "", "function H takes nothing returns nothing", "endfunction", "", "//" + "*".repeat(75)].join(EOL)), script);
  // Split again under its own key.
  const again = splitSections(script);
  assert.equal(again.get(HEADER_SECTION), generateSections(input({ triggers: wtg([]), custom, regions })).get(HEADER_SECTION));
  assert.ok(!again.get("Custom Script Code")!.includes("function H"));
  // Without code no second banner.
  const empty = generateScript(input({ triggers: wtg([]), custom: { ...custom, header: "\r\n" } }));
  assert.equal(empty.split("//*  Custom Script Code").length, 2);
});

test("banners read as the World Editor writes them", () => {
  assert.equal(banner("Cameras").split(EOL)[2], "//*  Cameras");
});

test("sections come in the World Editor's order", () => {
  const script = generateScript(input({ triggers: wtg([trigger("T", [])]), regions: [{ name: "R", index: 0, left: 0, bottom: 0, right: 1, top: 1, weather: "", sound: "" }] }));
  const at = (s: string) => script.indexOf(s);
  assert.ok(at("Global Variables") < at("function CreateRegions"));
  assert.ok(at("function CreateRegions") < at("function InitTrig_T"));
  assert.ok(at("function InitTrig_T") < at("function InitCustomPlayerSlots"));
  assert.ok(at("function InitCustomPlayerSlots") < at("function main"));
  assert.ok(at("function main") < at("function config"));
});

test("main doesn't call what isn't there", () => {
  const script = generateScript(input());
  for (const f of ["InitSounds", "CreateRegions", "CreateCameras", "InitUpgrades", "InitTechTree", "CreateAllDestructables", "CreateAllItems", "InitRandomGroups", "CreateAllUnits", "RunInitializationTriggers"]) hasNot(script, f);
});

test("a map without war3map.wtg doesn't call InitCustomTriggers", () => {
  hasNot(generateScript(input()), "InitCustomTriggers");
  assert.ok(generateScript(input({ triggers: wtg([]) })).includes("call InitCustomTriggers(  )"));
});

test("upgrade settings that apply to nobody make no InitUpgrades call", () => {
  // Player 3 isn't in the map, so there's no function; main used to call it anyway.
  const upgrades = [{ players: 1 << 3, id: "Rhme", level: 0, availability: 2 }];
  hasNot(generateScript(input({ info: info({ upgrades }) })), "InitUpgrades");
  // The default availability sets nothing either.
  hasNot(generateScript(input({ info: info({ upgrades: [{ players: 1, id: "Rhme", level: 0, availability: 1 }] }) })), "InitUpgrades");
  assert.ok(generateScript(input({ info: info({ upgrades: [{ players: 1, id: "Rhme", level: 0, availability: 2 }] }) })).includes("call InitUpgrades(  )"));
});

test("tech settings that apply to nobody make no InitTechTree call", () => {
  hasNot(generateScript(input({ info: info({ techs: [{ players: 1 << 3, id: "hfoo" }] }) })), "InitTechTree");
  assert.ok(generateScript(input({ info: info({ techs: [{ players: 1, id: "hfoo" }] }) })).includes("call InitTechTree(  )"));
});

// ---- globals ----------------------------------------------------------------------------

const variable = (name: string, type: string, extra: object = {}) => ({ name, type, unknown: 0, isArray: false, arraySize: 0, initialized: false, initialValue: "", id: 0, parent: 0, ...extra });

test("variables are declared and start with their type's default", () => {
  const triggers = { ...wtg([]), variables: [variable("Score", "integer"), variable("Kind", "unitcode", { initialized: true, initialValue: "hfoo" }), variable("Grid", "integer", { isArray: true, arraySize: 3 })] };
  const g = generateSections(input({ triggers })).get("Global Variables")!;
  has(g, `    ${"integer".padEnd(24)}${"udg_Score".padEnd(26)} = 0`);
  has(g, `    ${"integer array".padEnd(24)}udg_Grid`);
  has(g, "    set udg_Score = 0");
  has(g, "    set udg_Kind = 'hfoo'");
  has(g, "        exitwhen (i > 3)");
  has(g, "        set udg_Grid[i] = 0");
});

test("objects with the same name share one global", () => {
  const r = (index: number) => ({ name: "Same Name", index, left: 0, bottom: 0, right: 1, top: 1, weather: "", sound: "" });
  const g = generateSections(input({ regions: [r(0), r(1)] })).get("Global Variables")!;
  assert.equal(g.split("gg_rct_Same_Name").length - 1, 1);
});

// ---- units --------------------------------------------------------------------------------

const unit = (extra: Partial<UnitJson> = {}): UnitJson => ({
  id: "hfoo", variation: 0, position: [100, 200, 0], angle: 0, player: 0, hp: -1, mana: -1, gold: 12500, targetAcquisition: -1, level: 1, inventory: [], abilities: [], color: -1, waygate: -1, editorId: 1, ...extra,
});
const units = (list: UnitJson[], extra: object = {}) => unitsSection({ units: list, kindOf: (id) => (id === "hbar" ? "building" : "unit"), referenced: new Set(), ...extra });

test("a unit is created where it was placed", () => {
  has(units([unit({ angle: Math.PI / 2 })]), "    set u = BlzCreateUnitWithSkin( p, 'hfoo', 100.0, 200.0, 90.000, 'hfoo' )");
  has(units([unit({ skinId: "hkni" })]), "    set u = BlzCreateUnitWithSkin( p, 'hfoo', 100.0, 200.0, 0.000, 'hkni' )");
});

test("a unit a trigger refers to is created into its global", () => {
  has(units([unit()], { referenced: new Set(["gg_unit_hfoo_0001"]) }), "    set gg_unit_hfoo_0001 = BlzCreateUnitWithSkin( p, 'hfoo', 100.0, 200.0, 0.000, 'hfoo' )");
});

test("gold mines keep their gold, blighted ones have their own constructor", () => {
  has(units([unit({ id: "ngol", gold: 5000 })]), "    call SetResourceAmount( u, 5000 )");
  has(units([unit({ id: "ugol" })]), "    set u = CreateBlightedGoldmine( p, 100.0, 200.0, 0.000 )");
  hasNot(units([unit()]), "SetResourceAmount");
});

test("placed changes are written, defaults aren't", () => {
  const plain = units([unit()]);
  for (const f of ["SetUnitAcquireRange", "SetHeroLevel", "SetUnitState", "SelectHeroSkill", "UnitAddItemToSlotById", "SetUnitColor", "Waygate"]) hasNot(plain, f);
  const u = units([unit({ targetAcquisition: 300, level: 3, hp: 50, mana: 20, inventory: [{ slot: 1, id: "ratc" }] })]);
  has(u, "    call SetUnitAcquireRange( u, 300.0 )");
  has(u, "    call SetHeroLevel( u, 3, false )");
  has(u, "    call SetUnitState( u, UNIT_STATE_LIFE, 0.50 * life )");
  has(u, "    call SetUnitState( u, UNIT_STATE_MANA, 20 )");
  has(u, "    call UnitAddItemToSlotById( u, 'ratc', 1 )");
  // -2 is "camp": a fixed range.
  has(units([unit({ targetAcquisition: -2 })]), "    call SetUnitAcquireRange( u, 200.0 )");
  // A stored 0 is a range of its own (World Editor 2.0, we-drive 2026-11-09), -1 the default.
  has(units([unit({ targetAcquisition: 0 })]), "    call SetUnitAcquireRange( u, 0.0 )");
  has(units([unit({ targetAcquisition: 0.5 })]), "    call SetUnitAcquireRange( u, 0.5 )");
  hasNot(units([unit({ targetAcquisition: -1 })]), "SetUnitAcquireRange");
});

test("a hero's own attributes follow its level, before its life; 0 is its default ones", () => {
  // As World Editor 2.0 wrote it for a level 5 Paladin of 30/20/25 at 60 % life.
  const u = units([unit({ id: "Hpal", level: 5, strength: 30, agility: 20, intelligence: 25, hp: 60 })]);
  const want = ["    call SetHeroLevel( u, 5, false )", "    call SetHeroStr( u, 30, true )", "    call SetHeroAgi( u, 20, true )", "    call SetHeroInt( u, 25, true )",
    "    set life = GetUnitState( u, UNIT_STATE_LIFE )"].join(EOL);
  assert.ok(u.includes(want), `not in this order:\n${u}`);
  hasNot(units([unit({ id: "Hpal", level: 5, strength: 0, agility: 0, intelligence: 0 })]), "SetHeroStr");
  hasNot(units([unit({ id: "Hpal", level: 5 })]), "SetHeroStr");
});

test("autocast is set as placed; a toggle like Defend is only ever switched on", () => {
  const orders = (a: string) => (a === "AHhb" ? { on: "healon", off: "healoff" } : a === "Adef" ? { on: "defend" } : undefined);
  const placed = (id: string, autocast: number) => units([unit({ abilities: [{ id, autocast, level: 0 }] })], { autocastOrders: orders });
  has(placed("AHhb", 1), '    call IssueImmediateOrder( u, "healon" )');
  has(placed("AHhb", 0), '    call IssueImmediateOrder( u, "healoff" )');
  has(placed("Adef", 1), '    call IssueImmediateOrder( u, "defend" )');
  hasNot(placed("Adef", 0), "IssueImmediateOrder");
});

test("the acquisition range comes after the hero level and the mana", () => {
  // As the game's maps have it (RuinsofAzshara: mana, then range; OrcX02_03: level, then range).
  const u = units([unit({ id: "Hpal", targetAcquisition: -2, level: 14, mana: 200 })]);
  assert.ok(u.includes(["    call SetHeroLevel( u, 14, false )", "    call SetUnitState( u, UNIT_STATE_MANA, 200 )", "    call SetUnitAcquireRange( u, 200.0 )"].join(EOL)), u);
});

test("an unlearned hero ability gets no autocast order, other abilities of heroes do", () => {
  const orders = (a: string) => (a === "ANms" ? { on: "manashieldon", off: "manashieldoff" } : a === "Ainf" ? { on: "innerfireon", off: "innerfireoff" } : undefined);
  const hero = (a: string) => a === "ANms";
  const placed = (id: string, level: number, autocast = 0) => units([unit({ id: "Hvsh", abilities: [{ id, autocast, level }] })], { autocastOrders: orders, heroAbility: hero });
  // UndeadX04's Sea Witch has Mana Shield at 0, NightElfX04's at 1; NightElf03's custom heroes have Inner Fire on at 0.
  hasNot(placed("ANms", 0), "IssueImmediateOrder");
  has(placed("ANms", 1), '    call IssueImmediateOrder( u, "manashieldoff" )');
  has(placed("Ainf", 0, 1), '    call IssueImmediateOrder( u, "innerfireon" )');
});

test("hero abilities: the game's, changed by the map, inherited by custom ones", () => {
  const aher = (value: number) => [{ field: "aher", value }];
  const isHero = heroAbilities([{ original: [{ base: "AHhb", mods: aher(0) }], custom: [{ id: "A000", base: "ANms" }, { id: "A001", base: "Ainf", mods: aher(1) }] },
    { custom: [{ id: "A001", base: "Ainf", mods: [] }] }], new Set(["ANms", "AHhb"]));
  assert.deepEqual(["ANms", "AHhb", "A000", "A001", "Ainf"].map(isHero), [true, false, true, true, false]);
});

test("orders come from the game's ability tables", () => {
  const t = new Map([["AHhb", new Map([["orderon", "healon"], ["orderoff", "healoff"]])], ["Adef", new Map([["order", "defend"], ["unorder", "undefend"]])], ["Ablo", new Map([["order", "bloodlust"]])]]);
  const o = abilityOrders([t, new Map([["AHhb", new Map([["orderon", "other"], ["orderoff", "other"]])]])]);
  assert.deepEqual(o.get("AHhb"), { on: "healon", off: "healoff" });
  assert.deepEqual(o.get("Adef"), { on: "defend" });
  assert.equal(o.has("Ablo"), false);
});

test("only waygates mean the placement's own colour and target", () => {
  const regionName = () => "gg_rct_Exit";
  const placed = units([unit({ id: "ogru", color: 0, waygate: 0 })], { regionName });
  hasNot(placed, "SetUnitColor");
  hasNot(placed, "Waygate");
  const gate = units([unit({ id: "nwgt", color: 3, waygate: 0 })], { regionName });
  has(gate, "    call SetUnitColor( u, ConvertPlayerColor(3) )");
  has(gate, "    call WaygateActivate( u, true )");
  has(units([unit({ id: "n000", color: 3, waygate: 0 })], { regionName, waygate: (id: string) => id === "n000" }), "    call WaygateActivate( u, true )");
});

// World Editor 2.0 on a copy of cliff.w3m (we-drive, 2026-11-10): h001 (a footman with Allow Custom Team Color) and
// colour 6 got SetUnitColor 6, n000 (a waygate type with it off) and colour 4 none, a waygate with colour 2 got 2.
test("the placement's own colour counts where its type allows a custom team colour (utcc), a footman's too", () => {
  const files = [{ original: [], custom: [{ id: "h001", base: "hfoo", mods: [{ field: "utcc", value: 1 }] }, { id: "n000", base: "nwgt", mods: [{ field: "utcc", value: 0 }] }, { id: "n001", base: "nwgt" }] }];
  const customColor = customColorTypes(files, gameCustomColors([{ unitUIID: "nwgt", customTeamColor: "1" }, { unitUIID: "hfoo", customTeamColor: "0" }]));
  assert.deepEqual(["nwgt", "hfoo", "h001", "n000", "n001"].map(customColor), [true, false, true, false, true]);
  has(units([unit({ id: "h001", color: 6 })], { customColor }), "    call SetUnitColor( u, ConvertPlayerColor(6) )");
  hasNot(units([unit({ id: "n000", color: 4 })], { customColor }), "SetUnitColor");
  has(units([unit({ id: "nwgt", color: 2 })], { customColor }), "    call SetUnitColor( u, ConvertPlayerColor(2) )");
  hasNot(units([unit({ id: "hfoo", color: 6 })], { customColor }), "SetUnitColor");
  // A unit table that couldn't be read leaves the waygate.
  assert.deepEqual([...gameCustomColors([])], ["nwgt"]);
});

test("a map's own ability is switched on by its base's orders", () => {
  // World Editor 2.0 wrote "healon" for a footman type with A000 (based on Heal) placed active (we-drive, 2026-11-10).
  const orders = autocastOrdersOf(new Map([["Ahea", { on: "healon", off: "healoff" }]]), [{ custom: [{ id: "A000", base: "Ahea" }, { id: "A001", base: "AHtb" }] }, null]);
  assert.deepEqual([orders("Ahea"), orders("A000"), orders("A001"), orders("A002")], [{ on: "healon", off: "healoff" }, { on: "healon", off: "healoff" }, undefined, undefined]);
  has(units([unit({ id: "h000", abilities: [{ id: "A000", autocast: 1, level: 0 }] })], { autocastOrders: orders }), '    call IssueImmediateOrder( u, "healon" )');
});

test("a type's team colour goes on placed units", () => {
  const teamColor = (id: string) => (id === "ntav" ? 12 : undefined);
  has(units([unit({ id: "ntav" })], { teamColor }), "    call SetUnitColor( u, ConvertPlayerColor(12) )");
  // The placement's own colour field is ignored unless it's a waygate.
  has(units([unit({ id: "ntav", color: 3 })], { teamColor }), "    call SetUnitColor( u, ConvertPlayerColor(12) )");
  hasNot(units([unit()], { teamColor }), "SetUnitColor");
  has(units([unit({ id: "ntav" })], { teamColor }), "    call SetUnitColor( u, ConvertPlayerColor(12) )");
  // Colour 0 is a colour.
  has(units([unit({ id: "ntav" })], { teamColor: () => 0 }), "    call SetUnitColor( u, ConvertPlayerColor(0) )");
});

test("team colours: the game's, changed by the map, inherited by custom units", () => {
  const game = gameTeamColors([{ unitUIID: "ntav", teamColor: "0" }, { unitUIID: "nmr2", teamColor: "12" }, { unitUIID: "hfoo", teamColor: "-1" }, { unitUIID: "hkni", teamColor: "" }, { unitUIID: "hpea" } as never]);
  assert.deepEqual([...game], [["ntav", 0], ["nmr2", 12]]);
  const utco = (value: number) => [{ field: "utco", value }];
  const c = teamColors([{ original: [{ base: "hshy", mods: utco(3) }, { base: "ntav", mods: utco(5) }], custom: [{ id: "h000", base: "hshy" }, { id: "h001", base: "hshy", mods: utco(7) }, { id: "h002", base: "hfoo" }] }, null], game);
  assert.equal(c.get("hshy"), 3);
  assert.equal(c.get("ntav"), 5);
  assert.equal(c.get("nmr2"), 12);
  assert.equal(c.get("h000"), 3);
  assert.equal(c.get("h001"), 7);
  assert.equal(c.has("h002"), false);
  assert.equal(game.get("ntav"), 0, "the game's table stays as it was");
});

test("team colours: the skin file's entries keep the colour war3map.w3u gives", () => {
  // HumanX06Finale's N000 (colour 12), HumanX03Secret's n00A (none, its base has 5): war3mapSkin.w3u lists them without utco.
  const c = teamColors([
    { custom: [{ id: "N000", base: "Nklj", mods: [{ field: "utco", value: 12 }] }, { id: "n00A", base: "nmr0", mods: [{ field: "utco", value: -1 }] }] },
    { custom: [{ id: "N000", base: "Nklj", mods: [{ field: "unam", value: "TRIGSTR_083" }] }, { id: "n00A", base: "nmr0", mods: [] }, { id: "n00B", base: "nmr0" }] },
  ], new Map([["nmr0", 5]]));
  assert.equal(c.get("N000"), 12);
  assert.equal(c.has("n00A"), false);
  assert.equal(c.get("n00B"), 5, "a type only the skin file lists takes its base's");
});

test("a map can take a type's team colour away", () => {
  const c = teamColors([{ original: [{ base: "ntav", mods: [{ field: "utco", value: -1 }] }], custom: [{ id: "n000", base: "nmr2", mods: [{ field: "utco", value: -1 }] }, { id: "n001", base: "ntav" }] }], new Map([["ntav", 0], ["nmr2", 12]]));
  assert.equal(c.has("ntav"), false);
  assert.equal(c.has("n000"), false);
  assert.equal(c.has("n001"), false);
  assert.equal(c.get("nmr2"), 12);
});

test("buildings: the game's, changed by the map, inherited by custom types; the skin file keeps what it doesn't set", () => {
  const ubdg = (value: number) => [{ field: "ubdg", value }];
  const isBuilding = buildingTypes([
    { original: [{ base: "hwtw", mods: ubdg(0) }, { base: "nbzk", mods: ubdg(1) }],
      custom: [{ id: "n003", base: "ngme", mods: ubdg(0) }, { id: "n004", base: "ngme" }, { id: "n005", base: "hwtw" }, { id: "n006", base: "hfoo", mods: ubdg(1) }] },
    // war3mapSkin.w3u: the same custom types again, with their looks only (UndeadX01).
    { custom: [{ id: "n003", base: "ngme", mods: [{ field: "umdl", value: "x.mdl" }] }, { id: "n006", base: "hfoo" }] },
  ], new Set(["ngme", "hwtw"]));
  assert.equal(isBuilding("n003"), false, "made a unit in war3map.w3u, not in the skin file");
  assert.equal(isBuilding("n004"), true, "its base's");
  assert.equal(isBuilding("n005"), false, "its base, changed by the map");
  assert.equal(isBuilding("n006"), true);
  assert.equal(isBuilding("hwtw"), false);
  assert.equal(isBuilding("nbzk"), true);
  assert.equal(isBuilding("ngme"), true);
  assert.equal(isBuilding("hfoo"), false);
});

test("custom gold mines and waygates are found in the object data", () => {
  const s = specialUnits([{ original: [{ base: "nrdr", mods: [{ field: "uabi", value: "Awan,Agld,Avul" }] }, { base: "hfoo", mods: [{ field: "uabi", value: "Adef" }] }],
    custom: [{ id: "n000", base: "ngol" }, { id: "n001", base: "hfoo", mods: [{ field: "uabi", value: "Agld" }] }, { id: "n002", base: "nwgt" }, { id: "n003", base: "hfoo" }] }, null]);
  for (const id of ["ngol", "ugol", "egol", "nrdr", "n000", "n001"]) assert.ok(s.goldMines.has(id), id);
  assert.ok(!s.goldMines.has("n003"));
  assert.ok(!s.goldMines.has("hfoo"));
  assert.ok(s.waygates.has("n002"));
  assert.ok(!s.waygates.has("n003"));
  has(units([unit({ id: "n000", gold: 7000 })], { goldMine: (id: string) => s.goldMines.has(id) }), "    call SetResourceAmount( u, 7000 )");
});

test("waygates go to their region, if it still exists", () => {
  const regionName = (n: number) => (n === 2 ? "gg_rct_Exit" : undefined);
  const u = units([unit({ id: "nwgt", waygate: 2 })], { regionName });
  has(u, "    call WaygateSetDestination( u, GetRectCenterX(gg_rct_Exit), GetRectCenterY(gg_rct_Exit) )");
  has(u, "    call WaygateActivate( u, true )");
  hasNot(units([unit({ id: "nwgt", waygate: 9 })], { regionName }), "Waygate");
});

test("units go to one function per player and kind, neutrals last", () => {
  const s = units([unit({ player: 1 }), unit({ id: "hbar", player: 1, editorId: 2 }), unit({ player: 24, editorId: 3 }), unit({ player: 27, editorId: 4 })]);
  for (const f of ["CreateBuildingsForPlayer1", "CreateUnitsForPlayer1", "CreateNeutralHostile", "CreateNeutralPassive", "CreatePlayerBuildings", "CreatePlayerUnits", "CreateAllUnits"]) assert.ok(s.includes(`function ${f} takes`), f);
  has(s, "    local player p = Player(PLAYER_NEUTRAL_AGGRESSIVE)");
});

test("neutral buildings come first: hostile, then passive, then the players'", () => {
  const s = units([unit({ id: "hbar", player: 24 }), unit({ id: "hbar", player: 27, editorId: 2 }), unit({ id: "hbar", player: 0, editorId: 3 })]);
  const all = s.slice(s.indexOf("function CreateAllUnits"));
  assert.ok(all.indexOf("CreateNeutralHostileBuildings") < all.indexOf("CreateNeutralPassiveBuildings"));
  assert.ok(all.indexOf("CreateNeutralPassiveBuildings") < all.indexOf("CreatePlayerBuildings"));
});

test("units are created in placement order", () => {
  const s = units([unit({ editorId: 5, position: [5, 0, 0] }), unit({ editorId: 2, position: [2, 0, 0] })]);
  assert.ok(s.indexOf("'hfoo', 2.0") < s.indexOf("'hfoo', 5.0"));
});

test("a placed random unit picks its type when the map starts", () => {
  const fromGroup = units([unit({ id: "uDNR", randomType: 1, randomGroup: 1, randomPosition: 2 })]);
  has(fromGroup, "    set unitID = gg_rg_001[2]");
  has(fromGroup, "    if (unitID != -1) then");
  has(fromGroup, "        set u = BlzCreateUnitWithSkin( p, unitID, 100.0, 200.0, 0.000, unitID )");
  has(fromGroup, "    endif");
  hasNot(fromGroup, "'uDNR'");
  const fromList = units([unit({ id: "uDNR", randomType: 2, randomUnits: [{ id: "nfoh", chance: 50 }, { id: "nmoo", chance: 50 }] })]);
  has(fromList, "    call RandomDistAddItem( 'nfoh', 50 )");
  has(fromList, "    set unitID = RandomDistChoose(  )");
  has(units([unit({ id: "uDNR", randomType: 0, randomLevel: "020000" })]), "    set unitID = ChooseRandomCreep( 2 )");
  has(units([unit({ id: "bDNR", randomType: 0 })]), "    set unitID = ChooseRandomNPBuilding(  )");
});

test("what follows a random unit stays inside its if", () => {
  const s = units([unit({ id: "uDNR", randomType: 1, randomGroup: 0, randomPosition: 0, itemTable: 4 })]);
  has(s, "        call TriggerRegisterUnitEvent( t, u, EVENT_UNIT_DEATH )");
});

test("a random building goes with the buildings", () => {
  const s = units([unit({ id: "bDNR", randomType: 1, randomGroup: 0, randomPosition: 0 })]);
  assert.ok(s.includes("function CreateBuildingsForPlayer0 takes"));
  hasNot(s, "function CreateUnitsForPlayer0");
});

test("the player field also says an Ancient is placed uprooted", () => {
  const s = units([unit({ id: "eaow", player: 0x10001 })], { referenced: new Set(["gg_unit_eaow_0001"]) });
  has(s, '    call IssueImmediateOrder( gg_unit_eaow_0001, "unroot" )');
  assert.ok(s.includes("function CreateUnitsForPlayer1 takes"));
  hasNot(s, "65537");
  hasNot(units([unit({ id: "eaow", player: 1 })]), "unroot");
});

test("code that doesn't compile needs no assignment: a disabled trigger's unit stays a plain u", () => {
  const uses = (extra: Partial<TriggerItem>, action: Partial<Eca> = {}) => {
    const triggers = wtg([trigger("T", [eca(2, "KillUnit", [{ type: 1, value: "gg_unit_hfoo_0001" }], action)], extra)]);
    return generateSections(input({ triggers, units: [unit()] as unknown as PlacedJson[], kindOf: () => "unit" }));
  };
  const on = uses({}), off = uses({ enabled: false }), offAction = uses({}, { enabled: false });
  has(on.get("Unit Creation")!, "    set gg_unit_hfoo_0001 = BlzCreateUnitWithSkin( p, 'hfoo', 100.0, 200.0, 0.000, 'hfoo' )");
  has(off.get("Unit Creation")!, "    set u = BlzCreateUnitWithSkin( p, 'hfoo', 100.0, 200.0, 0.000, 'hfoo' )");
  has(offAction.get("Unit Creation")!, "    set u = BlzCreateUnitWithSkin( p, 'hfoo', 100.0, 200.0, 0.000, 'hfoo' )");
  // Still declared, as the World Editor does.
  assert.ok(off.get("Global Variables")!.includes("gg_unit_hfoo_0001"));
});

// ---- items and destructables ----------------------------------------------------------------

const items = (list: UnitJson[], editorVersion = 0) => itemsSection({ units: list, kindOf: () => "item", referenced: new Set(), editorVersion });

test("items are created by type, then in the file's order, not by number", () => {
  // As the World Editor's CreateAllItems in OrcX01_05: shwd 2 before shwd 1, as war3mapUnits.doo lists them.
  const s = items([unit({ id: "zzzz", editorId: 1 }), unit({ id: "ratc", editorId: 9 }), unit({ id: "ratc", editorId: 2, position: [7, 0, 0] })]);
  assert.ok(s.indexOf("'ratc', 100.0") < s.indexOf("'ratc', 7.0"));
  assert.ok(s.indexOf("'ratc', 7.0") < s.indexOf("'zzzz'"));
  has(s, "    call BlzCreateItemWithSkin( 'zzzz', 100.0, 200.0, 'zzzz' )");
});

test("a placed random item picks its type when the map starts, and is no unit", () => {
  // The object data's lookup calls iDNR a unit (it is no item type): the id decides.
  const kindOf = (id: string) => (id === "ratc" ? "item" as const : "unit" as const);
  const placed = [unit({ id: "iDNR", randomType: 0, randomLevel: "030000", randomClass: 1 }), unit({ id: "ratc", editorId: 2 })];
  const s = itemsSection({ units: placed, kindOf, referenced: new Set() });
  has(s, "    set itemID = ChooseRandomItemEx( ITEM_TYPE_PERMANENT, 3 )");
  has(s, "    if (itemID != -1) then");
  has(s, "        call BlzCreateItemWithSkin( itemID, 100.0, 200.0, itemID )");
  hasNot(s, "'iDNR'");
  hasNot(unitsSection({ units: placed, kindOf, referenced: new Set() }), "iDNR");
  // Any level and class; newer editors' plain form; a group's position; a list.
  has(items([unit({ id: "iDNR", randomType: 0, randomLevel: "ffffff", randomClass: 0 })]), "    set itemID = ChooseRandomItemEx( ITEM_TYPE_ANY, -1 )");
  has(items([unit({ id: "iDNR", randomType: 0, randomLevel: "020000", randomClass: 0 })], 7000), "    set itemID = ChooseRandomItem( 2 )");
  has(items([unit({ id: "iDNR", randomType: 0, randomLevel: "020000", randomClass: 7 })], 7000), "    set itemID = ChooseRandomItemEx( ITEM_TYPE_MISCELLANEOUS, 2 )");
  has(items([unit({ id: "iDNR", randomType: 1, randomGroup: 4, randomPosition: 1 })]), "    set itemID = gg_rg_004[1]");
  const list = items([unit({ id: "iDNR", randomType: 2, randomUnits: [{ id: "ratc", chance: 60 }] })]);
  has(list, "    call RandomDistAddItem( 'ratc', 60 )");
  has(list, "    set itemID = RandomDistChoose(  )");
  // Newer editors create it into the local, but give it no colour.
  const grouped = items([unit({ id: "iDNR", randomType: 1, randomGroup: 0, randomPosition: 0, color: 3 })], 7003);
  has(grouped, "        set i = BlzCreateItemWithSkin( itemID, 100.0, 200.0, itemID )");
  hasNot(grouped, "ItemColor");
});

test("World Editor 2.0 picks random items with ChooseRandomItemExWithFilter, any class and level too", () => {
  // As it saved them (we-drive, 2026-11-09).
  const random = (randomLevel: string, randomClass: number) => items([unit({ id: "iDNR", randomType: 0, randomLevel, randomClass })], 7003);
  has(random("ffffff", 0), "    set itemID = ChooseRandomItemExWithFilter( ITEM_TYPE_ANY, -1, EQUIPMENT_TYPE_ANY, ITEMTAG_TYPE_ANY )");
  has(random("010000", 0), "    set itemID = ChooseRandomItemExWithFilter( ITEM_TYPE_ANY, 1, EQUIPMENT_TYPE_ANY, ITEMTAG_TYPE_ANY )");
  has(random("020000", 1), "    set itemID = ChooseRandomItemExWithFilter( ITEM_TYPE_PERMANENT, 2, EQUIPMENT_TYPE_ANY, ITEMTAG_TYPE_ANY )");
  has(random("ffffff", 4), "    set itemID = ChooseRandomItemExWithFilter( ITEM_TYPE_ARTIFACT, -1, EQUIPMENT_TYPE_ANY, ITEMTAG_TYPE_ANY )");
  has(random("060000", 7), "    set itemID = ChooseRandomItemExWithFilter( ITEM_TYPE_MISCELLANEOUS, 6, EQUIPMENT_TYPE_ANY, ITEMTAG_TYPE_ANY )");
  // Its item drops the same.
  const drops = dropFunction("Unit000001_DropItems", [[{ id: "YYI2", chance: 50 }, { id: "YiI/", chance: 30 }], [{ id: "YYI/", chance: 100 }]], 7003);
  has(drops, "        call RandomDistAddItem( ChooseRandomItemExWithFilter( ITEM_TYPE_ANY, 2, EQUIPMENT_TYPE_ANY, ITEMTAG_TYPE_ANY ), 50 )");
  has(drops, "        call RandomDistAddItem( ChooseRandomItemExWithFilter( ITEM_TYPE_PERMANENT, -1, EQUIPMENT_TYPE_ANY, ITEMTAG_TYPE_ANY ), 30 )");
  has(drops, "        call RandomDistAddItem( ChooseRandomItemExWithFilter( ITEM_TYPE_ANY, -1, EQUIPMENT_TYPE_ANY, ITEMTAG_TYPE_ANY ), 100 )");
  // The game's older maps keep theirs.
  has(dropFunction("Unit000001_DropItems", [[{ id: "YYI2", chance: 50 }]], 6113), "        call RandomDistAddItem( ChooseRandomItemEx( ITEM_TYPE_ANY, 2 ), 50 )");
});

test("newer editors colour every item, whatever its stored colour; World Editor 2.0 of build 24371 with 24", () => {
  hasNot(items([unit()]), "ItemColor");
  has(items([unit()], 7000), "    call SetItemColor( i, ConvertPlayerColor(0) )");
  has(items([unit()], 7003), "    call BlzSetItemColor( i, ConvertPlayerColor(0) )");
  const build = (gameBuild: number, color: number, player = 0) => itemsSection({ units: [unit({ color, player })], kindOf: () => "item", referenced: new Set(), editorVersion: 7003, gameBuild });
  for (const [color, player] of [[-1, 0], [0, 0], [3, 0], [24, 0], [-1, 27], [5, 27], [7, 3]]) {
    has(build(24371, color, player), "    call BlzSetItemColor( i, ConvertPlayerColor(24) )");
    // The game's maps of builds up to 24356 have 0 (their items store -1).
    has(build(24356, color, player), "    call BlzSetItemColor( i, ConvertPlayerColor(0) )");
  }
  // On game data version 1 (the classic tables, whose ItemData has no teamColor column) the editor of 24371 writes 0:
  // NightElfX03 saved as Lua (we-drive, round 3) and Forsaken07x (smoketest_maps), items stored -1, owner 27.
  const classic = (gameDataVersion: number | undefined) => itemsSection({ units: [unit({ color: -1, player: 27 })], kindOf: () => "item", referenced: new Set(), editorVersion: 7003, gameBuild: 24371, gameDataVersion });
  has(classic(1), "    call BlzSetItemColor( i, ConvertPlayerColor(0) )");
  has(classic(2), "    call BlzSetItemColor( i, ConvertPlayerColor(24) )");
});

test("on game data version 2 the item colour is the item type's teamColor, as the map's object data changes it", () => {
  // we-drive, verification round 3 package 6: ItemData teamColor ecgh 8, ehhi 3, erhe 6, erpb 1, eymo 5, ratf 24.
  const game = gameTeamColors([{ itemID: "ecgh", teamColor: "8" }, { itemID: "ehhi", teamColor: "3" }, { itemID: "ratf", teamColor: "24" }], "itemID");
  const itco = (value: number) => [{ field: "itco", value }];
  const colors = teamColors([{ original: [{ base: "ehhi", mods: itco(11) }], custom: [{ id: "I000", base: "ecgh" }, { id: "I001", base: "ratf", mods: itco(2) }] }, null], game, "itco");
  const placed = (id: string, gameDataVersion = 2) => itemsSection({ units: [unit({ id, color: -1, player: 27 })], kindOf: () => "item", referenced: new Set(), editorVersion: 7003, gameBuild: 24371, gameDataVersion, itemColor: (t) => colors.get(t) });
  has(placed("ecgh"), "    call BlzSetItemColor( i, ConvertPlayerColor(8) )");
  has(placed("ratf"), "    call BlzSetItemColor( i, ConvertPlayerColor(24) )");
  has(placed("ehhi"), "    call BlzSetItemColor( i, ConvertPlayerColor(11) )");
  has(placed("I000"), "    call BlzSetItemColor( i, ConvertPlayerColor(8) )");
  has(placed("I001"), "    call BlzSetItemColor( i, ConvertPlayerColor(2) )");
  // A type the tables don't know gets 24; the classic tables have no colour (0).
  has(placed("zzzz"), "    call BlzSetItemColor( i, ConvertPlayerColor(24) )");
  has(placed("ecgh", 1), "    call BlzSetItemColor( i, ConvertPlayerColor(0) )");
});

test("newer editors declare the item local even when every item has its global", () => {
  // OrcX01_05 (editor 7003): all ten items named by triggers, "local item i" all the same.
  const named = (editorVersion: number) => itemsSection({ units: [unit({ id: "shwd" })], kindOf: () => "item", referenced: new Set(["gg_item_shwd_0001"]), editorVersion });
  has(named(7003), "    local item i");
  hasNot(named(6127), "local item i");
});

const dest = (extra: Partial<DestructableJson> = {}): DestructableJson => ({ id: "LTlt", variation: 2, position: [1, 2, 3], angle: 0, scale: [1, 1, 1], flags: 0, life: 100, editorId: 1, ...extra });
const dests = (list: DestructableJson[], extra: object = {}) => destructablesSection({ doodads: list, globalName: () => "gg_dest_x", referenced: new Set(["gg_dest_x"]), ...extra });

test("a destructable nobody needs isn't in the script", () => {
  assert.equal(dests([dest()], { referenced: new Set() }), "");
  assert.equal(dests([dest({ flags: 2 })]), "");
});

test("destructables by version, height and state", () => {
  has(dests([dest()]), "    set gg_dest_x = BlzCreateDestructableWithSkin( 'LTlt', 1.0, 2.0, 0.000, 1.000, 2, 'LTlt' )");
  has(dests([dest({ flags: 4 })]), "    set gg_dest_x = BlzCreateDestructableZWithSkin( 'LTlt', 1.0, 2.0, 3.0, 0.000, 1.000, 2, 'LTlt' )");
  has(dests([dest({ life: 0 })]), "    set gg_dest_x = BlzCreateDeadDestructableWithSkin( 'LTlt', 1.0, 2.0, 0.000, 1.000, 2, 'LTlt' )");
  has(dests([dest()], { editorVersion: 6117 }), "    set gg_dest_x = BlzCreateDestructableWithSkinPitchRoll( 'LTlt', 1.0, 2.0, 0.000, 0.000, 0.000, 1.000, 2, 'LTlt' )");
  const v7 = dests([dest()], { editorVersion: 7000 });
  assert.ok(v7.includes("WithSkinPitchRollColor(") && v7.includes("ConvertPlayerColor(24)"));
  has(v7, "    call SetDestructableVertexColor( gg_dest_x, 255, 255, 255, 255 )");
  has(dests([dest({ life: 50 })]), "    call SetDestructableLife( gg_dest_x, 0.50 * life )");
});

test("a destructable's tint is its type's, as the map's object data sets it", () => {
  // HumanX03: LTg1 tinted 80 in war3mapSkin.w3b, DTes 100 in war3map.w3b; the rest untinted.
  const tint = destructableTints([
    { original: [{ base: "DTes", mods: [{ field: "bvcr", value: 100 }, { field: "bvcg", value: 100 }, { field: "bvcb", value: 100 }] }, { base: "LTg1", mods: [] }],
      custom: [{ id: "B001", base: "LTlt", mods: [{ field: "bvcr", value: 10 }] }] },
    { original: [{ base: "LTg1", mods: [{ field: "bvcr", value: 80 }, { field: "bvcg", value: 80 }, { field: "bvcb", value: 80 }] }],
      custom: [{ id: "B000", base: "DTes", mods: [{ field: "bvcg", value: 150 }] }, { id: "B001", base: "LTlt", mods: [] }] },
  ]);
  assert.deepEqual([tint("DTes"), tint("LTg1"), tint("B000"), tint("B001"), tint("LTlt")], [[100, 100, 100], [80, 80, 80], [100, 150, 100], [10, 255, 255], [255, 255, 255]]);
  has(dests([dest({ id: "LTg1" })], { editorVersion: 7003, tint }), "    call SetDestructableVertexColor( gg_dest_x, 80, 80, 80, 255 )");
});

test("a destructable with item sets gets a death trigger", () => {
  const s = dests([dest({ itemSets: [[{ id: "ratc", chance: 100 }]] })], { referenced: new Set() });
  has(s, "    call TriggerRegisterDeathEvent( t, d )");
  has(s, "    call TriggerAddAction( t, function Doodad000000_DropItems )");
});

// ---- drops --------------------------------------------------------------------------------

test("item sets: each item by chance, the rest to 100 drops nothing", () => {
  const f = dropFunction("X", [[{ id: "ratc", chance: 40 }, { id: "ckng", chance: 35 }]]);
  has(f, "        call RandomDistAddItem( 'ratc', 40 )");
  has(f, "        call RandomDistAddItem( -1, 25 )");
  hasNot(dropFunction("X", [[{ id: "ratc", chance: 100 }]]), "RandomDistAddItem( -1");
});

test("random items and empty slots", () => {
  const f = (id: string, version = 0) => dropFunction("X", [[{ id, chance: 100 }]], version);
  has(f("YiI2"), "        call RandomDistAddItem( ChooseRandomItemEx( ITEM_TYPE_PERMANENT, 2 ), 100 )");
  has(f("YYI/"), "        call RandomDistAddItem( ChooseRandomItemEx( ITEM_TYPE_ANY, -1 ), 100 )");
  has(f("YYI3", 7000), "        call RandomDistAddItem( ChooseRandomItem( 3 ), 100 )");
  has(f("0x00000000"), "        call RandomDistAddItem( -1, 100 )");
});

test("drop functions are named after the table or the file position", () => {
  assert.equal(itemTableFunction(3), "ItemTable000003_DropItems");
  assert.equal(dropFunctionOf("Unit", { itemTable: 3 }, 7), "ItemTable000003_DropItems");
  assert.equal(dropFunctionOf("Unit", { itemTable: -1, itemSets: [[{}]] }, 7), "Unit000007_DropItems");
  assert.equal(dropFunctionOf("Unit", { itemTable: -1, itemSets: [[]] }, 7), undefined);
  const tables = new Set([3]);
  assert.equal(dropFunctionOf("Unit", { itemTable: 3 }, 7, tables), "ItemTable000003_DropItems");
  assert.equal(dropFunctionOf("Unit", { itemTable: 4 }, 7, tables), undefined, "a table that's gone drops nothing");
  assert.equal(dropFunctionOf("Unit", { itemTable: 4, itemSets: [[{}]] }, 7, tables), "Unit000007_DropItems", "its own sets still count");
  assert.equal(dropSection("Unit", [{ itemTable: 4, itemSets: [[{ id: "a", chance: 1 }]] }], 0, tables).includes("Unit000000_DropItems"), true);
  assert.equal(dropSection("Unit", [{ itemTable: 1, itemSets: [[{ id: "a", chance: 1 }]] }, { itemSets: [] }]), "");
});

test("random groups pick a line, and an empty slot creates nothing", () => {
  const s = randomGroupsSection([{ number: 2, name: "Creeps", positions: [0, 1], lines: [{ chance: 60, ids: ["hfoo", "0x00000000"] }, { chance: 40, ids: ["hpea", "hkni"] }] }]);
  has(s, "    // Group 2 - Creeps");
  has(s, "    call RandomDistAddItem( 1, 40 )");
  has(s, "        set gg_rg_002[0] = 'hfoo'");
  has(s, "        set gg_rg_002[1] = -1");
  has(s, "    elseif (curset == 1) then");
  assert.equal(randomGroupsSection([]), "");
});

test("a random group's random objects by level are picked as the World Editor 2.0 writes them (we-drive 2026-11-12)", () => {
  // The lines of a probe group the editor saved: its InitRandomGroups for these ids, entry by entry.
  const lines = [["YYU1", "YYB/", "YiI2"], ["YYU/", "YYB0", "YYI/"], ["YYU:", "YYBb", "YlI9"], ["YYU0", "YYUB", "YYI:"], ["YYI3", "YYBB", "YYU2"], ["Yyu1", "YYNB", "YoI0"]];
  const s = randomGroupsSection([{ number: 0, name: "Probe", positions: [0, 1, 2], lines: lines.map((ids) => ({ chance: 14, ids })) }], 7003);
  const item = (type: string, level: number) => `ChooseRandomItemExWithFilter( ITEM_TYPE_${type}, ${level}, EQUIPMENT_TYPE_ANY, ITEMTAG_TYPE_ANY )`;
  const want = [
    ["ChooseRandomCreep( 1 )", "ChooseRandomNPBuilding(  )", item("PERMANENT", 2)],
    ["ChooseRandomCreep( -1 )", "ChooseRandomNPBuilding(  )", item("ANY", -1)],
    ["ChooseRandomCreep( 10 )", "ChooseRandomNPBuilding(  )", item("ARTIFACT", 9)],
    ["ChooseRandomCreep( 0 )", "ChooseRandomCreep( 18 )", item("ANY", 10)],
    [item("ANY", 3), "ChooseRandomNPBuilding(  )", "ChooseRandomCreep( 2 )"],
    ["'Yyu1'", "'YYNB'", item("MISCELLANEOUS", 0)],
  ];
  want.forEach((entries, line) => {
    const block = [`    ${line ? "elseif" : "if"} (curset == ${line}) then`, ...entries.map((e, k) => `        set gg_rg_000[${k}] = ${e}`)].join(EOL);
    assert.ok(s.includes(block), `no block\n${block}\nin:\n${s}`);
  });
  // Older editors pick random items as their item tables do.
  has(randomGroupsSection([{ number: 0, name: "Old", positions: [2], lines: [{ chance: 100, ids: ["YjI2"] }] }], 6114), "        set gg_rg_000[0] = ChooseRandomItemEx( ITEM_TYPE_CHARGED, 2 )");
});

// ---- upgrades and tech -------------------------------------------------------------------

test("upgrades: researched levels start done, unavailable ones cap them", () => {
  const s = upgradesSection([0, 1], [
    { players: 1, id: "Rhme", level: 0, availability: 2 }, { players: 1, id: "Rhme", level: 1, availability: 2 }, { players: 1, id: "Rhme", level: 2, availability: 0 },
    { players: 2, id: "Rhar", level: 1, availability: 1 },
  ]);
  has(s, "    call SetPlayerTechResearched( Player(0), 'Rhme', 2 )");
  has(s, "    call SetPlayerTechMaxAllowed( Player(0), 'Rhme', 2 )");
  // The World Editor caps an upgrade before it marks levels researched (NightElfX01, OrcX03a).
  assert.ok(s.includes("    call SetPlayerTechMaxAllowed( Player(0), 'Rhme', 2 )" + EOL + "    call SetPlayerTechResearched( Player(0), 'Rhme', 2 )"), s);
  hasNot(s, "Player(1)");
  has(s, "    call InitUpgrades_Player0(  )");
});

test("tech: abilities are switched off, units limited to 0", () => {
  const s = techTreeSection([0], [{ players: 1, id: "hfoo" }, { players: 1, id: "AHhb" }], (id) => id.startsWith("A"));
  has(s, "    call SetPlayerTechMaxAllowed( Player(0), 'hfoo', 0 )");
  has(s, "    call SetPlayerAbilityAvailable( Player(0), 'AHhb', false )");
  assert.equal(techTreeSection([0], []), "");
});

// ---- map setup ----------------------------------------------------------------------------

const setup = (extra: object = {}, has_: object = {}): SetupInput => ({
  info: { ...info(), ...extra } as SetupInput["info"], lights: { terrain: "T.mdl", unit: "U.mdl" },
  has: { sounds: false, regions: false, cameras: false, upgrades: false, techs: false, destructables: false, items: false, randomGroups: false, units: false, triggers: true, initTriggers: false, ...has_ },
});
const player = (id: number, extra: object = {}) => ({ id, controller: 1, race: 1, fixedStart: 0, name: "P", start: [id * 100, 0], allyLow: 0, allyHigh: 0, ...extra });

test("player slots", () => {
  const s = playersSection(setup({ players: [player(0), player(3, { race: 4, controller: 2, fixedStart: 1 })] }));
  has(s, "    call SetPlayerStartLocation( Player(3), 1 )");
  has(s, "    call ForcePlayerStartLocation( Player(3), 1 )");
  has(s, "    call SetPlayerRacePreference( Player(3), RACE_PREF_NIGHTELF )");
  // World Editor 3.0.1 gives new maps 32759 and writes it as RANDOM.
  has(playersSection(setup({ players: [player(0, { hudSkin: 32759 })] })), "    call SetPlayerRaceSkin( Player(0), RACE_PREF_RANDOM )");
  has(playersSection(setup({ players: [player(0, { hudSkin: 64 })] })), "    call SetPlayerRaceSkin( Player(0), RACE_PREF_USER_SELECTABLE )");
  has(s, "    call SetPlayerController( Player(3), MAP_CONTROL_COMPUTER )");
  has(s, "    call SetPlayerRaceSelectable( Player(3), true )");
  // With fixed settings only "selectable" races can be changed.
  has(playersSection(setup({ flags: 0x20 })), "    call SetPlayerRaceSelectable( Player(0), false )");
  // Which bit 1 of the fixed start field says, not the race (we-drive save of World Editor 7003, 2026-11-09).
  const fixedSet = (race: number, fixedStart: number) => playersSection(setup({ flags: 0x60, players: [player(0, { race, fixedStart })] }));
  has(fixedSet(1, 2), "    call SetPlayerRaceSelectable( Player(0), true )");
  has(fixedSet(0, 0), "    call SetPlayerRaceSelectable( Player(0), false )");
  has(fixedSet(0, 2), "    call SetPlayerRaceSelectable( Player(0), true )");
  has(fixedSet(2, 3), "    call SetPlayerRaceSelectable( Player(0), true )");
  has(fixedSet(2, 1), "    call SetPlayerRaceSelectable( Player(0), false )");
});

test("rescuable players can be rescued by every user player", () => {
  const s = playersSection(setup({ players: [player(0), player(1, { controller: 4 })] }));
  has(s, "    call SetPlayerAlliance( Player(1), Player(0), ALLIANCE_RESCUABLE, true )");
});

test("forces: empty ones are left out, alliances go both ways", () => {
  const s = playersSection(setup({ players: [player(0), player(1)], forces: [{ flags: 0, players: 0, name: "Empty" }, { flags: 0x3, players: 3, name: "Team" }] }));
  hasNot(s, "Force: Empty");
  has(s, "    // Force: Team");
  // Teams count the forces that are written.
  has(s, "    call SetPlayerTeam( Player(0), 0 )");
  has(s, "    call SetPlayerState( Player(0), PLAYER_STATE_ALLIED_VICTORY, 1 )");
  has(s, "    call SetPlayerAllianceStateAllyBJ( Player(0), Player(1), true )");
  has(s, "    call SetPlayerAllianceStateAllyBJ( Player(1), Player(0), true )");
});

test("start location priorities the map sets itself (Modify ally priorities) exist only when set, and config calls them then", () => {
  const MODIFY = 0x2;
  const none = setup({ flags: MODIFY, players: [player(0), player(1)] });
  hasNot(playersSection(none), "InitAllyPriorities");
  hasNot(configSection(none), "InitAllyPriorities");
  const some = setup({ flags: MODIFY, players: [player(0, { allyLow: 2 }), player(1, { allyHigh: 1 })] });
  const s = playersSection(some);
  has(s, "    call SetStartLocPrioCount( 0, 1 )");
  has(s, "    call SetStartLocPrio( 0, 0, 1, MAP_LOC_PRIO_LOW )");
  has(s, "    call SetStartLocPrio( 1, 0, 0, MAP_LOC_PRIO_HIGH )");
  has(configSection(some), "    call InitAllyPriorities(  )");
});

test("without Modify ally priorities the script has the World Editor's, worked out from the user players' starts", () => {
  // A two-player copy of cliff.w3m saved by World Editor 7003 (we-drive, 2026-11-09): masks of 0 in the file, the saved
  // script gives each player the other as High.
  const two = setup({ flags: 0x9c14, players: [player(0, { start: [-1280, 1472] }), player(1, { start: [1280, -1472] })] });
  const s = playersSection(two);
  has(s, "function InitAllyPriorities takes nothing returns nothing");
  has(s, "    call SetStartLocPrioCount( 0, 1 )");
  has(s, "    call SetStartLocPrio( 0, 0, 1, MAP_LOC_PRIO_HIGH )");
  has(s, "    call SetStartLocPrioCount( 1, 1 )");
  has(s, "    call SetStartLocPrio( 1, 0, 0, MAP_LOC_PRIO_HIGH )");
  has(configSection(two), "    call InitAllyPriorities(  )");
  // Stale masks and enemy priorities in the file don't reach it; a computer player gets none (we-drive save v6).
  const stale = setup({ flags: 0x9c14, players: [player(0, { enemyHigh: 2, enemyLow: 0 }), player(1, { controller: 2, allyLow: 1 }), player(2, { start: [-150, 0] })] });
  const t = playersSection(stale);
  hasNot(t, "EnemyStartLocPrio");
  has(t, "    call SetStartLocPrio( 0, 0, 2, MAP_LOC_PRIO_HIGH )");
  has(t, "    call SetStartLocPrio( 1, 0, 0, MAP_LOC_PRIO_LOW )");
  // One player: none.
  hasNot(playersSection(setup({ flags: 0x9c14 })), "InitAllyPriorities");
});

test("main: camera bounds, tileset sound and the calls in their order", () => {
  const s = mainSection(setup({}, { units: true, regions: true, initTriggers: true }));
  assert.ok(s.includes("call SetCameraBounds( -1536.0 + GetCameraMargin(CAMERA_MARGIN_LEFT), -1280.0 + GetCameraMargin(CAMERA_MARGIN_BOTTOM), 1536.0 - GetCameraMargin(CAMERA_MARGIN_RIGHT), 1280.0 - GetCameraMargin(CAMERA_MARGIN_TOP)"));
  has(s, '    call SetAmbientDaySound( "LordaeronSummerDay" )');
  has(s, '    call NewSoundEnvironment( "Default" )');
  assert.ok(s.indexOf("CreateRegions") < s.indexOf("CreateAllUnits"));
  assert.ok(s.indexOf("CreateAllUnits") < s.indexOf("InitBlizzard"));
  assert.ok(s.indexOf("InitCustomTriggers") < s.indexOf("RunInitializationTriggers"));
  // The random groups before anything placed, as World Editor 2.0 saved a map with all four (we-drive, 2026-11-09).
  const placing = mainSection(setup({}, { techs: true, destructables: true, items: true, randomGroups: true, units: true })).split(EOL).filter((l) => /^ {4}call (Init|Create)/.test(l));
  assert.deepEqual(placing.slice(0, 5), ["InitTechTree", "InitRandomGroups", "CreateAllDestructables", "CreateAllItems", "CreateAllUnits"].map((f) => `    call ${f}(  )`));
  assert.equal(AMBIENCE.A, "Ashenvale");
  hasNot(mainSection(setup({ tileset: "?" })), "SetAmbientDaySound");
});

test("weather, fog and water tint are written only when the map switches them on", () => {
  const fog = { style: 0, start: 100, end: 2000, density: 0.5, color: [255, 128, 0, 255] };
  hasNot(mainSection(setup({ fog })), "SetTerrainFog");
  has(mainSection(setup({ fog, flags: 0x2000 })), "    call SetTerrainFogEx( 0, 100.0, 2000.0, 0.500, 0.000, 0.502, 1.000 )");
  hasNot(mainSection(setup({ waterTint: [1, 2, 3, 4] })), "SetWaterBaseColor");
  has(mainSection(setup({ waterTint: [1, 2, 3, 4], flags: 0x10000 })), "    call SetWaterBaseColor( 3, 2, 1, 4 )");
  hasNot(mainSection(setup({ weather: "0x00000000" })), "AddWeatherEffect");
  const w = mainSection(setup({ weather: "RAhr", cameraComplements: [6, 6, 4, 8] }));
  has(w, "    set we = AddWeatherEffect( Rect(-2304.0,-1792.0,2304.0,2304.0), 'RAhr' )");
  has(w, "    local weathereffect we");
});

test("placement: custom forces use the map's settings, except from old editors", () => {
  has(configSection(setup({ flags: 0x40, editorVersion: 6127 })), "    call SetGamePlacement( MAP_PLACEMENT_USE_MAP_SETTINGS )");
  has(configSection(setup({ flags: 0x40, editorVersion: 6110 })), "    call SetGamePlacement( MAP_PLACEMENT_TEAMS_TOGETHER )");
  // A melee map: teams together with more than one player; World Editor 7003 wrote USE_MAP_SETTINGS
  // for cliff.w3m (melee, one player, editorVersion 7003, flags 0x9c14), with ally priorities on too.
  has(configSection(setup({ flags: 4, editorVersion: 7003, players: [player(0), player(1)] })), "    call SetGamePlacement( MAP_PLACEMENT_TEAMS_TOGETHER )");
  has(configSection(setup({ flags: 0x9c14, editorVersion: 7003 })), "    call SetGamePlacement( MAP_PLACEMENT_USE_MAP_SETTINGS )");
  has(configSection(setup({ flags: 0x9c16, editorVersion: 7003 })), "    call SetGamePlacement( MAP_PLACEMENT_USE_MAP_SETTINGS )");
  // Old editors: always together, one player or not.
  has(configSection(setup({ flags: 4, editorVersion: 6110 })), "    call SetGamePlacement( MAP_PLACEMENT_TEAMS_TOGETHER )");
  // A World Editor save: no custom forces, not melee.
  has(configSection(setup({ flags: 0xdc10, editorVersion: 7003 })), "    call SetGamePlacement( MAP_PLACEMENT_USE_MAP_SETTINGS )");
  has(configSection(setup({ flags: 0, editorVersion: 6110 })), "    call SetGamePlacement( MAP_PLACEMENT_TEAMS_TOGETHER )");
});

test("day/night models: war3map.w3l's slots as the World Editor writes them, else the light environment's", () => {
  const env = { terrain: "Env\\T.mdl", unit: "Env\\U.mdl" };
  const w3l = (terrainModel: string, unitModel: string, terrainEnabled: number, unitEnabled: number) => ({ terrainModel, unitModel, terrainEnabled, unitEnabled });
  // cliff.w3m: both on; its script has SetDayNightModels( "2556…", "0009…" ).
  assert.deepEqual(dayNightModels(w3l("0009.mdl", "2556.mdl", 1, 1), env), { terrain: "2556.mdl", unit: "0009.mdl" });
  // we-drive saves of cliff.w3m with one slot on: the first slot goes into the unit argument.
  assert.deepEqual(dayNightModels(w3l("0009.mdl", "", 1, 0), env), { terrain: env.terrain, unit: "0009.mdl" });
  assert.deepEqual(dayNightModels(w3l("", "2556.mdl", 0, 1), env), { terrain: "2556.mdl", unit: env.unit });
  // A model that's switched off isn't written.
  assert.deepEqual(dayNightModels(w3l("0009.mdl", "2556.mdl", 1, 0), env), { terrain: env.terrain, unit: "0009.mdl" });
  assert.deepEqual(dayNightModels(w3l("0009.mdl", "2556.mdl", 0, 1), env), { terrain: "2556.mdl", unit: env.unit });
  assert.deepEqual(dayNightModels(w3l("", "", 0, 0), env), env);
  assert.deepEqual(dayNightModels(null, env), env);
});

test("config: players, teams and how the lobby sets them up", () => {
  const s = configSection(setup({ flags: 4, players: [player(0), player(1, { controller: 2 })] }));
  has(s, "    call SetPlayers( 2 )");
  has(s, "    call DefineStartLocation( 1, 100.0, 0.0 )");
  has(s, "    call SetGamePlacement( MAP_PLACEMENT_TEAMS_TOGETHER )");
  has(s, "    call SetPlayerSlotAvailable( Player(1), MAP_CONTROL_COMPUTER )");
  has(s, "    call InitGenericPlayerSlots(  )");
  const forces = configSection(setup({ flags: 0x40 }));
  has(forces, "    call SetGamePlacement( MAP_PLACEMENT_USE_MAP_SETTINGS )");
  has(forces, "    call InitCustomTeams(  )");
  hasNot(forces, "InitGenericPlayerSlots");
});

// ---- sounds -------------------------------------------------------------------------------

const sound = (extra: object = {}) => ({
  name: "gg_snd_S", file: "Sound\\x.wav", eaxEffect: "DefaultEAXON", flags: 0, fadeInRate: 10, fadeOutRate: 12, volume: 100, pitch: 1, pitchVariance: 1, priority: 0, channel: 2,
  minDistance: 100, maxDistance: 1000, distanceCutoff: 3000, coneInside: 0, coneOutside: 0, coneOutsideVolume: 127, coneOrientation: [0, 0, 1], ...extra,
});
const soundSection = (extra: object, more: Partial<ScriptInput> = {}) => generateSections(input({ sounds: [sound(extra)] as never, ...more })).get("Sound Assets")!;

test("sounds: created, then only what's set", () => {
  const s = soundSection({ flags: 1 | 2 });
  has(s, '    set gg_snd_S = CreateSound( "Sound\\\\x.wav", true, true, false, 10, 12, "DefaultEAXON" )');
  has(s, "    call SetSoundChannel( gg_snd_S, 2 )");
  has(s, "    call SetSoundPitch( gg_snd_S, 1.0 )");
  has(s, "    call SetSoundDistances( gg_snd_S, 100.0, 1000.0 )");
  // Distances are for 3D sounds; unset values are 2^32.
  hasNot(soundSection({}), "SetSoundDistances");
  hasNot(soundSection({ pitch: 4294967300 }), "SetSoundPitch");
});

test("music is only its file path", () => {
  has(soundSection({ flags: 8 }), '    set gg_snd_S = "Sound\\\\x.wav"');
  assert.ok(generateSections(input({ sounds: [sound({ flags: 8 })] as never })).get("Global Variables")!.includes(`${"string".padEnd(24)}gg_snd_S`));
});

test("a labelled sound writes only what the label doesn't set", () => {
  const label = () => ({ channel: 2, pitch: 1, minDistance: 100, maxDistance: 1000, distanceCutoff: 3000 });
  const s = soundSection({ assetLabel: "Rain", flags: 2 }, { soundLabel: label });
  has(s, '    call SetSoundParamsFromLabel( gg_snd_S, "Rain" )');
  has(s, "    call SetSoundVolume( gg_snd_S, 100 )");
  for (const f of ["SetSoundChannel", "SetSoundPitch", "SetSoundDistances", "SetSoundDistanceCutoff"]) hasNot(s, f);
});

test("a sound's length comes from outside, if known", () => {
  has(soundSection({}, { soundDuration: () => 1234 }), "    call SetSoundDuration( gg_snd_S, 1234 )");
  hasNot(soundSection({}), "SetSoundDuration");
});

test("dialogue keys: all of a spoken dialogue, else those set from editor 7000 on", () => {
  const keys = (extra: object, editorVersion = 6127) => soundSection({ dialogueTextKey: 60, speakerNameKey: -1, speakerUnitType: "", unknown2: 1, ...extra }, { info: info({ editorVersion }) });
  // Undead04 / HumanX04 of editor 6127: nothing; the same sounds in the 7003 versions: the key set.
  hasNot(keys({}), "SetDialogue");
  has(keys({}, 7003), '    call SetDialogueTextKey( gg_snd_S, "TRIGSTR_60" )');
  hasNot(keys({}, 7003), "SetDialogueSpeakerNameKey");
  // OrcX02_02: a speaker unit type with the word at 0 writes both keys, -1 too.
  const spoken = keys({ dialogueTextKey: -1, speakerNameKey: 370, speakerUnitType: "Hjai", unknown2: 0 });
  has(spoken, '    call SetDialogueSpeakerNameKey( gg_snd_S, "TRIGSTR_370" )');
  has(spoken, '    call SetDialogueTextKey( gg_snd_S, "TRIGSTR_-1" )');
  // A sound with the word at 0 and no dialogue (Studio's Sound Editor made such sounds before 2026-11): nothing.
  hasNot(keys({ dialogueTextKey: -1, unknown2: 0 }, 7003), "SetDialogue");
});

test("the script's sound lengths: per sound, so sounds of one unreadable file keep their own (Roundabout)", () => {
  const jass = [
    '    set gg_snd_A = CreateSound( "---Invalid Sound Filepath---", false, false, false, 12700, 12700, "DefaultEAXON" )',
    "    call SetSoundDuration( gg_snd_A, 6630 )",
    '    set gg_snd_B = CreateSound( "---Invalid Sound Filepath---", false, false, false, 12700, 12700, "DefaultEAXON" )',
    "    call SetSoundDuration( gg_snd_B, 5678 )",
    '    set gg_snd_C = CreateSound( "Sound\\\\Dialogue\\\\C.wav", false, false, false, 10, 10, "DefaultEAXON" )',
    "    call SetSoundDuration( gg_snd_C, 4319 )",
  ].join("\r\n");
  const d = scriptSoundDurations(jass);
  assert.equal(d("---Invalid Sound Filepath---", "gg_snd_A"), 6630);
  assert.equal(d("---Invalid Sound Filepath---", "gg_snd_B"), 5678);
  assert.equal(d("Sound\\Dialogue\\C.wav", "gg_snd_C"), 4319, "the path's escapes undone");
  // A new sound, or one that plays another file now: the length its file had.
  assert.equal(d("---Invalid Sound Filepath---", "gg_snd_New"), 5678);
  assert.equal(d("Sound\\Dialogue\\C.wav", "gg_snd_A"), 4319);
  assert.equal(d("Other.wav", "gg_snd_C"), undefined);
  // Lua.
  const lua = scriptSoundDurations('gg_snd_A = CreateSound("x.flac", false, false, false, 10, 10, "")\r\nSetSoundDuration(gg_snd_A, 99)');
  assert.equal(lua("x.flac", "gg_snd_A"), 99);
  // Into the script, per sound.
  const two = generateSections(input({ sounds: [sound({ name: "gg_snd_A", file: "f" }), sound({ name: "gg_snd_B", file: "f" })] as never, soundDuration: (_f: string, n: string) => (n === "gg_snd_A" ? 1 : 2) })).get("Sound Assets")!;
  has(two, "    call SetSoundDuration( gg_snd_A, 1 )");
  has(two, "    call SetSoundDuration( gg_snd_B, 2 )");
});

test("sound labels come from the tables, first row wins", () => {
  const slk = (pitch: number) => `ID;PWXL;N;E\nC;Y1;X1;K"SoundName"\nC;X2;K"Channel"\nC;X3;K"Pitch"\nC;X4;K"MinDistance"\nC;X5;K"MaxDistance"\nC;X6;K"DistanceCutoff"\nC;Y2;X1;K"Rain"\nC;X2;K1\nC;X3;K${pitch}\nC;X4;K0\nC;X5;K100\nC;X6;K50\nE\n`;
  const l = parseSoundLabels([slk(1), slk(2)]);
  assert.deepEqual(l.get("Rain"), { channel: 1, pitch: 1, minDistance: 0, maxDistance: 100, distanceCutoff: 50 });
});

// ---- regions and cameras ------------------------------------------------------------------

test("a region with an ambient sound places it on the ground at its centre", () => {
  const s = generateSections(input({ regions: [{ name: "Lake", index: 0, left: 0, bottom: 0, right: 100, top: 50, weather: "RAhr", sound: "gg_snd_W" }], groundHeight: (x, y) => x + y })).get("Regions")!;
  has(s, "    set gg_rct_Lake = Rect( 0.0, 0.0, 100.0, 50.0 )");
  has(s, "    set we = AddWeatherEffect( gg_rct_Lake, 'RAhr' )");
  has(s, "    call SetSoundPosition( gg_snd_W, 50.0, 25.0, 75.0 )");
  has(s, "    call RegisterStackedSound( gg_snd_W, true, 100.0, 50.0 )");
});

test("cameras of the old file format have fewer fields", () => {
  const cam = { name: "C", targetX: 0, targetY: 0, zOffset: 0, rotation: 0, angleOfAttack: 0, distance: 0, roll: 0, fieldOfView: 0, farZ: 0, nearZ: 0 };
  const old = generateSections(input({ cameras: [cam] })).get("Cameras")!;
  for (const f of ["DEPTH_OF_FIELD", "ZABSOLUTE", "BlzCameraSetupSetCameraType"]) hasNot(old, f);
  has(old, "    call CameraSetupSetDestPosition( gg_cam_C, 0.0, 0.0, 0.0 )");
  const now = generateSections(input({ cameras: [{ ...cam, unknown: [1, 2, 3], trailer: 1 }] })).get("Cameras")!;
  has(now, "    call CameraSetupSetField( gg_cam_C, CAMERA_FIELD_ZABSOLUTE, 3.0, 0.0 )");
  has(now, "    call BlzCameraSetupSetCameraType( gg_cam_C, 1 )");
  // As the codec names them now (DoF Distance, DoF Scale, Pos Absolute Z).
  const named = generateSections(input({ cameras: [{ ...cam, dofDistance: 0, dofScale: 123, posAbsoluteZ: 2.5, trailer: 0 }] })).get("Cameras")!;
  has(named, "    call CameraSetupSetField( gg_cam_C, CAMERA_FIELD_DEPTH_OF_FIELD_SCALE, 123.0, 0.0 )");
  has(named, "    call CameraSetupSetField( gg_cam_C, CAMERA_FIELD_ZABSOLUTE, 2.5, 0.0 )");
  has(named, "    call BlzCameraSetupSetCameraType( gg_cam_C, 0 )");
});

test("camera fields round like the rest", () => {
  const s = generateSections(input({ cameras: [{ name: "Intro", targetX: 7468.25, targetY: 0, zOffset: 0, rotation: 185.25, angleOfAttack: 304, distance: 1650, roll: 0, fieldOfView: 70, farZ: 5000, nearZ: 16 }] })).get("Cameras")!;
  has(s, "    call CameraSetupSetField( gg_cam_Intro, CAMERA_FIELD_ROTATION, 185.2, 0.0 )");
  has(s, "    call CameraSetupSetDestPosition( gg_cam_Intro, 7468.2, 0.0, 0.0 )");
});

// ---- triggers -----------------------------------------------------------------------------

const compile = (items: TriggerItem[], custom: { texts: (string | null)[] } | null = null) =>
  triggersSection({ data, triggers: wtg(items), custom: custom as never });
const equals = eca(1, "OperatorCompareInteger", [{ type: 3, value: "1" }, { type: 0, value: "OperatorEqualENE" }, { type: 3, value: "2" }]);

test("a trigger becomes conditions, actions and its init function", () => {
  const s = compile([trigger("Spawn Wave", [eca(0, "MapInitializationEvent"), equals, eca(2, "DoNothing")])]);
  has(s, "function Trig_Spawn_Wave_Conditions takes nothing returns boolean");
  has(s, "    if ( not ( 1 == 2 ) ) then");
  has(s, "function Trig_Spawn_Wave_Actions takes nothing returns nothing");
  has(s, "    call DoNothing(  )");
  has(s, "function InitTrig_Spawn_Wave takes nothing returns nothing");
  has(s, "    set gg_trg_Spawn_Wave = CreateTrigger(  )");
  has(s, "    call InitTrig_Spawn_Wave(  )");
  has(s, "    call ConditionalTriggerExecute( gg_trg_Spawn_Wave )");
});

test("a trigger's comment: the first line even when empty, later empty lines dropped", () => {
  // Human05's "Corruption03 QUE", Skibi's Castle TD's "ARC Detect Mana Constant".
  const c = compile([trigger("Q", [], { description: "\r\nCreate 4 Zombies\r\n\r\nRun Trigger Orange Town\r\n" }), trigger("Blank", [], { description: "\r\n\r\n\r\n\r\n", id: 1 })]);
  assert.ok(c.includes(["// Trigger: Q", "//", "// ", "// Create 4 Zombies", "// Run Trigger Orange Town", "//" + "=".repeat(75)].join(EOL)), c);
  assert.ok(c.includes(["// Trigger: Blank", "//", "// ", "//" + "=".repeat(75)].join(EOL)), c);
  const plain = compile([trigger("M", [], { description: "MAP INTIALIZATION\r\n\r\n" })]);
  assert.ok(plain.includes(["// Trigger: M", "//", "// MAP INTIALIZATION", "//" + "=".repeat(75)].join(EOL)), plain);
});

test("an initially off trigger with a map initialization event isn't run at the start", () => {
  // NightElf05's "The Dragons", UndeadX08's "Change the Icon".
  const s = compile([trigger("On", [eca(0, "MapInitializationEvent")]), trigger("Off", [eca(0, "MapInitializationEvent")], { initiallyOff: true, id: 1 })]);
  has(s, "    call ConditionalTriggerExecute( gg_trg_On )");
  hasNot(s, "ConditionalTriggerExecute( gg_trg_Off )");
  // Alone, there is nothing to run: main doesn't call it either.
  const only = generateScript(input({ triggers: wtg([trigger("Off", [eca(0, "MapInitializationEvent")], { initiallyOff: true })]) }));
  hasNot(only, "RunInitializationTriggers");
  const off = trigger("Off", [eca(0, "MapInitializationEvent"), eca(2, "DoNothing")], { initiallyOff: true });
  convertToCustom(off);
  assert.equal(off.runOnInit, false, "converted, it isn't run either");
});

test("children left on a Set Variable still get their helper functions", () => {
  // Skibi's Castle TD: a ForGroup under a Set Variable; the World Editor writes its callback, never calls it.
  const pick = eca(2, "ForGroup", [{ type: 3, value: "1" }, { type: 2, value: "DoNothing", call: { kind: 2, name: "KillUnit", hasParams: true, params: [{ type: 3, value: "2" }], trailer: 0 } } as never], { group: 0 });
  const t = trigger("Run", [eca(2, "SetVariable", [{ type: 1, value: "x" }, { type: 3, value: "1" }], { children: [pick] })]);
  const s = compile([t]);
  has(s, "function Trig_Run_Func001Func001002 takes nothing returns nothing");
  hasNot(s, "call Trig_Run_Func001Func001002");
});

test("disabled triggers and comments aren't compiled", () => {
  const s = compile([trigger("Off", [], { enabled: false }), trigger("Note", [], { isComment: 1 })]);
  hasNot(s, "Trig_Off");
  hasNot(s, "InitTrig_Off");
  hasNot(s, "InitTrig_Note");
});

test("custom text stays as written; without an InitTrig it's a library", () => {
  const items = [trigger("Lib", [], { isCustom: true }), trigger("Own", [], { isCustom: true })];
  const s = compile(items, { texts: ["function Helper takes nothing returns nothing\nendfunction", "function InitTrig_Own takes nothing returns nothing\nendfunction"] });
  has(s, "function Helper takes nothing returns nothing");
  hasNot(s, "InitTrig_Lib");
  has(s, "    call InitTrig_Own(  )");
});

test("Convert to Custom Text: the trigger's functions as the World Editor writes them, without the banner", () => {
  const t = trigger("Melee Init", [eca(0, "MapInitializationEvent"), eca(2, "DoNothing")]);
  const text = triggerCustomText({ data, triggers: wtg([t]) }, t);
  assert.equal(text, [
    "function Trig_Melee_Init_Actions takes nothing returns nothing", "    call DoNothing(  )", "endfunction", "",
    "//===========================================================================",
    "function InitTrig_Melee_Init takes nothing returns nothing", "    set gg_trg_Melee_Init = CreateTrigger(  )",
    "    call TriggerAddAction( gg_trg_Melee_Init, function Trig_Melee_Init_Actions )", "endfunction", "",
  ].join(EOL));
  convertToCustom(t);
  assert.deepEqual([t.isCustom, t.ecas, t.runOnInit], [true, [], true], "the map initialization event becomes Run on Map Initialization");
  const lua = triggerCustomText({ data, triggers: wtg([trigger("Melee Init", [eca(2, "DoNothing")])]), lua: true }, trigger("Melee Init", [eca(2, "DoNothing")]));
  assert.deepEqual(lua.split(EOL), ["function Trig_Melee_Init_Actions()", "DoNothing()", "end", "", "function InitTrig_Melee_Init()", "gg_trg_Melee_Init = CreateTrigger()",
    "TriggerAddAction(gg_trg_Melee_Init, Trig_Melee_Init_Actions)", "end", "", ""]);
  const plain = trigger("Later", [eca(2, "DoNothing")]);
  convertToCustom(plain);
  assert.equal(plain.runOnInit, false, "without the event it isn't run at the start");
});

test("placed objects that custom text names keep their globals, as the World Editor reads custom text for them", () => {
  // As World Editor 2.0 saved a converted trigger that still kills footman 0003 (we-drive, 2026-11-09).
  const units = [unit({ editorId: 3 }), unit({ editorId: 4, position: [400, 0, 0] }), unit({ editorId: 5, position: [800, 0, 0] }), unit({ editorId: 6, position: [900, 0, 0] })];
  const custom = (header: string, on: string, off: string) => ({ reforged: false, version: 1, comment: "", header, texts: [on, off] });
  const sections = (c: ReturnType<typeof custom>, triggers = wtg([trigger("Use", [], { isCustom: true }), trigger("Off", [], { isCustom: true, enabled: false, id: 1 })])) =>
    generateSections(input({ triggers, custom: c, units: units as unknown as PlacedJson[], kindOf: () => "unit" }));
  const s = sections(custom("// gg_unit_hfoo_0005 in the header", "call KillUnit( gg_unit_hfoo_0003 )", "call KillUnit( gg_unit_hfoo_0004 )"));
  const g = s.get("Global Variables")!, made = s.get("Unit Creation")!;
  for (const n of ["0003", "0004", "0005"]) assert.ok(g.includes(`gg_unit_hfoo_${n} `), `gg_unit_hfoo_${n} declared`);
  hasNot(g, "gg_unit_hfoo_0006");
  has(made, "    set gg_unit_hfoo_0003 = BlzCreateUnitWithSkin( p, 'hfoo', 100.0, 200.0, 0.000, 'hfoo' )");
  has(made, "    set gg_unit_hfoo_0005 = BlzCreateUnitWithSkin( p, 'hfoo', 800.0, 0.0, 0.000, 'hfoo' )");
  // A disabled trigger's text declares, but isn't compiled: nothing is created into it (as for GUI triggers).
  has(made, "    set u = BlzCreateUnitWithSkin( p, 'hfoo', 400.0, 0.0, 0.000, 'hfoo' )");
  // Without the names, no globals: the text of a GUI trigger's slot isn't read either.
  const none = sections(custom("", "call KillUnit( u )", "gg_unit_hfoo_0004"), wtg([trigger("Use", [], { isCustom: true }), trigger("Gui", [], { id: 1 })]));
  hasNot(none.get("Global Variables")!, "gg_unit_hfoo");
  hasNot(none.get("Unit Creation")!, "gg_unit_hfoo");
  // The whole name: a longer identifier isn't the global.
  hasNot(sections(custom("", "call KillUnit( xgg_unit_hfoo_0003 )", "")).get("Global Variables")!, "gg_unit_hfoo_0003");
});

// ---- Lua ----------------------------------------------------------------------------------

test("JASS expressions in Lua", () => {
  assert.equal(expr("a != null"), "a ~= nil");
  assert.equal(expr("CreateUnit( p, 'hfoo', 1, 2 )"), 'CreateUnit(p, FourCC("hfoo"), 1, 2)');
  assert.equal(expr("TimerStart( t, 1.0, false, function F )"), "TimerStart(t, 1.0, false, F)");
  assert.equal(expr(`a ${CONCAT} b ${INT_DIV} c`), "a .. b // c");
});

test("what's inside a string stays as it is", () => {
  assert.equal(expr(`Print( "null != 'hfoo'" )`), `Print("null != 'hfoo'")`);
  assert.equal(expr(`Print( "say \\"null\\"", null )`), `Print("say \\"null\\"", nil)`);
});

test("a JASS script becomes Lua line by line", () => {
  const lua = jassToLua([
    "globals", "    integer array udg_A", "    unit udg_U = null", "    integer udg_N = 0", "endglobals",
    "function F takes integer a, unit b returns nothing", "    local integer i", "    local real r = 1.5", "    call G( a )", "    set i = 1", "    loop", "        exitwhen i > 3", "    endloop", "    if ( a ) then", "    endif", "endfunction",
  ].join(EOL));
  assert.deepEqual(lua.split(EOL), ["udg_A = __jarray(0)", "udg_U = nil", "udg_N = 0", "function F(a, b)", "local i", "local r = 1.5", "", "G(a)", "i = 1", "while (true) do", "if (i > 3) then break end", "end", "if (a) then", "end", "end", "", ""]);
});

test("Lua that's marked as the map's own is copied untouched", () => {
  assert.equal(jassToLua(`${RAW}local x <const> = 'a' -- != null`), `local x <const> = 'a' -- != null${EOL}`);
});

test("a Lua map gets war3map.lua, with its own code left alone", () => {
  const lua = generateScript(input({ info: info({ scriptType: 1 }), custom: { reforged: false, version: 1, comment: "", header: "local mine = 'x'", texts: [] }, triggers: wtg([]) }));
  assert.ok(lua.includes("local mine = 'x'"));
  assert.ok(lua.includes("function main()"));
  hasNot(lua, "takes nothing");
});

// What the World Editor's war3map.lua writes differently from a word-for-word translation (we-drive on HumanX02,
// UndeadX03, NightElfX03 and a synthetic map, 2026-11-12).
const luaData = parseTriggerData(`
[TriggerTypes]
integer=0,1,1,Integer
real=0,1,1,Real
string=0,1,1,String
skymodelstring=0,0,0,Sky,string
[TriggerParams]
OperatorEqualENE=0,ComparisonOperator,==,Equal
SkyModelNone=0,skymodelstring,null,None
[TriggerEvents]
MapInitializationEvent=0,nothing
[TriggerConditions]
OperatorCompareInteger=0,integer,ComparisonOperator,integer
OrMultiple=0,nothing
[TriggerActions]
SetSkyModel=0,skymodelstring
ReturnAction=0,nothing
`);
const luaScript = (triggers: TriggerFile, extra: Partial<ScriptInput> = {}) =>
  generateScript(input({ data: luaData, info: info({ scriptType: 1 }), triggers, ...extra }));
const jassScript = (triggers: TriggerFile, extra: Partial<ScriptInput> = {}) => generateScript(input({ data: luaData, triggers, ...extra }));

test("Lua: reals start at 0.0 and strings at \"\", in the declaration and InitGlobals", () => {
  const triggers = { ...wtg([]), variables: [variable("R", "real"), variable("S", "string"), variable("T", "string", { initialized: true, initialValue: "a" }), variable("N", "integer")] };
  const lua = luaScript(triggers);
  const decl = lua.slice(0, lua.indexOf("function InitGlobals")), init = lua.slice(lua.indexOf("function InitGlobals"));
  has(decl, "udg_R = 0.0");
  has(decl, 'udg_S = ""');
  has(decl, 'udg_T = ""');
  has(decl, "udg_N = 0");
  has(init, "udg_R = 0.0");
  has(init, 'udg_S = ""');
  has(init, 'udg_T = "a"');
  // war3map.j keeps 0 and declares the string without a value (the game's 326 JASS maps).
  const jass = jassScript(triggers);
  has(jass, `    ${"real".padEnd(24)}${"udg_R".padEnd(26)} = 0`);
  has(jass, `    ${"string".padEnd(24)}udg_S`);
  has(jass, "    set udg_R = 0");
});

test("Lua: a string preset of null is \"\" (SetSkyModel(\"\"))", () => {
  const t = trigger("Sky", [eca(2, "SetSkyModel", [{ type: 0, value: "SkyModelNone" }])]);
  has(luaScript(wtg([t])), 'SetSkyModel("")');
  has(jassScript(wtg([t])), "    call SetSkyModel( null )");
});

test("Lua: an Or condition's comparison has one pair of parentheses", () => {
  const cmp = (v: string) => eca(1, "OperatorCompareInteger", [{ type: 3, value: v }, { type: 0, value: "OperatorEqualENE" }, { type: 3, value: "2" }], { group: 0 });
  const t = trigger("Or", [eca(1, "OrMultiple", [], { children: [cmp("1"), cmp("3")] }), eca(1, "OperatorCompareInteger", [{ type: 3, value: "4" }, { type: 0, value: "OperatorEqualENE" }, { type: 3, value: "5" }])]);
  const lua = luaScript(wtg([t]));
  has(lua, "if (1 == 2) then");
  has(lua, "if (3 == 2) then");
  // The And form keeps its not ( … ).
  has(lua, "if (not (4 == 5)) then");
  has(jassScript(wtg([t])), "    if ( ( 1 == 2 ) ) then");
});

test("Lua: Skip Remaining Actions is \"return \", with the World Editor's space", () => {
  const lua = luaScript(wtg([trigger("Skip", [eca(2, "ReturnAction")])]));
  has(lua, "return ");
  assert.ok(!lua.split(EOL).includes("return"), lua);
  has(jassScript(wtg([trigger("Skip", [eca(2, "ReturnAction")])])), "    return");
});

test("an initially off trigger with Run on Map Initialization isn't run at the start either", () => {
  const items = [trigger("On", [eca(0, "MapInitializationEvent")], { runOnInit: true }), trigger("Off", [eca(0, "MapInitializationEvent")], { initiallyOff: true, runOnInit: true, id: 1 })];
  for (const s of [jassScript(wtg(items)), luaScript(wtg(items))]) {
    assert.ok(/ConditionalTriggerExecute\( ?gg_trg_On ?\)/.test(s), s);
    hasNot(s, "ConditionalTriggerExecute( gg_trg_Off )");
    hasNot(s, "ConditionalTriggerExecute(gg_trg_Off)");
  }
});

test("a header of only spaces is kept as a line; one of only line breaks makes nothing", () => {
  const custom = (header: string) => ({ reforged: true, version: 1, comment: "", header, texts: [] });
  const regions = [{ name: "R", index: 0, left: 0, bottom: 0, right: 1, top: 1, weather: "", sound: "" }];
  const lua = luaScript(wtg([trigger("T", [])]), { custom: custom("   "), regions });
  // After the objects, before the triggers (R3A, World Editor 2026-11-12).
  const lines = lua.split(EOL), at = lines.indexOf("   ");
  assert.ok(at > lines.indexOf("function CreateRegions()") && at < lines.indexOf("function Trig_T_Actions()"), lua);
  assert.equal(jassScript(wtg([]), { custom: custom("   "), regions }).split("//*  Custom Script Code").length, 3);
  assert.equal(jassScript(wtg([]), { custom: custom("\r\n"), regions }).split("//*  Custom Script Code").length, 2);
});
