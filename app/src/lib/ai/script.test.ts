// The checker reads each generated script against a stand-in for common.j and common.ai, so a call
// that isn't there, a wrong argument or an unclosed block fails. The scripts the game ships were edited
// by hand after their export, so there's no real file to compare with; the layout rules below are
// the ones in script.ts's header.

import assert from "node:assert/strict";
import { test } from "node:test";
import { checkJass, envFrom } from "../jass/check";
import { CALL, CONDITION, parseTriggerData } from "../triggers/triggerdata";
import { conditionGlobal, conditionJass, generateAiScript } from "./script";
import { newWai, NO_ID, type AiCondition, type AiFile } from "./wai";

const data = parseTriggerData(`
[TriggerParams]
OperatorGreater=0,ComparisonOperator,>,Greater
[TriggerConditions]
OperatorCompareInteger=0,integer,ComparisonOperator,integer
OperatorCompareBoolean=0,boolean,ComparisonOperator,boolean
[TriggerCalls]
GetBooleanAnd=0,0,boolean,boolean,boolean
GetBooleanOr=0,0,boolean,boolean,boolean
GetUnitCountDoneAI=0,0,integer,unitcode
_GetUnitCountDoneAI_ScriptName=GetUnitCountDone
TownCountAI=0,0,integer
_TownCountAI_ScriptName=GetHeroLevelAI
SayIt=0,0,boolean,string
OperatorInt=0,0,integer,integer,ArithmeticOperator,integer
`);

const API = `
type unit extends handle
type player extends handle
type code extends handle
type playerstate extends handle
constant integer BUILD_UNIT = 1
constant integer BUILD_UPGRADE = 2
integer hero_id = 0
integer hero_id2 = 0
integer hero_id3 = 0
boolean take_exp = false
integer max_hero_level = 0
player ai_player = null
playerstate PLAYER_STATE_RESOURCE_FOOD_CAP = null
integer array skills1
integer array skills2
integer array skills3
native GetLastCommand takes nothing returns integer
native GetLastData takes nothing returns integer
native PopLastCommand takes nothing returns boolean
native GetPlayerState takes player p, playerstate s returns integer
native HallsCompleted takes integer id returns boolean
native SetBuildExpa takes integer town, integer id returns nothing
native TownCount takes integer id returns integer
native InitAssaultGroup takes nothing returns nothing
native SetAssaultGroup takes integer a, integer b, integer id returns nothing
native SetMeleeAI takes nothing returns nothing
native SetCampaignAI takes nothing returns nothing
native SetDefendPlayer takes boolean b returns nothing
native SetRandomPaths takes boolean b returns nothing
native SetTargetHeroes takes boolean b returns nothing
native SetPeonsRepair takes boolean b returns nothing
native SetHeroesFlee takes boolean b returns nothing
native SetHeroesBuyItems takes boolean b returns nothing
native SetUnitsFlee takes boolean b returns nothing
native SetGroupsFlee takes boolean b returns nothing
native SetWatchMegaTargets takes boolean b returns nothing
native SetIgnoreInjured takes boolean b returns nothing
native SetHeroesTakeItems takes boolean b returns nothing
native SetSlowChopping takes boolean b returns nothing
native SetCaptainChanges takes boolean b returns nothing
native SetSmartArtillery takes boolean b returns nothing
native SetPlayerName takes player p, string s returns nothing
native GetRandomInt takes integer a, integer b returns integer
native GetHeroId takes nothing returns integer
native GetHeroLevelAI takes nothing returns integer
native TownWithMine takes nothing returns integer
native SetBuildAll takes integer t, integer n, integer id, integer town returns nothing
native GetUnitCountDone takes integer id returns integer
native HarvestGold takes integer town, integer n returns nothing
native HarvestWood takes integer town, integer n returns nothing
native ClearHarvestAI takes nothing returns nothing
native InitBuildArray takes nothing returns nothing
native Sleep takes real r returns nothing
native SetAllianceTarget takes unit u returns nothing
native GetAllianceTarget takes nothing returns unit
native FormGroup takes integer n, boolean b returns nothing
native AttackMoveKillA takes unit u returns nothing
native TownThreatened takes nothing returns boolean
native GetExpansionFoe takes nothing returns unit
native GetMegaTarget takes nothing returns unit
native GetEnemyExpansion takes nothing returns unit
native StartGetEnemyBase takes nothing returns nothing
native WaitGetEnemyBase takes nothing returns boolean
native SuicideSleep takes integer n returns nothing
native GetEnemyBase takes nothing returns unit
native GetCreepCamp takes integer a, integer b, boolean c returns unit
native PurchaseZeppelin takes nothing returns nothing
native StaggerSleep takes real a, real b returns nothing
native CaptainRetreating takes nothing returns boolean
native RemoveInjuries takes nothing returns nothing
native InitAI takes nothing returns nothing
native CreateCaptains takes nothing returns nothing
native SetHeroLevels takes code c returns nothing
native StartThread takes code c returns nothing
native PlayGame takes nothing returns nothing
`;
const globals = API.split("\n").filter((l) => /^(constant |integer |boolean |player |playerstate )/.test(l));
const rest = API.split("\n").filter((l) => !globals.includes(l));
const env = envFrom([`${rest.join("\n")}\nglobals\n${globals.join("\n")}\nendglobals\n`]);

