import assert from "node:assert/strict";
import { test } from "node:test";
import { exportableScript } from "./index";

const files = (present: Record<string, number[]>, broken: string[] = []) => async (path: string) => {
  if (broken.includes(path)) throw new Error(`${path}: Permission denied (os error 13)`);
  const bytes = present[path];
  if (!bytes) throw new Error(`${path}: No such file or directory (os error 2)`);
  return Uint8Array.from(bytes);
};

test("Export Script takes the Lua script when there is one, else the JASS one, byte for byte", async () => {
  const both = await exportableScript(files({ "map/war3map.lua": [1, 2], "map/war3map.j": [3] }));
  assert.deepEqual([both?.path, [...both!.bytes]], ["map/war3map.lua", [1, 2]]);
  const jass = await exportableScript(files({ "map/war3map.j": [0xe4, 0x0d, 0x0a] }));
  assert.deepEqual([jass?.path, [...jass!.bytes]], ["map/war3map.j", [0xe4, 0x0d, 0x0a]]);
});

test("Export Script: no script is null, an unreadable one is an error and not the other script", async () => {
  assert.equal(await exportableScript(files({})), null);
  await assert.rejects(exportableScript(files({ "map/war3map.j": [1] }, ["map/war3map.lua"])), /Permission denied/);
});
