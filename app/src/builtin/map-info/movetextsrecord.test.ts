// Move Texts and the record of dropped strings (.w3proj/pruned-strings.json): what it drops is recorded before the
// table is written, and a string added afterwards never takes a recorded number. Runs moveTextsToStringTable on an
// in-memory project.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { W3Api } from "../../extensions/api";
import { MCP_EDITS_SERVICE } from "../../extensions/services";
import { PRUNED_STRINGS_FILE, parsePrunedStrings } from "../../lib/formats/prunedstrings";
import { StringTable } from "../../lib/formats/wts";
import { moveTextsToStringTable } from "./movetexts";

const block = (n: number, text: string) => `STRING ${n}\r\n{\r\n${text}\r\n}\r\n\r\n`;
const WTS = "map/war3map.wts";
const W3U = "map/war3map.w3u.json";
const units = (name: string) => JSON.stringify({ format: "w3proj.objects/1", version: 3, original: [],
  custom: [{ base: "hfoo", id: "h000", mods: [{ field: "unam", type: "string", value: name }] }] });

function project(initial: Record<string, string>) {
  const files = new Map(Object.entries(initial));
  const writes: string[] = [];
  const w3 = {
    workspace: {
      project: () => ({ root: "/p" }),
      filesReady: async () => {},
      files: () => [...files.keys()].map((path) => ({ path })),
      readText: async (p: string) => { const t = files.get(p); if (t === undefined) throw new Error("x (os error 2)"); return t; },
      readBytes: async (p: string) => new TextEncoder().encode(files.get(p) ?? ""),
      writeText: async (p: string, t: string) => { writes.push(p); files.set(p, t); },
      // No trigger folders in these projects.
      readTriggers: async () => null,
    },
    commands: { execute: async () => {} },
    game: { readText: async () => { throw new Error("no game"); } },
    backend: { invoke: async (_cmd: string, a: { text: string }) => a.text },
    window: { showInfo: async () => undefined, showError: async () => undefined },
    services: {
      get: async (name: string) => {
        assert.equal(name, MCP_EDITS_SERVICE);
        return { edit: async (_t: string, change: (read: (p: string) => Promise<string | null>) => Promise<{ path: string; text: string }[]>) => {
          const out = await change(async (p) => files.get(p) ?? null);
          for (const o of out) { writes.push(o.path); files.set(o.path, o.text); }
          return out.length > 0;
        } };
      },
    },
  } as unknown as W3Api;
  return { w3, files, writes };
}

test("dropped strings are recorded before the table is written, and a later string never reuses their numbers", async () => {
  // 1 is used by the map's name, 2 and 5 nothing refers to; the unit has a literal name to move.
  const p = project({
    [WTS]: "\uFEFF" + block(1, "Map") + block(2, "gone two") + block(5, "gone\r\nfive"),
    "map/war3map.w3i.json": JSON.stringify({ name: "TRIGSTR_001" }),
    [W3U]: units("Footman"),
  });
  const first = await moveTextsToStringTable(p.w3);
  assert.equal(first.dropped, 2);
  assert.equal(first.moved, 1);
  const record = parsePrunedStrings(p.files.get(PRUNED_STRINGS_FILE)!);
  assert.deepEqual([...record], [[2, "gone two"], [5, "gone\nfive"]]);
  assert.ok(p.writes.indexOf(PRUNED_STRINGS_FILE) < p.writes.indexOf(WTS), "the record is written before the table");
  const table1 = new StringTable(p.files.get(WTS)!);
  assert.equal(table1.get(2), undefined);
  assert.equal(table1.get(5), undefined);

  // A string added afterwards (another literal) numbers after the recorded ones.
  p.files.set(W3U, units("Rifleman"));
  const second = await moveTextsToStringTable(p.w3);
  assert.equal(second.moved, 1);
  const table2 = new StringTable(p.files.get(WTS)!);
  const added = [...table2.entries()].filter(([, v]) => v === "Rifleman").map(([n]) => n);
  assert.equal(added.length, 1);
  assert.ok(added[0] > 5, `new string number ${added[0]} must come after the recorded 5`);
  assert.deepEqual([...parsePrunedStrings(p.files.get(PRUNED_STRINGS_FILE)!).keys()].filter((n) => n <= 5), [2, 5], "still recorded");
});

test("a record that can't be read stops Move Texts before anything is written", async () => {
  const p = project({ [WTS]: "\uFEFF" + block(1, "Map") + block(2, "x"), "map/war3map.w3i.json": JSON.stringify({ name: "TRIGSTR_001" }),
    [PRUNED_STRINGS_FILE]: "{" });
  const before = p.files.get(WTS);
  await assert.rejects(moveTextsToStringTable(p.w3), /pruned-strings\.json/);
  assert.equal(p.files.get(WTS), before);
});