const errors = (script: string) => checkJass(script, env).filter((d) => d.severity === "error").map((d) => `${d.message}: ${script.slice(d.from, d.to)}`);
const script = (ai: AiFile) => generateAiScript(ai, data, "the date");
/** The body of one generated function, lines without their end. */
const fnBody = (text: string, name: string) => {
  const lines = text.split("\r\n"), from = lines.findIndex((l) => l.startsWith(`function ${name} `));
  assert.ok(from >= 0, `no function ${name}`);
  return lines.slice(from + 1, lines.indexOf("endfunction", from));
};
const body = (ai: AiFile, name: string) => fnBody(script(ai), name);

const none: AiCondition = { name: "", call: null };
const threeTowns: AiCondition = {
  name: "",
  call: {
    name: "OperatorCompareInteger", hasParams: true, trailer: 0,
    params: [
      { type: 2, value: "", call: { kind: CALL, name: "TownCountAI", hasParams: false, trailer: 0, params: [] } },
      { type: 0, value: "OperatorGreater" },
      { type: 3, value: "3" },
    ],
  },
};

/** Something in every section. */
function full(): AiFile {
  const ai = newWai();
  ai.options = 0x1ffff;
  ai.conditions = [{ index: 2, name: "Three towns", call: threeTowns.call }, { index: 3, name: "Not set", call: null }];
  ai.heroes = ["Hamg", "Hblm", "Hmkg"];
  ai.heroChances = [50, 10, 10, 10, 10, 10];
  ai.skills[0][0] = "AHbz";
  ai.build = [
    { type: 0, kind: 0, id: "hbar", town: 0, condIndex: -1, cond: none },
    { type: 0, kind: 1, id: "Rhme", town: 0xffffffff, condIndex: 2, cond: none },
    { type: 0, kind: 2, id: NO_ID, town: 0, condIndex: -2, cond: threeTowns },
  ];
  ai.harvest = [{ type: 0, resource: 0, town: 0xfffffffd, workers: 5, condIndex: -1, cond: none }];
  ai.targets = [0, 1, 2, 3, 4, 5, 6].map((target) => ({ type: 0, target, condIndex: -1, cond: none }));
  ai.groups = [{ index: 0, name: "All Units", units: [{ id: "hfoo", quantity: 2, max: 4, condIndex: -1, cond: none }] }];
  ai.waves = [{ group: 0, delay: 30 }];
  ai.initialDelay = 60;
  return ai;
}

test("every generated script reads as valid JASS", () => {
  assert.deepEqual(errors(script(newWai())), [], "a new AI");
  assert.deepEqual(errors(script(full())), [], "an AI with everything");
});

