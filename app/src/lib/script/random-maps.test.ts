// Scripts of random made-up maps have to be valid. The JASS checker reads every generated script
// against a stand-in for the game's API, so a call to a function that isn't there, a global nobody
// declared or a wrong argument fails here, in any mix of sections. War3map.j byte by byte is compared
// with the World Editor's locally (scripts/script-check); this runs everywhere.

import assert from "node:assert/strict";
import { test } from "node:test";
import { checkJass } from "../jass/check";
import { miniGameEnv } from "../jass/mini-game.fixture";
import { checkLua } from "../lua/check";
import { parseTriggerData } from "../triggers/triggerdata";
import { textTriggers, type Eca, type Param, type TriggerFile, type TriggerItem, type Variable } from "../triggers/wtg";
import { generateScript, type ScriptInput } from "./jass";
import { convertToCustom, placedGlobalsOnlyIn, triggerCustomText } from "./triggers";

const data = parseTriggerData(`
[TriggerTypes]
integer=0,1,1,Integer
real=0,1,1,Real
boolean=0,1,1,Boolean
string=0,1,1,String
unit=0,1,1,Unit
group=0,1,1,Unit Group
timer=0,1,1,Timer
unitcode=0,1,1,Unit-Type,integer
[TriggerParams]
PresetTrue=0,boolean,true,True
OperatorEqualENE=0,ComparisonOperator,==,Equal
OperatorAdd=0,ArithmeticOperator,+,Add
[TriggerEvents]
MapInitializationEvent=0,nothing
TriggerRegisterTimerEventPeriodic=0,real
[TriggerConditions]
OperatorCompareInteger=0,integer,ComparisonOperator,integer
[TriggerActions]
DoNothing=0,nothing
KillUnit=0,unit
TriggerSleepAction=0,real
SetVariable=0,AnyGlobal,Null
IfThenElseMultiple=0,nothing
ForLoopAMultiple=0,integer,integer
CommentString=0,string
CustomScriptCode=0,string
[TriggerCalls]
GetTriggerUnit=0,0,unit
OperatorInt=0,0,integer,integer,ArithmeticOperator,integer
_TriggerRegisterTimerEventPeriodic_ScriptName=TriggerRegisterTimerEventPeriodic
`);

/** A small seeded generator: a failure can be replayed from its seed. */
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  const next = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s; };
  return { int: (n: number) => next() % n, bool: () => next() % 2 === 0, pick: <T,>(a: T[]): T => a[next() % a.length] };
}
type R = ReturnType<typeof rng>;

const NAMES = ["Spawn Point", "a", "Zone!", "Wave_", "Größe", "1st", "x  ", "_lead", "Boss Room (2)", "A-B"];
const TEXT = ["Plain", 'with "quotes"', "back\\slash", "äöü", "percent %s", ""];
const uniq = (r: R, n: number) => [...new Set(Array.from({ length: n }, () => r.pick(NAMES)))];

const param = (value: string, type = 3): Param => ({ type, value });
const eca = (kind: number, name: string, params: Param[] = [], children: Eca[] = [], group?: number): Eca => ({ kind, name, enabled: true, params, children, group });

function action(r: R, vars: Variable[], lua: boolean, depth = 0): Eca {
  const leaf = (): Eca => {
    switch (r.int(6)) {
      case 0: return eca(2, "DoNothing");
      case 1: return eca(2, "KillUnit", [{ type: 2, value: "GetTriggerUnit", call: { kind: 3, name: "GetTriggerUnit", hasParams: false, params: [] } }]);
      case 2: return eca(2, "TriggerSleepAction", [param("1.5")]);
      case 3: return eca(2, "CommentString", [param(r.pick(TEXT))]);
      case 4: return eca(2, "CustomScriptCode", [param(lua ? "DoNothing()" : "call DoNothing()")]);
      default: {
        const v = vars.find((x) => x.type === "integer" && !x.isArray);
        return v ? eca(2, "SetVariable", [param(v.name, 1), { type: 2, value: "OperatorInt", call: { kind: 3, name: "OperatorInt", hasParams: true, params: [param("1"), param("OperatorAdd", 0), param("2")] } }]) : eca(2, "DoNothing");
      }
    }
  };
  if (depth > 2 || r.bool()) return leaf();
  const body = (group: number) => Array.from({ length: r.int(3) }, () => ({ ...action(r, vars, lua, depth + 1), group }));
  if (r.bool()) return eca(2, "ForLoopAMultiple", [param("1"), param("3")], body(0));
  const cond = eca(1, "OperatorCompareInteger", [param("1"), param("OperatorEqualENE", 0), param("2")], [], 0);
  return eca(2, "IfThenElseMultiple", [], [cond, ...body(1), ...body(2)]);
}

