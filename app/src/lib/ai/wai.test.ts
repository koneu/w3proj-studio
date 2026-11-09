import assert from "node:assert/strict";
import { test } from "node:test";
import { CALL, CONDITION, parseTriggerData } from "../triggers/triggerdata";
import {
  aiArgCount, aiTriggerData, clearObjectData, editorDate, embeddedObjectBytes, embeddedObjectData, embedObjectData, newWai, NO_ID, parseWai, w3oOfKind, writeWai,
  type AiCondition, type AiFile,
} from "./wai";

const data = parseTriggerData(`
[TriggerConditions]
OperatorCompareInteger=0,integer,ComparisonOperator,integer
_OperatorCompareInteger_UseWithAI=1
NotForAi=0,integer
[TriggerCalls]
GetUnitCountDone=0,0,integer,unitcode
GetTownCount=0,0,integer
_GetTownCount_UseWithAI=1
_GetTownCount_AIDefaults=_
`);
const aiData = aiTriggerData(data, "[AIFunctions]\nGetUnitCount=0,0,integer,unitcode\n", parseTriggerData);
const n = aiArgCount(aiData);

const noCond: AiCondition = { name: "", call: null };
/** "Town count > 2" with a nested call and an array index: every branch of a parameter. */
const compare: AiCondition = {
  name: "Enough towns",
  call: {
    name: "OperatorCompareInteger", hasParams: true, trailer: 0,
    params: [
      { type: 2, value: "", call: { kind: 3, name: "GetUnitCount", hasParams: true, trailer: 0, params: [{ type: 3, value: "hfoo" }] } },
      { type: 0, value: "OperatorGreater" },
      { type: 1, value: "udg_counts", index: { type: 3, value: "2" } },
    ],
  },
};

/** An AI with something in every section. */
function full(): AiFile {
  const ai = newWai();
  ai.name = "Everything";
  ai.race = 3;
  ai.options = 0x1a02f;
  ai.conditionsUnknown = 7;
  ai.conditions = [{ index: 4, ...compare }, { index: 9, name: "Empty", call: null }];
  ai.heroes = ["Hamg", "Hblm", NO_ID];
  ai.heroChances = [40, 30, 10, 10, 5, 5];
  ai.skills[0] = Array.from({ length: 10 }, (_, i) => (i % 2 ? "AHbz" : "AHab"));
  ai.build = [
    { type: 0, kind: 0, id: "hbar", town: 0xffffffff, condIndex: -1, cond: noCond },
    { type: 1, kind: 1, id: "Rhme", town: 0, condIndex: 4, cond: noCond },
    { type: 0, kind: 2, id: NO_ID, town: 0, condIndex: -2, cond: compare },
  ];
  ai.harvest = [{ type: 0, resource: 1, town: 0xfffffffd, workers: 0xffffffff, condIndex: -2, cond: compare }];
  ai.targets = [
    { type: 0, target: 2, condIndex: -1, cond: noCond },
    { type: 0, target: 5, creep: { min: 1, max: 40, allowFlyers: 1 }, condIndex: 9, cond: noCond },
  ];
  ai.repeatWaves = 2;
  ai.minForces = 1;
  ai.initialDelay = 300;
  ai.groups = [
    { index: 0, name: "All Units", units: [] },
    { index: 1, name: "Raid", units: [{ id: "hfoo", quantity: 4, max: 0xffffffff, condIndex: -2, cond: compare }] },
  ];
  ai.waves = [{ group: 1, delay: 60 }, { group: 0, delay: 0 }];
  ai.wavesUnknown = 3;
  ai.gameOptions = 5;
  ai.gameSpeed = 2;
  ai.mapPath = "Maps\\Test\\Map.w3x";
  ai.players = [{ index: 0, team: 1, race: 2, color: 3, handicap: 100, aiType: 1, difficulty: 2, script: "Scripts\\x.ai" }];
  return ai;
}

test("a new AI writes and reads back as it was", () => {
  assert.deepEqual(parseWai(writeWai(newWai()), n), newWai());
});

test("an AI with every section survives, to the byte", () => {
  const bytes = writeWai(full());
  const back = parseWai(bytes, n);
  assert.deepEqual(back, full());
  assert.deepEqual(writeWai(back), bytes);
});