test("the checker sees a broken script", () => {
  // The control for the test above: without it, an empty environment or error list would pass.
  const good = script(full());
  assert.ok(errors(good.replace("call PlayGame(  )", "call PlayGames(  )")).length > 0, "unknown function");
  assert.ok(errors(good.replace("call Sleep( 2 )", "call Sleep(  )")).length > 0, "missing argument");
  assert.ok(errors(good.replace("    if (HallsCompleted(hallID)) then", "")).length > 0, "unbalanced block");
});

test("the file has the World Editor's line ends and header", () => {
  const ai = newWai();
  ai.name = "My AI";
  const s = script(ai);
  assert.ok(!/[^\r]\n/.test(s), "only CRLF");
  assert.ok(s.endsWith("endfunction\r\n\r\n"));
  assert.ok(s.includes("// My AI\r\n"));
  assert.ok(s.includes("//   Date: the date\r\n"));
});

test("each option bit reaches its own call", () => {
  const calls: [number, string][] = [
    [0x8000, "SetDefendPlayer"], [0x4000, "SetRandomPaths"], [0x2, "SetTargetHeroes"], [0x4, "SetPeonsRepair"], [0x8, "SetHeroesFlee"],
    [0x10000, "SetHeroesBuyItems"], [0x10, "SetUnitsFlee"], [0x20, "SetGroupsFlee"], [0x40, "SetWatchMegaTargets"], [0x80, "SetIgnoreInjured"],
    [0x100, "SetHeroesTakeItems"], [0x200, "SetSlowChopping"], [0x400, "SetCaptainChanges"], [0x800, "SetSmartArtillery"],
  ];
  for (const [bit, name] of calls) {
    const ai = newWai();
    ai.options = bit;
    const lines = body(ai, "InitOptions");
    assert.equal(lines.filter((l) => l.includes("( true )")).length, 1, `${name} alone`);
    assert.ok(lines.includes(`    call ${name}( true )`), name);
  }
});

test("melee, player name and injuries follow their bits", () => {
  const ai = newWai();
  ai.name = 'Say "hi"\\';
  ai.options = 0;
  assert.ok(body(ai, "InitOptions").includes("    call SetCampaignAI(  )"));
  assert.ok(!body(ai, "InitOptions").some((l) => l.includes("SetPlayerName")));
  assert.ok(!body(ai, "AttackAssignment").some((l) => l.includes("RemoveInjuries")));
  ai.options = 0x1 | 0x2000 | 0x1000;
  assert.ok(body(ai, "InitOptions").includes("    call SetMeleeAI(  )"));
  assert.ok(body(ai, "InitOptions").includes('    call SetPlayerName( ai_player, "Say \\"hi\\"\\\\" )'));
  assert.ok(body(ai, "AttackAssignment").includes("        call RemoveInjuries(  )"));
  assert.deepEqual(errors(script(ai)), [], "a name with a quote and a final backslash still reads");
});

test("condition names become identifiers", () => {
  assert.equal(conditionGlobal("Three towns!"), "gCond_Three_towns_");
  assert.equal(conditionGlobal("ok_1"), "gCond_ok_1");
});

test("conditions turn into expressions", () => {
  assert.equal(conditionJass(threeTowns.call!, data), "( GetHeroLevelAI() > 3 )");
  const compare = (name: string, a: string, b: string) => conditionJass({
    name, params: [{ type: 3, value: a }, { type: 3, value: b }],
  }, data, CALL);
  assert.equal(compare("GetBooleanAnd", "a", "b"), "( a and b )");
  assert.equal(compare("GetBooleanOr", "a", "b"), "( a or b )");
  assert.equal(conditionJass({ name: "OperatorInt", params: [{ type: 3, value: "1" }, { type: 3, value: "+" }, { type: 3, value: "2" }] }, data, CALL), "( 1 + 2 )");
  // Script names replace the data's, and unit codes are quoted.
  assert.equal(conditionJass({ name: "GetUnitCountDoneAI", params: [{ type: 3, value: "hfoo" }] }, data, CALL), "GetUnitCountDone( 'hfoo' )");
  assert.equal(conditionJass({ name: "GetUnitCountDoneAI", params: [{ type: 3, value: "1HIA" }] }, data, CALL), "GetUnitCountDone( hero_id )");
  assert.equal(conditionJass({ name: "NoSuch", params: [] }, data, CONDITION), "NoSuch()", "an unknown function keeps its name");
  // Strings are escaped.
  assert.equal(conditionJass({ name: "SayIt", params: [{ type: 3, value: 'a"b\\' }] }, data, CALL), 'SayIt( "a\\"b\\\\" )');
  // A variable or a preset goes as it is, a preset by its script.
  assert.equal(conditionJass({ name: "SayIt", params: [{ type: 1, value: "udg_x" }] }, data, CALL), "SayIt( udg_x )");
  assert.equal(conditionJass({ name: "SayIt", params: [{ type: 0, value: "OperatorGreater" }] }, data, CALL), "SayIt( > )");
});