function triggers(r: R, gg: string[], lua: boolean): { file: TriggerFile; custom: { reforged: boolean; version: number; comment: string; header: string | null; texts: (string | null)[] } } {
  const variables: Variable[] = [
    { name: "Score", type: "integer", unknown: 0, isArray: false, arraySize: 0, initialized: r.bool(), initialValue: "5", id: 0, parent: 0 },
    { name: "Grid", type: "real", unknown: 0, isArray: true, arraySize: 4, initialized: false, initialValue: "", id: 1, parent: 0 },
    { name: "Packs", type: "group", unknown: 0, isArray: r.bool(), arraySize: 2, initialized: false, initialValue: "", id: 2, parent: 0 },
    { name: "Clock", type: "timer", unknown: 0, isArray: false, arraySize: 0, initialized: false, initialValue: "", id: 3, parent: 0 },
    { name: "Hero", type: "unit", unknown: 0, isArray: false, arraySize: 0, initialized: false, initialValue: "", id: 4, parent: 0 },
    { name: "Kind", type: "unitcode", unknown: 0, isArray: false, arraySize: 0, initialized: true, initialValue: "hfoo", id: 5, parent: 0 },
    { name: "Title", type: "string", unknown: 0, isArray: false, arraySize: 0, initialized: r.bool(), initialValue: r.pick(TEXT), id: 6, parent: 0 },
  ].slice(0, 1 + r.int(7));
  const texts: (string | null)[] = [];
  const items: TriggerItem[] = uniq(r, 1 + r.int(4)).map((name, k) => {
    const custom = r.int(4) === 0;
    const item: TriggerItem = { type: 8, name, description: "", isComment: 0, id: k, enabled: r.int(5) > 0, isCustom: custom, initiallyOff: r.int(4) === 0, runOnInit: r.int(4) === 0, parent: 0, ecas: [] };
    texts.push(custom ? (lua ? `function Lib${k}()\nend\n` : `function Lib${k} takes nothing returns nothing\nendfunction\n`) : null);
    if (!custom) {
      if (r.bool()) item.ecas.push(eca(0, "MapInitializationEvent"));
      if (r.bool()) item.ecas.push(eca(1, "OperatorCompareInteger", [param("1"), param("OperatorEqualENE", 0), param("2")]));
      for (let a = r.int(4); a > 0; a--) item.ecas.push(action(r, variables, lua));
      // A trigger that uses a placed object makes it a global.
      for (const g of gg) if (r.bool()) item.ecas.push(eca(2, g.startsWith("gg_unit") ? "KillUnit" : "DoNothing", g.startsWith("gg_unit") ? [param(g, 1)] : []));
    }
    return item;
  });
  return {
    file: { reforged: false, version: 7, counts: [], unknown: 2, variables, items },
    custom: { reforged: false, version: 1, comment: "", header: r.bool() ? (lua ? "function FromHeader()\nend" : "function FromHeader takes nothing returns nothing\nendfunction") : null, texts },
  };
}

