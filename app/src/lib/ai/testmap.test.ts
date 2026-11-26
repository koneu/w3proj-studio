import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeAiType, encodeAiType } from "./slots";
import { MELEE_FLAG, testInfo, testPlan, testScript, type MapInfo } from "./testmap";
import { newWai, type AiFile } from "./wai";

const map = (n: number, flags = MELEE_FLAG): MapInfo => ({
  flags, players: Array.from({ length: n }, (_, id) => ({ id, controller: 1, race: id + 1, fixedStart: 1, start: [id * 100, 0], name: `P${id + 1}` })),
});
const slot = (index: number, aiType: number, team = 0, race = 32) => ({ index, team, race, color: index, handicap: 100, aiType, difficulty: 1, script: "" });
/** The slots of the game's GruntMaster.wai: the user watching, the AI being edited as an orc on Team 1, the standard AI on Team 2. */
const grunt = (): AiFile => ({ ...newWai(), gameOptions: 2, gameSpeed: 3, players: [slot(0, 3), slot(1, 12, 0, 2), slot(2, 0, 1)] });

const script = [
  "function Trig_Melee_Initialization_Actions takes nothing returns nothing",
  "    call MeleeStartingUnits(  )",
  "    call MeleeStartingAI(  )",
  "    call MeleeInitVictoryDefeat(  )",
  "endfunction",
  "function main takes nothing returns nothing",
  "    call RunInitializationTriggers(  )",
  "endfunction",
  "function config takes nothing returns nothing",
  "    call SetPlayers( 4 )",
  "endfunction",
  "",
].join("\r\n");

test("the control number: user, observer and AI as the game's AI files hold them, changed part by part", () => {
  assert.deepEqual(decodeAiType(3), { control: "User", observer: true, ai: "Standard" });
  assert.deepEqual(decodeAiType(12), { control: "Computer", observer: false, ai: "Current" });
  assert.deepEqual(decodeAiType(0), { control: "Computer", observer: false, ai: "Standard" });
  assert.equal(decodeAiType(4).ai, "Custom");
  assert.equal(decodeAiType(8).ai, "Current");
  assert.equal(encodeAiType(3, { observer: false }), 1);
  assert.equal(encodeAiType(3, { control: "Computer", observer: false }), 0);
  assert.equal(encodeAiType(8, { ai: "Current" }), 8, "a Current stored as 2 stays");
  assert.equal(encodeAiType(0, { ai: "Current" }), 12);
  assert.equal(encodeAiType(12, { ai: "Custom" }), 4);
});

test("the watching user gets the first player, which the game seats the person in; the computers follow", () => {
  const plan = testPlan(grunt(), map(4));
  assert.equal(plan.observer, 0);
  assert.deepEqual(plan.slots.map((s) => [s.player, s.start, s.user, s.team, s.ai]), [[1, 0, false, 0, "Current"], [2, 1, false, 1, "Standard"]]);
  assert.equal(plan.observerStart, 2, "a start nobody plays from");
  assert.deepEqual([plan.fogOff, plan.noVictory], [true, true]);
  assert.match(plan.notes.join(" "), /Game Speed 3/);
  const info = testInfo(map(4), plan);
  assert.deepEqual(info.players.map((p) => [p.id, p.controller, p.race, p.start[0]]), [[0, 1, 1, 200], [1, 2, 2, 0], [2, 2, 0, 100]]);
});

test("a playing user listed after the computers still gets the first player, and keeps its row's start", () => {
  const ai = { ...grunt(), players: [slot(0, 12, 0, 2), slot(1, 1, 1, 1), slot(2, 0, 1)] };
  const plan = testPlan(ai, map(4));
  assert.equal(plan.observer, null);
  assert.deepEqual(plan.slots.map((s) => [s.player, s.start, s.user]), [[1, 0, false], [0, 1, true], [2, 2, false]]);
});

test("computers on every start: the observer is still first, the last computer takes a number the map doesn't use", () => {
  const plan = testPlan(grunt(), map(2));
  assert.deepEqual([plan.observer, plan.observerStart, plan.slots.map((s) => [s.player, s.start])], [0, 0, [[1, 0], [2, 1]]]);
  assert.deepEqual(testInfo(map(2), plan).players.map((p) => [p.id, p.controller]), [[0, 1], [1, 2], [2, 2]]);
});

