// The "Strings the map refers to without a string table" check: no war3map.wts, but TRIGSTR_nnn in the map's files.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { W3Api } from "../../extensions/api";
import { missingStrings } from "./checks";

function fake(files: Record<string, string>) {
  return {
    workspace: {
      files: () => Object.keys(files).sort().map((path) => ({ path, size: 1, modified: 1 })),
      readText: async (p: string) => { const t = files[p]; if (t === undefined) throw new Error(`no ${p}`); return t; },
    },
  } as unknown as W3Api;
}

test("without war3map.wts, references to its strings are a warning naming where they are", async () => {
  const found = await missingStrings(fake({ "map/war3map.w3i.json": '{"name":"TRIGSTR_001","author":"TRIGSTR_002"}', "map/war3map.w3u.json": '{"x":"TRIGSTR_040"}', "map/war3map.w3a.json": "{}" }));
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, "warning");
  assert.match(found[0].message, /war3map\.wts is missing but war3map\.w3i, war3map\.w3u refer to 3 strings in it \(TRIGSTR_001, TRIGSTR_002, TRIGSTR_040\)/);
});

test("nothing to report with the table there, with no references, or for a project that isn't a map", async () => {
  assert.deepEqual(await missingStrings(fake({ "map/war3map.w3i.json": '{"name":"TRIGSTR_001"}', "map/war3map.wts": "" })), []);
  assert.deepEqual(await missingStrings(fake({ "map/war3map.w3i.json": '{"name":"Plain"}' })), []);
  assert.deepEqual(await missingStrings(fake({ "src/a.txt": "TRIGSTR_001" })), []);
});

test("a file that can't be read is skipped", async () => {
  const w3 = fake({ "map/war3map.w3i.json": '{"name":"TRIGSTR_001"}', "map/war3map.w3u.json": "x" });
  (w3.workspace as { readText: (p: string) => Promise<string> }).readText = async (p) => { if (p.endsWith("w3u.json")) throw new Error("denied"); return '{"name":"TRIGSTR_001"}'; };
  const found = await missingStrings(w3);
  assert.match(found[0].message, /but war3map\.w3i refers to 1 string in it \(TRIGSTR_001\)/);
});