function randomMap(seed: number, lua: boolean): ScriptInput {
  const r = rng(seed);
  const players = Array.from({ length: 1 + r.int(4) }, (_, id) => ({
    id: id * (r.bool() ? 1 : 2), controller: 1 + r.int(4), race: r.int(5), fixedStart: r.int(2), name: "P", start: [r.int(2000) - 1000, r.int(2000) - 1000],
    allyLow: r.int(16), allyHigh: r.int(16), enemyLow: r.int(16), enemyHigh: r.int(16), hudSkin: r.bool() ? r.pick([1, 2, 4, 8, 32, 64]) : undefined,
  })).filter((p, k, all) => all.findIndex((q) => q.id === p.id) === k);
  const ids = players.map((p) => p.id);
  const mask = () => r.int(16);
  const flagsOf = () => (r.bool() ? 0x20 : 0) | (r.bool() ? 0x40 : 0) | (r.bool() ? 0x2000 : 0) | (r.bool() ? 0x10000 : 0);
  const editorVersion = r.pick([0, 6031, 6117, 7000, 7003]);
  const hasTable = r.bool(), groups = r.bool();
  const placed = (id: string, editorId: number, extra: object = {}) => ({
    id, editorId, variation: 0, position: [r.int(4000) - 2000 + 0.25, r.int(4000) - 2000, 0], angle: r.int(6), player: r.pick([...ids, 24, 27]), hp: r.pick([-1, 50]), mana: r.pick([-1, 100]),
    gold: 12500, targetAcquisition: r.pick([-1, -2, 300]), level: r.pick([0, 1, 3]), inventory: r.bool() ? [{ slot: 0, id: "ratc" }] : [],
    abilities: r.bool() ? [{ id: "AHhb", autocast: r.int(2), level: 1 + r.int(2) }] : [], color: r.pick([-1, 3]), waygate: r.pick([-1, 0]),
    itemTable: r.pick([-1, -1, 0]), itemSets: r.bool() ? [[{ id: "ratc", chance: 40 }, { id: "YiI2", chance: 30 }]] : [], ...extra,
  });
  const randomUnit = (k: number) => placed(r.pick(["uDNR", "bDNR"]), 200 + k, r.pick<object>([{ randomType: 0, randomLevel: "020000" }, { randomType: 2, randomUnits: [{ id: "hfoo", chance: 100 }] }, ...(groups ? [{ randomType: 1, randomGroup: 2, randomPosition: 1 }] : [])]));
  const units = [...Array.from({ length: r.int(5) }, (_, k) => placed(r.pick(["hfoo", "hbar", "ngol", "ugol", "nwgt", "sloc"]), k)), ...Array.from({ length: r.int(3) }, (_, k) => randomUnit(k)), ...Array.from({ length: r.int(3) }, (_, k) => placed("ratc", 100 + k))];
  const doodads = Array.from({ length: r.int(4) }, (_, k) => ({
    id: r.pick(["LTlt", "ATg1"]), editorId: k, variation: 1, position: [1, 2, 3], angle: 1, scale: [1, 1, 1], flags: r.pick([0, 2, 4]), life: r.pick([0, 50, 100]),
    itemTable: -1, itemSets: r.bool() ? [[{ id: "ratc", chance: 100 }]] : [],
  }));
  const gg = [...units.filter((u) => u.id === "hfoo").map((u) => `gg_unit_hfoo_${String(u.editorId).padStart(4, "0")}`), ...doodads.map((d) => `gg_dest_${d.id}_${String(d.editorId).padStart(4, "0")}`)];
  const t = r.int(8) ? triggers(r, gg, lua) : undefined;
  const soundNames = uniq(r, r.int(3)).map((n, k) => `gg_snd_S${k}${n.replace(/\W/g, "")}`);
  const sounds = soundNames.map((name, k) => ({
    name, file: "Sound\\x.wav", eaxEffect: "DefaultEAXON", flags: k ? r.pick([0, 2, 3]) : r.pick([2, 8]), fadeInRate: 10, fadeOutRate: 10, volume: -1, pitch: r.pick([1, 4294967300]), pitchVariance: 1,
    priority: 0, channel: r.pick([-1, 0, 2]), minDistance: 100, maxDistance: 1000, distanceCutoff: 3000, coneInside: 0, coneOutside: 0, coneOutsideVolume: 127, coneOrientation: [0, 0, 1],
    assetLabel: r.bool() ? "Rain" : "", speakerNameKey: r.pick([-1, 3]), dialogueTextKey: r.pick([-1, 4]), facialAnimationLabel: "", facialAnimationGroupLabel: r.bool() ? "G" : "", facialAnimationSetFile: "",
  }));
  const regions = uniq(r, r.int(4)).map((name, index) => ({ name, index, left: 0, bottom: 0, right: 64, top: 64, weather: r.pick(["", "0x00000000", "RAhr"]), sound: soundNames.length && sounds[0].flags !== 8 && r.bool() ? soundNames[0] : "" }));
  // A waygate's region: regions[0] when there is one.
  return {
    info: {
      name: r.pick(TEXT) || "Map", author: r.pick(TEXT), description: r.pick(TEXT), version: 25, flags: flagsOf(), tileset: r.pick(["L", "A", "?"]), cameraBounds: [-2048, -2048, 2048, 2048, -2048, 2048, 2048, -2048], cameraComplements: [6, 6, 4, 8],
      soundEnvironment: r.pick(["", "cave"]), lightEnvironment: "", weather: r.pick(["", "0x00000000", "RAhr"]), scriptType: lua ? 1 : 0, editorVersion,
      players, forces: [{ flags: r.int(64), players: mask(), name: "Team 1" }, { flags: r.int(64), players: mask(), name: "Team 2" }],
      water: r.bool() ? { overrideColor: 1, wavesVertexDisplacement: 1, minOpacity: 1, maxOpacity: 1, reflectivity: 1, emissivity: 1, edgeSoftness: 1, wavesNormalMapStrength: 1, environmentMapReflectivity: 1 } : undefined,
      fog: { style: 0, start: 100, end: 2000, density: 0.5, color: [255, 128, 0, 255] }, waterTint: [1, 2, 3, 4],
      terrainFog: r.bool() ? { style: 1, overSky: 1, linearStart: 0, linearEnd: 1, maxOpacity: 1, height: 100 } : undefined,
      upgrades: r.bool() ? [{ players: mask(), id: "Rhme", level: 0, availability: r.int(3) }] : [], techs: r.bool() ? [{ players: mask(), id: r.pick(["hfoo", "AHhb"]) }] : [],
      itemTables: hasTable ? [{ number: 0, sets: [[{ id: "ratc", chance: 50 }, { id: "YYI/", chance: 25 }]] }] : [],
      unitTables: groups ? [{ number: 2, name: "Creeps", positions: [0, 1], lines: [{ chance: 60, ids: ["hfoo", "0x00000000"] }, { chance: 40, ids: ["YYU2", "hpea"] }] }] : [],
    },
    data, units: units as never, doodads: doodads as never, regions, cameras: uniq(r, r.int(3)).map((name) => ({ name, targetX: 0, targetY: 0, zOffset: 0, rotation: 90, angleOfAttack: 304, distance: 1650, roll: 0, fieldOfView: 70, farZ: 5000, nearZ: 16 })),
    sounds: sounds as never, triggers: t?.file, custom: t?.custom as never,
    kindOf: (id) => (id === "hbar" ? "building" : id === "ratc" ? "item" : id === "sloc" ? "sloc" : id === "AHhb" ? "ability" : "unit"),
    autocastOrders: (a) => (a === "AHhb" && seed % 2 ? { on: "healon", off: "healoff" } : undefined),
    lights: { terrain: "T.mdl", unit: "U.mdl" }, groundHeight: () => 12, soundLabel: (l) => (l === "Rain" ? { channel: 0, pitch: 1, minDistance: 0, maxDistance: 10000, distanceCutoff: 3000 } : undefined),
    soundDuration: () => 1000,
  };
}

