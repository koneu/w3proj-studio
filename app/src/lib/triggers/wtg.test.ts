import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTriggerData } from "./triggerdata";
import { parseWct, parseWctText, parseWtg, parseWtgJson, textTriggers, writeWct, writeWctText, writeWtg, writeWtgJson, type Call, type CustomTextFile, type Eca, type TriggerFile } from "./wtg";

/** Just the functions the samples use, in TriggerData.txt's own form. */
const data = parseTriggerData(`
[TriggerEvents]
MapInitializationEvent=0,nothing
[TriggerConditions]
OperatorCompareInteger=0,integer,ComparisonOperator,integer
[TriggerActions]
IfThenElseMultiple=0,nothing
SetVariable=0,AnyGlobal,Null
[TriggerCalls]
OperatorInt=0,0,integer,integer,ArithmeticOperator,integer
`);

const add: Call = { kind: 3, name: "OperatorInt", hasParams: true, trailer: 0, params: [
  { type: 3, value: "1" }, { type: 0, value: "OperatorAdd" }, { type: 1, value: "Score", index: { type: 3, value: "2" } },
] };
const setScore: Eca = { kind: 2, name: "SetVariable", enabled: true, children: [], params: [{ type: 1, value: "Score" }, { type: 2, value: "OperatorInt", call: add }] };
const branch: Eca = { kind: 2, name: "IfThenElseMultiple", enabled: false, params: [], children: [
  { kind: 1, group: 0, name: "OperatorCompareInteger", enabled: true, children: [], params: [{ type: 1, value: "Score" }, { type: 0, value: "OperatorEqualENE" }, { type: 3, value: "0" }] },
  { ...setScore, group: 1 },
  { ...setScore, group: 2, enabled: false },
] };

const reforged = (): TriggerFile => ({
  reforged: true, version: 7, unknown: 2,
  counts: Array.from({ length: 8 }, (_, i) => ({ count: i, deleted: i === 3 ? [7, 9] : [] })),
  variables: [{ name: "Score", type: "integer", unknown: 1, isArray: true, arraySize: 4, initialized: true, initialValue: "12", id: 100, parent: 2 }],
  items: [
    { type: 1, id: 1, name: "Äpfel & Karten", isComment: 0, expanded: 1, parent: -1 },
    { type: 4, id: 2, name: "Initialisierung", isComment: 0, expanded: 0, parent: 1 },
    { type: 64, id: 100, name: "Score", parent: 2 },
    { type: 8, name: "Start", description: "Zeile 1\r\nZeile 2", isComment: 0, id: 3, enabled: true, isCustom: false, initiallyOff: false, runOnInit: true, parent: 2,
      ecas: [{ kind: 0, name: "MapInitializationEvent", enabled: true, params: [], children: [] }, setScore, branch] },
    { type: 8, name: "Script", description: "", isComment: 0, id: 4, enabled: true, isCustom: true, initiallyOff: true, runOnInit: false, parent: 2, ecas: [] },
    { type: 16, name: "A comment", description: "note", isComment: 1, id: 5, enabled: false, isCustom: false, initiallyOff: false, runOnInit: false, parent: 2, ecas: [] },
  ],
});

test("Reforged trigger file: what's written reads back the same, and again byte for byte", () => {
  const f = reforged(), bytes = writeWtg(f), back = parseWtg(bytes, data);
  assert.deepEqual(back, f);
  assert.deepEqual(writeWtg(back), bytes);
});

test("the Reforged layout: magic, marker, version", () => {
  const b = writeWtg(reforged()), dv = new DataView(b.buffer, b.byteOffset);
  assert.equal(new TextDecoder().decode(b.subarray(0, 4)), "WTG!");
  assert.equal(dv.getUint32(4, true), 0x80000004);
  assert.equal(dv.getUint32(8, true), 7);
});

test("JSON form: the same file, and the same bytes", () => {
  const f = reforged(), json = writeWtgJson(f);
  assert.deepEqual(parseWtgJson(json), f);
  assert.deepEqual(writeWtg(parseWtgJson(json)), writeWtg(f));
  assert.equal(writeWtgJson(parseWtgJson(json)), json);
});