test("each named condition is a global, updated in one place", () => {
  const ai = full();
  const s = script(ai);
  assert.ok(/boolean +gCond_Three_towns += false/.test(s));
  assert.deepEqual(body(ai, "UpdateConditions"), ["    set gCond_Three_towns = ( GetHeroLevelAI() > 3 )", "    set gCond_Not_set = false"]);
});

test("building counts per type, and conditions share a block", () => {
  const ai = newWai();
  ai.conditions = [{ index: 2, name: "C", call: threeTowns.call }];
  const entry = (id: string, condIndex: number, kind = 0, town = 0) => ({ type: 0, kind, id, town, condIndex, cond: condIndex === -2 ? threeTowns : none });
  ai.build = [entry("hfoo", -1), entry("hfoo", 2), entry("hkni", 2), entry("hfoo", 7), entry("Rhme", -2, 1)];
  assert.deepEqual(body(ai, "BuildPriorities").slice(1), [
    "    call SetBuildAll( BUILD_UNIT, 1, 'hfoo', 0 )",
    "    if (gCond_C) then",
    "        call SetBuildAll( BUILD_UNIT, 2, 'hfoo', 0 )",
    "        call SetBuildAll( BUILD_UNIT, 1, 'hkni', 0 )",
    "    endif",
    "    call SetBuildAll( BUILD_UNIT, 3, 'hfoo', 0 )", // a condition that isn't there guards nothing
    "    if (( GetHeroLevelAI() > 3 )) then",
    "        call SetBuildAll( BUILD_UPGRADE, 1, 'Rhme', 0 )",
    "    endif",
  ]);
});

test("an expansion builds the AI's own hall and mine", () => {
  const ai = newWai();
  ai.workers = ["opeo", "opeo", "ogre", "ogol"];
  ai.build = [{ type: 0, kind: 2, id: NO_ID, town: 0, condIndex: -1, cond: none }];
  assert.ok(body(ai, "BuildPriorities").includes("    call BuildExpansion( 'ogre', 'ogol' )"));
  assert.ok(body(ai, "AddAttackUnit").includes("    if (unitID == 'opeo') then"));
});

test("towns read as the Editor's choices", () => {
  const ai = newWai();
  const entry = (town: number) => ({ type: 0, kind: 0, id: "hfoo", town, condIndex: -1, cond: none });
  ai.build = [entry(2), entry(0xffffffff), entry(0xfffffffd), entry(0xfffffffb), entry(0xfffffffe)];
  const towns = body(ai, "BuildPriorities").slice(1).map((l) => /'hfoo', (.*) \)/.exec(l)![1]);
  assert.deepEqual(towns, ["2", "-1", "mine", "mine + 2", "-2"]);
});