const ROUNDS = Number(process.env.W3PROJ_ROBUSTNESS_ROUNDS ?? 300);

test("every random map's war3map.j is valid JASS", () => {
  const env = miniGameEnv();
  for (let seed = 1; seed <= ROUNDS; seed++) {
    const script = generateScript(randomMap(seed, false));
    const problems = checkJass(script, env, { ordered: true });
    if (problems.length) {
      const p = problems[0], line = script.slice(0, p.from).split("\n").length;
      assert.fail(`seed ${seed}: ${problems.length} problems, first at line ${line}: ${p.message}\n> ${script.split("\n")[line - 1]}`);
    }
  }
});

test("every random map's war3map.lua reads as Lua", () => {
  for (let seed = 1; seed <= ROUNDS; seed++) {
    const script = generateScript(randomMap(seed, true));
    const problems = checkLua(script);
    if (problems.length) assert.fail(`seed ${seed}: ${problems[0].message}\n> ${script.slice(problems[0].from - 80, problems[0].to + 40)}`);
  }
});

test("the random maps reach what they're meant to reach", () => {
  const scripts = Array.from({ length: ROUNDS }, (_, k) => generateScript(randomMap(k + 1, false))).join("\n");
  for (const want of ["CreateAllUnits", "CreateAllItems", "CreateAllDestructables", "InitSounds", "CreateRegions", "CreateCameras", "InitUpgrades", "InitTechTree", "InitRandomGroups",
    "RunInitializationTriggers", "InitAllyPriorities", "ItemTable000000_DropItems", "Unit000000_DropItems", "bj_forLoopAIndex", "exitwhen (i >", "CreateBlightedGoldmine", "WaygateActivate", "gg_rg_002[1]", "ChooseRandomCreep", "ChooseRandomNPBuilding"]) {
    assert.ok(scripts.includes(want), `no random map has ${want}`);
  }
});

