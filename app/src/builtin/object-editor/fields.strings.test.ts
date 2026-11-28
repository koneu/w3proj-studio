// WorldEditStrings is read and parsed once for the object data's labels (metadata.ts) and the Object Editor's value
// types (fields.ts loadEditorTypes), and the types' three files are asked together. Apart from fields.test.ts: both
// keep what they load for the module's life, and each test file runs in a module of its own.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { W3Api } from "../../extensions/api";
import { loadKind, loadWorldEditStrings } from "../../lib/objects/metadata";
import { loadEditorTypes } from "./fields";

const FILES: Record<string, string> = {
  "UI\\WorldEditStrings.txt": "[WorldEditStrings]\nWESTRING_ARMOR_HUMAN=Human Armor\n",
  "UI\\WorldEditGameStrings.txt": "[WorldEditGameStrings]\nWESTRING_GAME=Game\n",
  "UI\\UnitEditorData.txt": "[armorType]\nNumValues=1\n0=human,WESTRING_ARMOR_HUMAN\n",
  "UI\\WorldEditData.txt": "",
};

test("WorldEditStrings is read once for the labels and the value types, whoever asks first", async () => {
  const reads: string[] = [];
  const w3 = {
    settings: { get: () => undefined },
    game: {
      list: async () => [],
      readText: (path: string) => { reads.push(path); return Promise.resolve(FILES[path] ?? ""); },
    },
  } as unknown as W3Api;
  // The types first, then the kind (as an Object Editor opening does), then the types again and the strings alone.
  const types = await loadEditorTypes(w3);
  await loadKind(w3, "w3t");
  await loadEditorTypes(w3);
  const strings = await loadWorldEditStrings(w3);
  assert.equal(reads.filter((p) => p === "UI\\WorldEditStrings.txt").length, 1, `read once: ${JSON.stringify(reads)}`);
  assert.equal(reads.filter((p) => p === "UI\\WorldEditGameStrings.txt").length, 1);
  assert.equal(strings.get("WESTRING_ARMOR_HUMAN"), "Human Armor");
  assert.equal(strings.get("WESTRING_GAME"), "Game", "both files are merged");
  assert.equal(types.get("armorType")?.entries[0].label, "Human Armor");
  assert.strictEqual(await loadWorldEditStrings(w3), strings, "one parsed map for everyone");
});
