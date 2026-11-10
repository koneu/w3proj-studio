import assert from "node:assert/strict";
import { test } from "node:test";
import { toArchiveName, toProjectPath } from "./archivepath";
import { listItem, lookupWestring, parseIni, parseSlk, westring } from "./text";
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

test("two editors saving the string table keep each other's edits", () => {
  const disk0 = "STRING 1\r\n{\r\nMy Map\r\n}\r\n\r\nSTRING 2\r\n{\r\nFootman\r\n}\r\n\r\nSTRING 3\r\n{\r\nLine one\r\nLine two\r\n}\r\n";
  // Both open the same file; Map Properties renames the map, the object editor the unit.
  const mapProps = new StringTable(disk0), objects = new StringTable(disk0);
  mapProps.set(1, "Better Map");
  objects.set(2, "Knight");
  // A multi-line text set with "\n" is unchanged against the file's "\r\n": not an edit.
  objects.set(3, "Line one\nLine two");
  const disk1 = StringTable.merge(disk0, mapProps, disk0);
  mapProps.rebase(disk1);
  const disk2 = StringTable.merge(disk0, objects, disk1);
  assert.equal(disk2, disk0.replace("My Map", "Better Map").replace("Footman", "Knight"));
  // Map Properties sees the object editor's string after its next save, and an unchanged save writes nothing new.
  assert.equal(StringTable.merge(disk1, mapProps, disk2), disk2);
  mapProps.rebase(disk2);
  assert.equal(mapProps.get(2), "Knight");
});

test("archive names ↔ project paths escape what Windows can't store", () => {
  assert.equal(toProjectPath("war3mapImported\\x.mdx"), "war3mapImported/x.mdx");
  assert.equal(toProjectPath("a:b\\CON.txt"), "a%3Ab/%43ON.txt");
  assert.equal(toProjectPath("name."), "name%2E");
  for (const name of ["war3mapImported\\x.mdx", "a:b\\CON.txt", "name.", "100%\\done?.blp", "Ünicode\\ß.wav"]) {
    assert.equal(toArchiveName(toProjectPath(name)), name);
  }
});

test("westring: references, hotkey marks and doubled labels", () => {
  const we = new Map([["WESTRING_A", "WESTRING_B"], ["WESTRING_B", "&Human"], ["WESTRING_C", "Air,&Air"], ["WESTRING_D", "Ground, &Ground"], ["WESTRING_E", "Can't raise, Does decay"]]);
  assert.equal(westring(we, "WESTRING_A"), "Human");
  assert.equal(westring(we, "WESTRING_C"), "Air");
  assert.equal(westring(we, "WESTRING_D"), "Ground");
  assert.equal(westring(we, "WESTRING_E"), "Can't raise, Does decay");
});

test("lookupWestring: chains followed a few steps, a loop ends, a broken step stops at the name, a missing key is undefined", () => {
  const we = new Map([
    ["WESTRING_TRIGTYPE_ATTACKTYPE", "WESTRING_COD_TYPE_ATTACKTYPE"], ["WESTRING_COD_TYPE_ATTACKTYPE", "Attack Type"],
    ["WESTRING_LOOP_A", "WESTRING_LOOP_B"], ["WESTRING_LOOP_B", "WESTRING_LOOP_A"],
    ["WESTRING_BROKEN", "WESTRING_GONE"], ["PLAIN", "Plain"],
  ]);
  assert.equal(lookupWestring(we, "WESTRING_TRIGTYPE_attacktype"), "Attack Type", "keys in any case");
  assert.equal(lookupWestring(we, "PLAIN"), "Plain");
  assert.match(lookupWestring(we, "WESTRING_LOOP_A") ?? "", /^WESTRING_LOOP_/);
  assert.equal(lookupWestring(we, "WESTRING_BROKEN"), "WESTRING_GONE");
  assert.equal(lookupWestring(we, "WESTRING_NONE"), undefined);
  assert.equal(westring(we, "WESTRING_NONE"), "WESTRING_NONE");
  assert.equal(westring(we, "PLAIN"), "PLAIN", "westring looks up WESTRING_ names only");
});