/** The map with every GUI trigger converted to custom text, as the trigger editor does it; how many were. */
function converted(map: ScriptInput, keepInit = true): { map: ScriptInput; count: number; lost: string[] } {
  const out = structuredClone({ triggers: map.triggers, custom: map.custom });
  const copy: ScriptInput = { ...map, triggers: out.triggers, custom: out.custom };
  if (!copy.triggers) return { map: copy, count: 0, lost: [] };
  const custom = copy.custom ?? { reforged: false, version: 1, comment: "", header: null, texts: [] };
  copy.custom = custom;
  const lua = map.info.scriptType === 1;
  let count = 0;
  const lost: string[] = [];
  textTriggers(copy.triggers).forEach((t, k) => {
    if (t.isCustom || t.type !== 8) return;
    lost.push(...placedGlobalsOnlyIn(copy.triggers!, t));
    custom.texts[k] = triggerCustomText({ data: copy.data, triggers: copy.triggers!, custom, lua }, t);
    const runOnInit = t.runOnInit;
    convertToCustom(t);
    if (!keepInit) t.runOnInit = runOnInit;
    count++;
  });
  return { map: copy, count, lost };
}

/** Placed objects' globals that the map's GUI triggers use (the map script declares only those). */
function placedRefs(map: ScriptInput): Set<string> {
  const out = new Set<string>();
  const visitP = (p: Param) => { if (p.type === 1 && /^gg_(unit|item|dest)_/.test(p.value)) out.add(p.value); p.call?.params.forEach(visitP); if (p.index) visitP(p.index); };
  const visit = (e: Eca) => { e.params.forEach(visitP); e.children.forEach(visit); };
  for (const t of map.triggers?.items ?? []) if ("ecas" in t && !t.isCustom) t.ecas.forEach(visit);
  return out;
}

test("converting every GUI trigger to custom text leaves war3map.j and war3map.lua the same, but for placed objects' globals", () => {
  let count = 0, init = 0, same = 0, withPlaced = 0;
  for (const lua of [false, true]) {
    for (let seed = 1; seed <= ROUNDS; seed++) {
      const map = randomMap(seed, lua), after = converted(map), before = generateScript(map), refs = placedRefs(map);
      count += after.count;
      assert.ok((after.map.triggers?.items ?? []).every((t) => !("ecas" in t) || t.isCustom), "every trigger is custom text now");
      assert.deepEqual(new Set(after.lost), refs, `seed ${seed}: the globals the conversion would take out are named`);
      if (!refs.size) {
        assert.equal(generateScript(after.map), before, `seed ${seed}${lua ? " (Lua)" : ""}`);
        same++;
      } else {
        // The World Editor declares a placed object's global only for GUI triggers: these go, as there.
        const script = generateScript(after.map);
        for (const g of refs) assert.ok(before.includes(g) && !new RegExp(`\\b${g}\\s*=\\s*null`).test(script.split("endglobals")[0]), `seed ${seed}: ${g}`);
        withPlaced++;
      }
      // Control: without Run on Map Initialization a converted map initialization trigger no longer runs at the start.
      if (!refs.size && generateScript(converted(map, false).map) !== before) init++;
    }
  }
  assert.ok(count > ROUNDS, `${count} triggers converted`);
  assert.ok(same > ROUNDS / 2 && withPlaced > 0, `${same} maps the same, ${withPlaced} with placed objects`);
  assert.ok(init > 0, "no random map had a map initialization trigger the control could lose");
});

test("the check can fail: a broken script is reported", () => {
  const env = miniGameEnv();
  const script = generateScript(randomMap(1, false));
  // main calling something nobody wrote, as it would if a section went missing.
  const broken = script.replace("    call InitBlizzard(  )", "    call InitBlizzard(  )\r\n    call CreateAllUnitsTypo(  )");
  assert.notEqual(broken, script);
  assert.deepEqual(checkJass(script, env, { ordered: true }), []);
  assert.match(checkJass(broken, env, { ordered: true })[0].message, /CreateAllUnitsTypo/);
});
