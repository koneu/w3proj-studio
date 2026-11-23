import assert from "node:assert/strict";
import { test } from "node:test";
import { StringTable } from "../../lib/formats/wts";
import { mapTextEdit } from "./textedit";

/** flat.w3x's war3map.w3i as make-melee-valid.mjs nowts leaves it (the parts that count here). */
const flat = () => ({
  name: "Meleedry", author: "Unknown", description: "Nondescript", suggestedPlayers: "Any", gameDataSet: 4294967295,
  cameraZoom: { default: 0, max: 0, min: 0 },
  loadingScreen: { number: -1, crestRace: 64, model: "", text: "", title: "", subtitle: "" },
  prologue: { path: "", text: "", title: "", subtitle: "" },
  players: [{ id: 0, name: "TRIGSTR_001" }], forces: [{ name: "TRIGSTR_002" }],
});
const FLAT_WTS = "﻿STRING 1\r\n{\r\nPlayer 1\r\n}\r\n\r\nSTRING 2\r\n{\r\nForce 1\r\n}\r\n\r\n";
const block = (n: number, text: string) => `STRING ${n}\r\n{\r\n${text}\r\n}\r\n\r\n`;

test("without war3map.wts: a new table of the map's four texts, the stringless names blanked (the editor's save, byte for byte)", () => {
  const doc = flat();
  // flat.w3x's script names its force TRIGSTR_002 in a comment: made from the w3i, so not taken.
  const r = mapTextEdit(doc, "name", "Renamed Map", null, { taken: [], scriptRefs: [2] });
  // wts-missing-map-name: the World Editor's war3map.wts
  assert.equal(r.wts, `﻿${block(1, "Renamed Map")}${block(2, "Any")}${block(3, "Nondescript")}${block(4, "Unknown")}`);
  assert.deepEqual(r.added.map((s) => s.num), [1, 2, 3, 4]);
  assert.deepEqual([doc.name, doc.suggestedPlayers, doc.description, doc.author], ["TRIGSTR_001", "TRIGSTR_002", "TRIGSTR_003", "TRIGSTR_004"]);
  assert.equal(doc.players[0].name, "");
  assert.equal(doc.forces[0].name, "");
  assert.equal(doc.loadingScreen.crestRace, 128);
  assert.equal(doc.gameDataSet, 0);
  assert.deepEqual(doc.cameraZoom, { default: 1250, max: 1250, min: 1250 });
  // the empty loading texts stay empty, the prologue as it was
  assert.deepEqual([doc.loadingScreen.title, doc.loadingScreen.subtitle, doc.loadingScreen.text], ["", "", ""]);
});

test("with war3map.wts: the texts are numbered on after its strings, the names that have one stay", () => {
  const doc = flat();
  const r = mapTextEdit(doc, "name", "Renamed Map", FLAT_WTS, { taken: [], scriptRefs: [2] });
  // wts-present observation (branch fix/wts-missing-we): STRING 3 to 6 appended, 1 and 2 as they were
  assert.equal(r.wts, `${FLAT_WTS}${block(3, "Renamed Map")}${block(4, "Any")}${block(5, "Nondescript")}${block(6, "Unknown")}`);
  assert.deepEqual([doc.name, doc.author], ["TRIGSTR_003", "TRIGSTR_006"]);
  assert.deepEqual([doc.players[0].name, doc.forces[0].name], ["TRIGSTR_001", "TRIGSTR_002"]);
});

test("numbers the map's other files, a kept prologue reference and the script's other references take are skipped", () => {
  const doc = { ...flat(), prologue: { path: "", text: "TRIGSTR_009", title: "", subtitle: "" } };
  const r = mapTextEdit(doc, "author", "Me", null, { taken: [5], scriptRefs: [2] });
  assert.deepEqual(r.added.map((s) => s.num), [10, 11, 12, 13]);
  assert.equal(doc.prologue.text, "TRIGSTR_009");
  const other = flat();
  // control: a script reference that isn't a blanked text's counts
  assert.deepEqual(mapTextEdit(other, "author", "Me", null, { taken: [], scriptRefs: [7] }).added.map((s) => s.num), [8, 9, 10, 11]);
});

test("a text in the table changes there; a text the table can't hold stays plain; nothing to add leaves no table", () => {
  const wts = `${FLAT_WTS}${block(3, "Old")}`;
  const doc = { ...flat(), name: "TRIGSTR_003", author: "", description: "", suggestedPlayers: "" };
  const r = mapTextEdit(doc, "name", "New", wts, { taken: [], scriptRefs: [] });
  assert.equal(doc.name, "TRIGSTR_003");
  assert.equal(new StringTable(r.wts!).get(3), "New");
  assert.deepEqual(r.added, []);
  const braces = flat();
  const b = mapTextEdit(braces, "description", "a } b", null, { taken: [], scriptRefs: [] });
  assert.equal(braces.description, "a } b");
  assert.deepEqual(b.added.map((s) => s.text), ["Meleedry", "Any", "Unknown"]);
  const empty = { ...flat(), name: "", author: "", description: "", suggestedPlayers: "" };
  assert.equal(mapTextEdit(empty, "name", "", null, { taken: [], scriptRefs: [] }).wts, null);
  assert.throws(() => mapTextEdit(flat(), "fog", "x", null, { taken: [], scriptRefs: [] }), /field must be one of/);
});

test("a stringless reference in a text being set is replaced, not written into a string that isn't there", () => {
  const doc = { ...flat(), name: "TRIGSTR_007" };
  const r = mapTextEdit(doc, "name", "Named", null, { taken: [], scriptRefs: [] });
  assert.equal(new StringTable(r.wts!).get(1), "Named");
  assert.equal(doc.name, "TRIGSTR_001");
});