test("the configurations the World Editor refuses are refused in its words", () => {
  const ai = grunt();
  assert.throws(() => testPlan(ai, map(4, 0)), /not a Melee map/);
  assert.throws(() => testPlan({ ...ai, players: [slot(1, 12)] }, map(4)), /No user-controlled players specified/);
  assert.throws(() => testPlan({ ...ai, players: [slot(0, 3), slot(1, 1)] }, map(4)), /Multiple players specified as user-controlled/);
  assert.throws(() => testPlan({ ...ai, players: [slot(0, 3), slot(1, 2)] }, map(4)), /A computer is specified as an observer/);
  assert.throws(() => testPlan({ ...ai, players: [slot(0, 3)] }, map(4)), /No non-observing players/);
  assert.throws(() => testPlan(ai, map(1)), /Too many non-observing players/);
});

test("the script: each computer starts its own AI, the map's own start and the victory conditions go, config sets the slots", () => {
  const info = map(4), plan = testPlan(grunt(), info);
  const out = testScript(script, info, plan, new Map([[1, "war3mapImported\\w3proj-testai-2.ai"]]), new Map([[1, 'Orc, "Grunt" Master'], [2, "random race, standard AI"]]));
  assert.ok(!/call MeleeStartingAI|call MeleeInitVictoryDefeat/.test(out));
  assert.ok(out.includes('call StartMeleeAI( Player(1), "war3mapImported\\\\w3proj-testai-2.ai" )'));
  assert.ok(out.includes("call W3ProjTestAI_Standard( Player(2) )"));
  assert.ok(out.includes('\\"Grunt\\" Master'), "a name with quotes stays one string");
  const config = out.slice(out.indexOf("function config"));
  assert.ok(config.indexOf("call SetPlayers( 3 )") > config.indexOf("call SetPlayers( 4 )"), "after the map's own settings");
  for (const line of ["MAP_CONTROL_COMPUTER )", "call SetPlayerTeam( Player(2), 1 )", "call SetPlayerController( Player(0), MAP_CONTROL_USER )", "call SetPlayerController( Player(3), MAP_CONTROL_NONE )"]) assert.ok(config.includes(line), line);
  const main = out.slice(out.indexOf("function main"), out.indexOf("function config"));
  assert.ok(main.indexOf("call W3ProjTestAI_Start()") > main.indexOf("RunInitializationTriggers"), "after the melee trigger");
  assert.ok(out.indexOf("function W3ProjTestAI_Start") < out.indexOf("function main "), "declared before main calls it");
  assert.ok(out.includes("GetPlayerController(Player(1)) == MAP_CONTROL_COMPUTER then"), "an AI starts on a computer only");
  // The watching user's player gets no starting units: the map's call goes to ours, declared before its caller.
  assert.ok(/call W3ProjTestAI_StartingUnits\(\s*\)/.test(out) && !/call MeleeStartingUnits\(/.test(out));
  assert.ok(out.indexOf("function W3ProjTestAI_StartingUnits") < out.indexOf("function Trig_Melee_Initialization_Actions"));
  assert.ok(out.includes("index != 0 then"));
  assert.ok(out.includes("\r\n"), "keeps the script's line ends");
});

test("a playing user keeps the victory conditions unless the configuration disables them", () => {
  const ai = { ...grunt(), gameOptions: 0, gameSpeed: 1, players: [slot(0, 1, 0, 1), slot(1, 12, 1, 2)] };
  const plan = testPlan(ai, map(2));
  assert.equal(plan.observer, null);
  assert.deepEqual([plan.fogOff, plan.noVictory, plan.notes.length], [false, false, 0]);
  const out = testScript(script, map(2), plan, new Map(), new Map());
  assert.ok(out.includes("call MeleeInitVictoryDefeat(  )"));
  assert.ok(!out.includes("W3ProjTestAI_RemoveUnits"));
});

test("a script without a config is refused, not half changed", () => {
  const plan = testPlan(grunt(), map(4));
  assert.throws(() => testScript("function main takes nothing returns nothing\nendfunction\n", map(4), plan, new Map(), new Map()), /no function config/);
});
