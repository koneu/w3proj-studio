import assert from "node:assert/strict";
import { test } from "node:test";
import { toArchiveName, toProjectPath } from "./archivepath";
import { listItem, parseIni, parseSlk } from "./text";
import { StringTable } from "./wts";

test("SLK rows are keyed by the header row; the cursor carries over between cells", () => {
  const rows = parseSlk([
    "ID;PWXL;N;E",
    "B;X3;Y3;D0",
    'C;X1;Y1;K"cliffID"',
    'C;X2;K"texDir"',
    'C;X1;Y2;K"CLdi"',
    'C;X2;K"TerrainArt\\LordaeronSummer"',
    "C;X1;Y3;K\"CLgr\"",
    "F;X2;Y3",
    "C;K12",
    "E",
  ].join("\r\n"));
  assert.deepEqual(rows, [
    { cliffID: "CLdi", texDir: "TerrainArt\\LordaeronSummer" },
    { cliffID: "CLgr", texDir: "12" },
  ]);
});

test("INI sections: keys lower-cased, quotes removed, comments skipped; comma lists honour quotes", () => {
  const ini = parseIni("[TerrainLights]\r\n// comment\r\nL=\"Environment\\DNC\\DNCLordaeronTerrain.mdl\"\r\nA = x\r\n[Other]\r\nKey=1");
  assert.equal(ini.get("TerrainLights")?.get("l"), "Environment\\DNC\\DNCLordaeronTerrain.mdl");
  assert.equal(ini.get("TerrainLights")?.get("a"), "x");
  assert.equal(ini.get("Other")?.get("key"), "1");
  assert.equal(listItem('"a, b",c', 0), "a, b");
  assert.equal(listItem('"a, b",c', 1), "c");
});

test("string table edits change only the edited block", () => {
  const text = "STRING 1\r\n{\r\nJust another Warcraft III map\r\n}\r\n\r\nSTRING 2 // comment\r\n{\r\nPlayer 1\r\n}\r\n";
  const t = new StringTable(text);
  assert.equal(StringTable.ref("TRIGSTR_002"), 2);
  assert.equal(StringTable.ref("Player"), null);
  assert.equal(t.resolve("TRIGSTR_001"), "Just another Warcraft III map");
  assert.equal(t.dirty, false);
  t.set(2, "Red\nPlayer");
  assert.equal(t.dirty, true);
  assert.equal(t.serialize(), text.replace("Player 1", "Red\r\nPlayer"));
  t.markSaved();
  assert.equal(t.dirty, false);
});

test("archive names ↔ project paths escape what Windows can't store", () => {
  assert.equal(toProjectPath("war3mapImported\\x.mdx"), "war3mapImported/x.mdx");
  assert.equal(toProjectPath("a:b\\CON.txt"), "a%3Ab/%43ON.txt");
  assert.equal(toProjectPath("name."), "name%2E");
  for (const name of ["war3mapImported\\x.mdx", "a:b\\CON.txt", "name.", "100%\\done?.blp", "Ünicode\\ß.wav"]) {
    assert.equal(toArchiveName(toProjectPath(name)), name);
  }
});
