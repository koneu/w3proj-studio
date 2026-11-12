import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultTriggerFile, defaultWct, defaultWtg, isDefaultTriggers, parseWtgWithoutArgs, resetTriggers } from "./defaults";
import { parseWct, parseWtg, textTriggers, writeWct, writeWtg, type CustomTextFile, type TriggerFile, type TriggerItem } from "./wtg";
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

/** war3map.wtg World Editor 3.0.1 saved after Reset Triggers on s.w3m (we-drive, 2026-11-09): the root named after
 *  the map file, the category expanded. */
const EDITOR_RESET_S_W3M = "V1RHIQQAAIAHAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIAAAAAAAAAAwAAAAEAAAAAAAAAcy53M20AAAAAAAAAAAD/////BAAAAAAAAAJJbml0aWFsaXphdGlvbgAAAAAAAQAAAAAAAAAIAAAATWVsZWUgSW5pdGlhbGl6YXRpb24ARGVmYXVsdCBtZWxlZSBnYW1lIGluaXRpYWxpemF0aW9uIGZvciBhbGwgcGxheWVycwAAAAAAAAAAAwEAAAAAAAAAAAAAAAAAAAAAAAACCQAAAAAAAABNYXBJbml0aWFsaXphdGlvbkV2ZW50AAEAAAAAAAAAAgAAAE1lbGVlU3RhcnRpbmdWaXNpYmlsaXR5AAEAAAAAAAAAAgAAAE1lbGVlU3RhcnRpbmdIZXJvTGltaXQAAQAAAAAAAAACAAAATWVsZWVHcmFudEhlcm9JdGVtcwABAAAAAAAAAAIAAABNZWxlZVN0YXJ0aW5nUmVzb3VyY2VzAAEAAAAAAAAAAgAAAE1lbGVlQ2xlYXJFeGNlc3NVbml0cwABAAAAAAAAAAIAAABNZWxlZVN0YXJ0aW5nVW5pdHMAAQAAAAAAAAACAAAATWVsZWVTdGFydGluZ0FJAAEAAAAAAAAAAgAAAE1lbGVlSW5pdFZpY3RvcnlEZWZlYXQAAQAAAAAAAAA=";

test("Reset Triggers on a Reforged file is the World Editor's: root named after the map file, the category expanded", () => {
  const { file, custom } = worked();
  const r = resetTriggers(file, custom, "s.w3m");
  assert.deepEqual(writeWtg(r.file), new Uint8Array(Buffer.from(EDITOR_RESET_S_W3M, "base64")), "the editor's file, byte for byte");
});

test("Reset Triggers without a map file name keeps the root's name", () => {
  const { file, custom } = worked();
  const r = resetTriggers(file, custom);
  assert.equal(r.file.items.find((i) => i.type === 1)?.name, "My Map");
  assert.equal(r.file.items.find((i) => i.type === 4 && "expanded" in i && i.expanded === 1)?.name, "Initialization");
});

test("Reset Triggers on a Reforged file: the new map's trigger file otherwise", () => {
  const { file, custom } = worked();
  const r = resetTriggers(file, custom);
  const expanded = parseWtg(defaultWtg("My Map"), noArgs);
  for (const it of expanded.items) if (it.type === 4) it.expanded = 1;
  assert.deepEqual(writeWtg(r.file), writeWtg(expanded), "the default file with its category expanded, byte for byte");
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

// What the World Editor's save doesn't count as custom triggers (we-drive, 2026-11-09): the description didn't count;
// a renamed trigger, a dropped or disabled action did. Anything else unproven reads as custom.
test("only the default trigger file counts as the default", () => {
  assert.equal(isDefaultTriggers(defaultTriggerFile("My Map")), true);
  assert.equal(isDefaultTriggers(parseWtgWithoutArgs(new Uint8Array(Buffer.from(EDITOR_RESET_S_W3M, "base64")))), true, "the editor's own file");
  const { file } = resetTriggers(worked().file, null);
  assert.equal(isDefaultTriggers(file), true, "Reset Triggers");
  const classic = resetTriggers({ ...worked().file, reforged: false, version: 7 }, null).file;
  assert.equal(isDefaultTriggers(classic), true, "a classic file's default");
  const changed = (f: (file: TriggerFile, melee: TriggerItem) => void) => {
    const x = defaultTriggerFile();
    f(x, x.items.find((i) => i.type === 8) as TriggerItem);
    return isDefaultTriggers(x);
  };
  assert.equal(changed((_, m) => { m.description = "Mine"; }), true, "the description doesn't count");
  assert.equal(changed((_, m) => { m.name = "Melee Init"; }), false, "renamed");
  assert.equal(changed((_, m) => { m.ecas.pop(); }), false, "an action dropped");
  assert.equal(changed((_, m) => { m.ecas[3].enabled = false; }), false, "an action disabled");
  assert.equal(changed((_, m) => { m.enabled = false; }), false, "the trigger disabled");
  assert.equal(changed((_, m) => { m.isCustom = true; }), false, "custom text");
  assert.equal(changed((_, m) => { m.ecas.push({ ...m.ecas[1] }); }), false, "an action more");
  assert.equal(changed((_, m) => { m.ecas[1].params = [{ type: 0, value: "1" }]; }), false, "an argument");
  assert.equal(changed((f) => { f.variables.push(worked().file.variables[0]); }), false, "a variable");
  assert.equal(changed((f, m) => { f.items.push({ ...structuredClone(m), name: "Second", id: 0x03000001 }); }), false, "a trigger more");
  assert.equal(isDefaultTriggers(worked().file), false);
});