test("harvesting counts all, the ones at home, or a number", () => {
  const ai = newWai();
  const entry = (resource: number, workers: number) => ({ type: 0, resource, town: 0, workers, condIndex: -1, cond: none });
  ai.harvest = [entry(0, 0xffffffff), entry(1, 0xffffffff), entry(0, 0xfffffffe), entry(1, 0xfffffffe), entry(1, 3)];
  const lines = body(ai, "HarvestPriorities").slice(4);
  assert.deepEqual(lines.filter((l) => l.includes("set numWorkers")), [
    "    set numWorkers = allGold", "    set numWorkers = allWood", "    set numWorkers = allGold - awGold", "    set numWorkers = allWood - awWood", "    set numWorkers = 3",
  ]);
  assert.deepEqual(lines.filter((l) => l.includes("call")).map((l) => l.trim().split("(")[0]), [
    "call HarvestGold", "call HarvestWood", "call HarvestGold", "call HarvestWood", "call HarvestWood",
  ]);
});

test("heroes get their skills by the order they're trained in", () => {
  const ai = newWai();
  ai.heroes = ["Hamg", NO_ID, "Hmkg"];
  ai.skills[0][0] = "A1st"; // Hamg as first hero
  ai.skills[2][4] = "A3rd"; // Hamg as third hero, level 5
  ai.skills[6 + 1][9] = "M2nd"; // Hmkg as second hero, level 10
  ai.skills[3][0] = "Xxxx"; // the hero that isn't set
  const lines = body(ai, "SetHero");
  assert.deepEqual(lines.slice(0, 3), ["    if (order == 1) then", "        set hero_id = heroid", "        if (heroid == 'Hamg') then"]);
  assert.ok(lines.includes("            set skills1[1] = 'A1st'"));
  assert.ok(lines.includes("            set skills3[5] = 'A3rd'"));
  assert.ok(lines.includes("            set skills2[10] = 'M2nd'"));
  assert.ok(!lines.some((l) => l.includes("Xxxx")));
  assert.equal(lines.at(-1), "    endif");
});

test("hero chances add up, and each order trains its three heroes", () => {
  const ai = newWai();
  ai.heroes = ["Hamg", "Hblm", NO_ID];
  ai.heroChances = [25, 0, 25, 0, 0, 50];
  assert.deepEqual(body(ai, "SelectHeroes"), [
    "    local integer roll = GetRandomInt(1,100)",
    "    if (roll <= 25) then",
    "        call SetHero( 1, 'Hamg' )",
    "        call SetHero( 2, 'Hblm' )",
    "    elseif (roll <= 50) then", // Hblm, Hamg, nothing
    "        call SetHero( 1, 'Hblm' )",
    "        call SetHero( 2, 'Hamg' )",
    "    elseif (roll <= 100) then", // nothing, Hblm, Hamg
    "        call SetHero( 2, 'Hblm' )",
    "        call SetHero( 3, 'Hamg' )",
    "    endif",
  ]);
});

test("no heroes, no hero code", () => {
  assert.deepEqual(body(newWai(), "SetHero"), []);
  assert.deepEqual(body(newWai(), "SelectHeroes"), ["    local integer roll = GetRandomInt(1,100)"]);
});

test("attack groups go by name, and waves find them there", () => {
  const ai = newWai();
  ai.groups = [{ index: 5, name: "Zerg", units: [] }, { index: 9, name: "Alpha", units: [] }];
  ai.waves = [{ group: 5, delay: 0 }, { group: 9, delay: 0 }];
  const prepare = body(ai, "PrepareAttackGroup");
  assert.ok(prepare.includes("    // Attack Group #1: Alpha"));
  assert.ok(prepare.includes("        // Attack Group #2: Zerg"));
  assert.deepEqual(body(ai, "PrepareForces"), [
    "    if (attackWave == 1) then", "        call PrepareAttackGroup( 2 )",
    "    elseif (attackWave == 2) then", "        call PrepareAttackGroup( 1 )", "    endif",
  ]);
});

test("a group's units are a number, a range or all there are", () => {
  const ai = newWai();
  const unit = (id: string, quantity: number, max: number) => ({ id, quantity, max, condIndex: -1, cond: none });
  ai.groups = [{ index: 0, name: "G", units: [unit("hfoo", 2, 5), unit("hkni", 3, 0xffffffff), unit("hmil", 0xffffffff, 0)] }];
  assert.deepEqual(body(ai, "PrepareAttackGroup").filter((l) => l.startsWith("        ") && !l.includes("//")), [
    "        call AddAttackUnit( 2, 5, 'hfoo' )",
    "        set all = GetUnitCountDone( 'hkni' )", "        call AddAttackUnit( 3, all, 'hkni' )",
    "        set all = GetUnitCountDone( 'hmil' )", "        call AddAttackUnit( all, all, 'hmil' )",
  ]);
});