test("the bytes are the documented layout", () => {
  // By hand, so a mistake made alike in the reader and the writer shows up here.
  const u32 = (x: number) => [x & 255, (x >>> 8) & 255, (x >>> 16) & 255, x >>> 24];
  const text = (s: string) => [...new TextEncoder().encode(s), 0];
  const id = (s: string) => [...new TextEncoder().encode(s)];
  const bytes = new Uint8Array([
    ...u32(2), ...text("A"), ...u32(2), ...u32(0x21),
    ...u32(4), ...id("opeo"), ...id("opeo"), ...id("ogre"), ...id("ogre"),
    ...u32(0), ...u32(5), // no conditions, and the field after their count
    ...id("Obla"), ...new Array(8).fill(0),
    ...[10, 20, 30, 40, 0, 0].flatMap(u32),
    ...new Array(90 * 4).fill(0),
    ...u32(1), ...u32(1), ...u32(0), ...id("ohun"), ...u32(0xffffffff), ...u32(0xffffffff), ...text("c"), ...u32(0), // one build entry
    ...u32(0), // harvest
    ...u32(1), ...u32(0), ...u32(5), ...u32(1), ...u32(9), ...u32(0), ...u32(0xffffffff), ...text(""), ...u32(0), // a creep target
    ...u32(1), ...u32(6), ...u32(120), // repeat, minimum forces, delay
    ...u32(0), ...u32(0), ...u32(1), // no groups, no waves, the field after them
    ...u32(0), ...u32(3), ...text("m"), ...u32(0), ...u32(0),
  ]);
  const ai = parseWai(bytes, n);
  assert.equal(ai.name, "A");
  assert.equal(ai.race, 2);
  assert.equal(ai.options, 0x21);
  assert.deepEqual(ai.workers, ["opeo", "opeo", "ogre", "ogre"]);
  assert.equal(ai.conditionsUnknown, 5);
  assert.equal(ai.heroes[0], "Obla");
  assert.deepEqual(ai.heroChances, [10, 20, 30, 40, 0, 0]);
  assert.deepEqual(ai.build[0], { type: 1, kind: 0, id: "ohun", town: 0xffffffff, condIndex: -1, cond: { name: "c", call: null } });
  assert.deepEqual(ai.targets[0].creep, { min: 1, max: 9, allowFlyers: 0 });
  assert.equal(ai.targets[0].condIndex, -1, "condition indices are signed");
  assert.deepEqual([ai.repeatWaves, ai.minForces, ai.initialDelay, ai.wavesUnknown, ai.gameSpeed, ai.mapPath], [1, 6, 120, 1, 3, "m"]);
  assert.deepEqual(writeWai(ai), bytes);
});

test("only creep targets carry creep strength", () => {
  const ai = newWai();
  ai.targets = [{ type: 0, target: 2, creep: { min: 1, max: 2, allowFlyers: 1 }, condIndex: -1, cond: noCond }];
  assert.equal(parseWai(writeWai(ai), n).targets[0].creep, undefined);
  ai.targets[0].target = 5;
  delete ai.targets[0].creep;
  assert.deepEqual(parseWai(writeWai(ai), n).targets[0].creep, { min: 0, max: 0, allowFlyers: 0 }, "a creep target without values still has the fields");
});

test("names that aren't UTF-8 come back as the same bytes", () => {
  const ai = newWai();
  const raw = writeWai(ai);
  const at = 4; // the name
  const korean = new Uint8Array([0xc7, 0xd1, 0xb1, 0xdb]);
  const patched = new Uint8Array(raw.length - "Untitled AI".length + korean.length);
  patched.set(raw.subarray(0, at));
  patched.set(korean, at);
  patched.set(raw.subarray(at + "Untitled AI".length), at + korean.length);
  const back = parseWai(patched, n);
  assert.deepEqual(writeWai(back), patched);
  assert.notEqual(back.name, "");
});

test("trace names each section where it starts", () => {
  const bytes = writeWai(full());
  const seen: [string, number][] = [];
  parseWai(bytes, n, (s, o) => seen.push([s, o]));
  assert.deepEqual(seen.map(([s]) => s), ["heroes", "build", "harvest", "targets", "attack", "waves", "game"]);
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i][1] > seen[i - 1][1], `${seen[i][0]} comes after ${seen[i - 1][0]}`);
  // Heroes are 12 bytes, chances 24 and skills 360: "build" starts right after.
  assert.equal(seen[1][1] - seen[0][1], 396);
});