for (const version of [7, 4]) {
  test(`classic trigger file, version ${version}`, () => {
    const eca = version === 7 ? branch : { ...setScore, params: [{ type: 1, value: "Score" }, { type: 3, value: "5" }] };
    const f: TriggerFile = {
      reforged: false, version, counts: [], unknown: 2,
      variables: [{ name: "Score", type: "integer", unknown: 1, isArray: false, arraySize: 1, initialized: false, initialValue: "", id: 0, parent: -1 }],
      items: [
        { type: 4, id: 0, name: "Melee", isComment: 0, expanded: 1, parent: -1 },
        { type: 8, name: "Start", description: "", isComment: 0, id: 0, enabled: true, isCustom: false, initiallyOff: false, runOnInit: false, parent: 0, ecas: [eca] },
      ],
    };
    const bytes = writeWtg(f);
    assert.deepEqual(parseWtg(bytes, data), f);
    assert.deepEqual(writeWtg(parseWtg(bytes, data)), bytes);
  });
}

test("damaged trigger files are refused, not half read", () => {
  const b = writeWtg(reforged());
  assert.throws(() => parseWtg(b.subarray(0, b.length - 3), data));
  assert.throws(() => parseWtg(new Uint8Array([...b, 1, 2, 3]), data), /bytes after/);
  assert.throws(() => parseWtg(new TextEncoder().encode("NOPE...."), data), /WTG!/);
  const other = new Uint8Array(b);
  new DataView(other.buffer).setUint32(4, 5, true);
  assert.throws(() => parseWtg(other, data), /version 5/);
});

test("a function TriggerData doesn't know stops reading (extended editors)", () => {
  const f = reforged();
  (f.items[3] as { ecas: Eca[] }).ecas[1] = { ...setScore, name: "YDWESetAnyTypeLocal" };
  assert.throws(() => parseWtg(writeWtg(f), data), /unknown trigger function "YDWESetAnyTypeLocal"/);
});

test("names and text in old code pages survive reading and writing", () => {
  const korean = new Uint8Array([0xc7, 0xd1, 0xb1, 0xb9]), name = new TextDecoder("latin1").decode(korean);
  const f = reforged(), plain = writeWtg(f);
  // The same file with the trigger's name replaced by CP949 bytes of the same length.
  (f.items[3] as { name: string }).name = "KORE";
  const b = writeWtg(f), at = Buffer.from(b).indexOf("KORE");
  b.set(korean, at);
  const back = parseWtg(b, data);
  assert.notEqual((back.items[3] as { name: string }).name, name);
  assert.deepEqual(writeWtg(back), b);
  assert.deepEqual(writeWtg(parseWtgJson(writeWtgJson(back))), b);
  assert.equal(plain.length, b.length + "Start".length - 4);
  const c: CustomTextFile = { reforged: true, version: 1, comment: "", header: null, texts: [] };
  const wct = writeWct(c), withText = new Uint8Array([...wct.subarray(0, wct.length - 4), 3, 0, 0, 0, 0xc7, 0xd1, 0]);
  assert.deepEqual(writeWct(parseWct(withText, 0)), withText);
});

test("text triggers: in item order, only those with text", () => {
  assert.deepEqual(textTriggers(reforged()).map((t) => t.name), ["Start", "Script"]);
});

const texts = (): CustomTextFile => ({ reforged: true, version: 1, comment: "map comment", header: "function H takes nothing returns nothing\r\nendfunction", texts: ["// ü", null, ""] });

test("custom script, Reforged: null and empty stay different", () => {
  const f = texts(), bytes = writeWct(f);
  assert.deepEqual(parseWct(bytes, 3), f);
  assert.deepEqual(writeWct(parseWct(bytes, 3)), bytes);
});

test("custom script, classic: with and without a header", () => {
  const v1: CustomTextFile = { reforged: false, version: 1, comment: "c", header: "// header", texts: ["a", null] };
  assert.deepEqual(parseWct(writeWct(v1), 2), v1);
  const v0: CustomTextFile = { reforged: false, version: 0, comment: "", header: null, texts: ["a", "b"] };
  assert.deepEqual(parseWct(writeWct(v0), 2), v0);
});

test("custom script as text: back to the same file, trigger names are only comments", () => {
  const f = texts(), text = writeWctText(f, ["Start", "Script", "Other"]);
  assert.match(text, /^\/\/== trigger 1 \(no text\): Script ==/m);
  assert.deepEqual(parseWctText(text), f);
  assert.deepEqual(writeWct(parseWctText(text)), writeWct(f));
  const lf: CustomTextFile = { ...f, header: "a\nb", texts: ["c"] };
  assert.deepEqual(parseWctText(writeWctText(lf)), lf);
});

test("custom script as text: a hand-damaged file is refused", () => {
  assert.throws(() => parseWctText("no header line\n"), /first line/);
  const good = writeWctText(texts());
  assert.throws(() => parseWctText(good.replace("trigger 1", "trigger 7")), /trigger 7 where trigger 1/);
  assert.throws(() => parseWctText(good.replace("//== header ==", "//== trigger 0 ==")), /expected|header/);
});