test("the minimum force decides when to attack", () => {
  const ai = newWai();
  const unit = (id: string, quantity: number) => ({ id, quantity, max: 0, condIndex: -1, cond: none });
  ai.minForces = 0;
  ai.groups = [{ index: 0, name: "G", units: [] }];
  const never = body(ai, "HaveMinimumAttackers");
  assert.ok(never.includes("    // - No units in this attack group.  Never attack"));
  assert.equal(never.filter((l) => l === "    return true").length, 0);

  ai.groups[0].units = [unit("hfoo", 0xffffffff), unit("hkni", 0xffffffff)];
  const any = body(ai, "HaveMinimumAttackers");
  assert.ok(any.includes("    set count = count + GetUnitCountDone('hkni')"));
  assert.ok(any.includes("    return true"));

  ai.groups[0].units = [unit("hfoo", 3), unit("hkni", 0xffffffff)];
  const fixed = body(ai, "HaveMinimumAttackers");
  assert.ok(fixed.includes("    if (GetUnitCountDone('hfoo') < 3) then"));
  assert.ok(!fixed.some((l) => l.includes("hkni")), "an \"all\" unit sets no minimum");

  ai.minForces = 99;
  assert.ok(!body(ai, "HaveMinimumAttackers").some((l) => l.includes("Attack Group")), "no such group: no check");
});

test("delays wait for their wave, and waves repeat", () => {
  const ai = newWai();
  ai.initialDelay = 120;
  ai.waves = [{ group: 0, delay: 0 }, { group: 0, delay: 45 }, { group: 0, delay: 30 }];
  assert.deepEqual(body(ai, "AttackWaveDelay").slice(4, 9), [
    "    if (inWave == 0) then", "        call Sleep( 120 )", "    elseif (inWave == 2) then", "        call Sleep( 45 )", "    elseif (inWave == 3) then",
  ]);
  ai.repeatWaves = 2;
  assert.ok(body(ai, "AttackWaveUpdate").includes("        set attackWave = 2"), "the last two waves repeat");
  ai.repeatWaves = 9;
  assert.ok(body(ai, "AttackWaveUpdate").includes("        set attackWave = 1"), "never below the first");
  ai.repeatWaves = 0;
  assert.ok(!body(ai, "AttackWaveUpdate").some((l) => l.includes("attackWave >")), "no repeat");
});

test("each target has its own search, in priority order", () => {
  const ai = newWai();
  ai.conditions = [{ index: 1, name: "C", call: threeTowns.call }];
  const target = (t: number, extra = {}) => ({ type: 0, target: t, condIndex: -1, cond: none, ...extra });
  ai.targets = [
    target(5, { creep: { min: 2, max: 30, allowFlyers: 1 } }), target(0, { condIndex: 1 }), target(1), target(2), target(3), target(4), target(6),
  ];
  const lines = body(ai, "LaunchAttack");
  assert.ok(lines.includes("        set target = GetCreepCamp( 2, 30, true )"));
  assert.ok(lines.includes("    if (target == null and gCond_C) then"));
  const wanted = ["GetCreepCamp", "GetAllianceTarget", "GetExpansionFoe", "GetMegaTarget", "GetEnemyExpansion", "StartGetEnemyBase", "PurchaseZeppelin"];
  const at = wanted.map((w) => lines.findIndex((l) => l.includes(w)));
  // Target 4 tries the enemy's expansion first, so its own line comes later than 3's.
  assert.deepEqual([...at].sort((a, b) => a - b), at, wanted.join());
  assert.ok(at.every((i) => i >= 0));
  ai.targets = [target(5)];
  assert.ok(body(ai, "LaunchAttack").includes("        set target = GetCreepCamp( 0, 100, false )"), "the defaults");
});