test("damaged files are refused and say where", () => {
  const bad = writeWai(newWai());
  bad[0] = 3;
  assert.throws(() => parseWai(bad, n), /unsupported AI file version 3 \(at byte 4\)/);
  const cut = writeWai(newWai()).subarray(0, 8);
  assert.throws(() => parseWai(cut, n), /unterminated string \(at byte 4\)/);
  const short = writeWai(newWai());
  assert.throws(() => parseWai(short.subarray(0, short.length - 2), n), /at byte/);
});

test("an AI function the data doesn't know can't be read", () => {
  const ai = newWai();
  ai.conditions = [{ index: 0, name: "x", call: { name: "NoSuchCall", hasParams: true, params: [], trailer: 0 } }];
  assert.throws(() => parseWai(writeWai(ai), n), /unknown AI function NoSuchCall/);
});

test("what follows the documented end stays", () => {
  const ai = newWai();
  ai.trailer = 1;
  ai.extra = new Uint8Array([0x61, 0, 0x62, 0, 1, 2, 3]);
  const back = parseWai(writeWai(ai), n);
  assert.deepEqual(back.extra, ai.extra);
  assert.deepEqual(embeddedObjectData(back), { path: "a", date: "b" });
});

test("no object data without its flag or its two strings", () => {
  const ai = newWai();
  ai.extra = new Uint8Array([0x61, 0, 0x62, 0]);
  assert.equal(embeddedObjectData(ai), null, "the flag is off");
  ai.trailer = 1;
  ai.extra = new Uint8Array();
  assert.equal(embeddedObjectData(ai), null, "nothing follows");
  ai.extra = new Uint8Array([0x61, 0, 0x62]);
  assert.equal(embeddedObjectData(ai), null, "the date isn't terminated");
  ai.extra = new Uint8Array([0x61]);
  assert.equal(embeddedObjectData(ai), null, "the path isn't terminated");
});

test("object data goes in as path, date and the .w3o, and comes out as it went in", () => {
  const ai = newWai();
  const w3o = w3oOfKind("w3t", new Uint8Array([2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
  embedObjectData(ai, "C:/maps/Custom.w3o", editorDate(new Date(2019, 10, 6, 1, 21, 35)), w3o);
  const back = parseWai(writeWai(ai), n);
  assert.deepEqual(embeddedObjectData(back), { path: "C:/maps/Custom.w3o", date: "Wed Nov  6 01:21:35 2019" });
  assert.deepEqual(embeddedObjectBytes(back), w3o);
  assert.equal(back.trailer, 1);
  clearObjectData(back);
  assert.equal(embeddedObjectBytes(parseWai(writeWai(back), n)), null);
  assert.deepEqual(writeWai(back), writeWai(newWai()), "cleared, the AI is as one that never had any");
});

test("a .w3o of one kind: version 1, a flag per kind, the file after its kind's flag", () => {
  const file = new Uint8Array([9, 9, 9]);
  const w = w3oOfKind("w3b", file);
  const words = (from: number, count: number) => Array.from({ length: count }, (_, i) => new DataView(w.buffer).getUint32(from + 4 * i, true));
  assert.deepEqual(words(0, 4), [1, 0, 0, 1], "version, units, items, destructables");
  assert.deepEqual([...w.subarray(16, 19)], [9, 9, 9]);
  assert.deepEqual(words(19, 4), [0, 0, 0, 0], "doodads, abilities, buffs, upgrades");
  assert.equal(w.length, 4 + 7 * 4 + 3);
  assert.throws(() => w3oOfKind("w3x", file), /not an object data kind/);
});

test("AI functions are the ones marked for AI, plus the AI Editor's own", () => {
  assert.ok(aiData.functions[CONDITION].has("OperatorCompareInteger"));
  assert.ok(!aiData.functions[CONDITION].has("NotForAi"));
  assert.ok(aiData.functions[CALL].has("GetTownCount"));
  assert.ok(!aiData.functions[CALL].has("GetUnitCountDone"), "not marked with _UseWithAI");
  assert.ok(aiData.functions[CALL].has("GetUnitCount"), "from AIEditorData");
  assert.deepEqual(aiData.find(CONDITION, "GetTownCount")?.defaults, ["_"], "AI defaults replace the usual ones");
  assert.equal(n("GetUnitCount"), 1);
  assert.equal(n("GetTownCount"), 0);
});
