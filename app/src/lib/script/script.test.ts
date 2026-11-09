// Known answers for the map script generator. The expected lines are the World Editor's own forms;
// the whole of it is compared with real output by scripts/script-check.

import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTriggerData } from "../triggers/triggerdata";
import type { Eca, TriggerFile, TriggerItem } from "../triggers/wtg";
import { destructablesSection, type DestructableJson } from "./destructables";
import { dropFunction, dropFunctionOf, dropSection, itemTableFunction, randomGroupsSection } from "./drops";
import { banner, generateScript, generateSections, header, ident, literal, parseSoundLabels, placedName, splitSections, str, type PlacedJson, type ScriptInput } from "./jass";
import { CONCAT, expr, INT_DIV, jassToLua, RAW } from "./lua";
import { abilityOrders, gameTeamColors, specialUnits, teamColors } from "./objects";
import { AMBIENCE, configSection, dayNightModels, mainSection, playersSection, type SetupInput } from "./setup";
import { techTreeSection, upgradesSection } from "./techs";
import { convertToCustom, placedGlobalsOnlyIn, triggerCustomText, triggersSection } from "./triggers";
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

test("a map can take a type's team colour away", () => {
  const c = teamColors([{ original: [{ base: "ntav", mods: [{ field: "utco", value: -1 }] }], custom: [{ id: "n000", base: "nmr2", mods: [{ field: "utco", value: -1 }] }, { id: "n001", base: "ntav" }] }], new Map([["ntav", 0], ["nmr2", 12]]));
  assert.equal(c.has("ntav"), false);
  assert.equal(c.has("n000"), false);
  assert.equal(c.has("n001"), false);
  assert.equal(c.get("nmr2"), 12);
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

test("items are created by type, then by number", () => {
  const s = items([unit({ id: "zzzz", editorId: 1 }), unit({ id: "ratc", editorId: 9 }), unit({ id: "ratc", editorId: 2, position: [7, 0, 0] })]);
  assert.ok(s.indexOf("'ratc', 7.0") < s.indexOf("'ratc', 100.0"));
  assert.ok(s.indexOf("'ratc', 100.0") < s.indexOf("'zzzz'"));
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
  // Coloured (newer editors) inside the if.
  has(items([unit({ id: "iDNR", randomType: 1, randomGroup: 0, randomPosition: 0 })], 7003), "        call BlzSetItemColor( i, ConvertPlayerColor(0) )");
});

test("newer editors colour every item", () => {
  hasNot(items([unit()]), "ItemColor");
  has(items([unit()], 7000), "    call SetItemColor( i, ConvertPlayerColor(0) )");
  has(items([unit()], 7003), "    call BlzSetItemColor( i, ConvertPlayerColor(0) )");
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

// ---- upgrades and tech -------------------------------------------------------------------

test("upgrades: researched levels start done, unavailable ones cap them", () => {
  const s = upgradesSection([0, 1], [
    { players: 1, id: "Rhme", level: 0, availability: 2 }, { players: 1, id: "Rhme", level: 1, availability: 2 }, { players: 1, id: "Rhme", level: 2, availability: 0 },
    { players: 2, id: "Rhar", level: 1, availability: 1 },
  ]);
  has(s, "    call SetPlayerTechResearched( Player(0), 'Rhme', 2 )");
  has(s, "    call SetPlayerTechMaxAllowed( Player(0), 'Rhme', 2 )");
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

test("the placed objects whose globals only a trigger keeps", () => {
  const kill = (g: string, extra: Partial<Eca> = {}) => eca(2, "KillUnit", [{ type: 1, value: g }], extra);
  const a = trigger("A", [kill("gg_unit_hfoo_0001"), kill("gg_unit_hfoo_0002"), kill("gg_unit_hfoo_0003"), kill("udg_x")]);
  const b = trigger("B", [kill("gg_unit_hfoo_0002")]);
  const off = trigger("Off", [kill("gg_unit_hfoo_0003")], { enabled: false });
  // 0002 stays (B uses it); 0003 stays declared (Off mentions it) but is no longer created into it.
  assert.deepEqual(placedGlobalsOnlyIn(wtg([a, b, off]), a), ["gg_unit_hfoo_0001", "gg_unit_hfoo_0003"]);
  assert.deepEqual(placedGlobalsOnlyIn(wtg([a, b, off]), b), []);
  assert.deepEqual(placedGlobalsOnlyIn(wtg([a, b, off]), off), []);
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
