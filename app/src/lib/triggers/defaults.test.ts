import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultTriggerFile, defaultWct, defaultWtg, resetTriggers } from "./defaults";
import { parseWct, parseWtg, textTriggers, writeWct, writeWtg, type CustomTextFile, type TriggerFile } from "./wtg";
import type { TriggerData } from "./triggerdata";

const noArgs = { find: () => ({ args: [] }) } as unknown as TriggerData;

/** A map's triggers after some work: two categories, three triggers, a variable, custom script. */
function worked(): { file: TriggerFile; custom: CustomTextFile } {
  const file = defaultTriggerFile("My Map");
  const melee = file.items.find((i) => i.type === 8)!;
  file.items.push({ type: 4, id: 0x02000001, name: "More", isComment: 1, expanded: 1, parent: 0 });
  file.items.push({ ...structuredClone(melee), name: "Second", id: 0x03000001, parent: 0x02000001 } as typeof melee);
  file.items.push({ ...structuredClone(melee), name: "Third", id: 0x03000002, parent: 0x02000001, isCustom: true } as typeof melee);
  file.variables.push({ name: "x", type: "integer", unknown: 1, isArray: false, arraySize: 1, initialized: false, initialValue: "", id: 0x06000000, parent: 0x02000001 });
  file.counts[2].count = 2;
  file.counts[3].count = 3;
  const custom = { ...parseWct(defaultWct(), 1), header: "// my code", texts: [null, null, "function X takes nothing returns nothing\nendfunction"] };
  return { file, custom };
}

test("Reset Triggers on a Reforged file: the new map's trigger file, under the map's root name", () => {
  const { file, custom } = worked();
  const r = resetTriggers(file, custom);
  assert.deepEqual(writeWtg(r.file), defaultWtg("My Map"), "the default file, byte for byte");
  assert.equal(r.file.variables.length, 0);
  assert.deepEqual(textTriggers(r.file).map((t) => t.name), ["Melee Initialization"]);
  // Custom script: no header, one (empty) text for the one trigger, the comment kept.
  assert.equal(r.custom.header, parseWct(defaultWct(), 1).header);
  assert.deepEqual(r.custom.texts, [null]);
  assert.equal(r.custom.comment, custom.comment);
  assert.deepEqual(parseWct(writeWct(r.custom), 1), r.custom, "the custom script file reads back the same");
  // The input stays as it was (the editor's undo keeps it).
  assert.equal(file.items.length, 6);
});

test("Reset Triggers on a classic file keeps its layout and reads back", () => {
  for (const version of [4, 7]) {
    const classic: TriggerFile = {
      reforged: false, version, counts: [], unknown: 2,
      variables: [{ name: "x", type: "integer", unknown: 1, isArray: false, arraySize: 1, initialized: false, initialValue: "", id: 0, parent: -1 }],
      items: [
        { type: 4, id: 0, name: "A", isComment: 0, expanded: 1, parent: -1 },
        { type: 4, id: 1, name: "B", isComment: 0, expanded: 1, parent: -1 },
        { type: 8, name: "T", description: "", isComment: 0, id: 0, enabled: true, isCustom: false, initiallyOff: false, runOnInit: false, parent: 1, ecas: [] },
      ],
    };
    const r = resetTriggers(classic, null);
    assert.equal(r.file.reforged, false);
    assert.equal(r.file.version, version);
    const back = parseWtg(writeWtg(r.file), noArgs);
    assert.deepEqual(back.items.map((i) => [i.type, i.name, i.parent]), [[4, "Initialization", -1], [8, "Melee Initialization", 0]]);
    assert.equal(back.variables.length, 0);
    assert.deepEqual(r.custom.texts, [null]);
  }
});
