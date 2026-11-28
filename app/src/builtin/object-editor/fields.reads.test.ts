// The value types' three files are asked together (a module of its own: loadEditorTypes keeps what it loads).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { W3Api } from "../../extensions/api";
import { loadEditorTypes } from "./fields";

test("loadEditorTypes asks the strings, UnitEditorData and WorldEditData before any of them has landed", async () => {
  const asked: string[] = [];
  const release: (() => void)[] = [];
  const w3 = {
    game: {
      readText: (path: string) => { asked.push(path); return new Promise<string>((resolve) => release.push(() => resolve(""))); },
    },
  } as unknown as W3Api;
  const loading = loadEditorTypes(w3);
  await new Promise<void>((r) => setImmediate(r));
  assert.deepEqual([...asked].sort(), ["UI\\UnitEditorData.txt", "UI\\WorldEditData.txt", "UI\\WorldEditGameStrings.txt", "UI\\WorldEditStrings.txt"], "all four asked while none has landed");
  for (const go of release) go();
  assert.equal((await loading).size, 0);
});
