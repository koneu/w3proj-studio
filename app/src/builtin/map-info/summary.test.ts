import assert from "node:assert/strict";
import { test } from "node:test";
import { StringTable } from "../../lib/formats/wts";
import { mapSummary, setMapText, setW3iColorHex, w3iColorHex } from "./summary";

const resolve = (v: string) => v.replace("TRIGSTR_", "text ");
const info = {
  version: 31, editorVersion: 6060, name: "TRIGSTR_1", author: "TRIGSTR_2", description: "d", suggestedPlayers: "2",
  playableWidth: 64, playableHeight: 48, tileset: "L", scriptType: 1,
  loadingScreen: { model: "x.mdx", text: "TRIGSTR_3", title: "t", subtitle: "" },
  prologue: { text: "", title: "", subtitle: "" },
  weather: "RAlr", soundEnvironment: "Default", lightEnvironment: "",
  players: [{ id: 0, controller: 1, race: 2, name: "TRIGSTR_4", start: [1, 2] }, { id: 3, controller: 2, race: 9, name: "AI", start: [3, 4] }],
  forces: [{ players: 0b1001, name: "TRIGSTR_5" }, { players: 0b0001, name: "One" }],
  upgrades: [{}], techs: [], unitTables: [], itemTables: [{}, {}],
};

test("a text in the string table stays there; a text in the file changes there", () => {
  const table = new StringTable("STRING 1\n{\nOld name\n}\n");
  const doc = { name: "TRIGSTR_001", author: "Me", loadingScreen: { title: "TRIGSTR_9" } };
  setMapText(doc, "name", "New name", table);
  assert.equal(doc.name, "TRIGSTR_001");
  assert.ok(table.serialize().includes("New name"));
  setMapText(doc, "author", "You", table);
  assert.equal(doc.author, "You");
  setMapText(doc, "loadingTitle", "Not in the table", table);
  assert.equal(doc.loadingScreen.title, "Not in the table");
  assert.throws(() => setMapText(doc, "fog", "x", table), /field must be one of/);
});

test("texts, words and who's in which force", () => {
  const got = mapSummary(info, resolve);
  assert.equal(got.name, "text 1");
  assert.equal(got.scriptLanguage, "lua");
  assert.deepEqual(got.playableSize, [64, 48]);
  assert.deepEqual(got.loadingScreen, { title: "t", subtitle: "", text: "text 3", model: "x.mdx" });
  assert.deepEqual(got.players, [
    { number: 1, name: "text 4", controller: "user", race: "orc", start: [1, 2] },
    { number: 4, name: "AI", controller: "computer", race: 9, start: [3, 4] },
  ]);
  assert.deepEqual(got.forces, [{ name: "text 5", players: [1, 4] }, { name: "One", players: [1] }]);
  assert.deepEqual(got.customized, { upgrades: 1, techs: 0, randomGroups: 0, itemTables: 2 });
});

test("a Reign of Chaos map leaves out what its format doesn't store", () => {
  const { weather, soundEnvironment, lightEnvironment, itemTables, scriptType, ...old } = info;
  const got = mapSummary({ ...old, version: 18, loadingScreen: { text: "", title: "", subtitle: "" } }, resolve);
  assert.equal("environment" in got, false);
  assert.equal("model" in got.loadingScreen, false);
  assert.equal(got.scriptLanguage, "jass");
  assert.equal(got.customized.itemTables, 0);
});

test("w3i colours are blue, green, red, alpha: 03b's red water tint shows red and is stored back in that order", () => {
  // 03b_Water_Tint: the w3i holds 100,100,255,255 and its war3map.j says SetWaterBaseColor(255, 100, 100, 255).
  const tint = [100, 100, 255, 255];
  assert.equal(w3iColorHex(tint), "#ff6464");
  setW3iColorHex(tint, "#102030");
  assert.deepEqual(tint, [0x30, 0x20, 0x10, 255], "alpha kept, red last");
  setW3iColorHex(tint, "not a colour");
  assert.deepEqual(tint, [0x30, 0x20, 0x10, 255]);
});

test("set_map_text: a text in the string table with a line that is just } is refused with the reason, not cut", () => {
  const wts = "STRING 1\r\n{\r\nMy Map\r\n}\r\n\r\nSTRING 2\r\n{\r\nKept\r\n}\r\n";
  const doc = { name: "TRIGSTR_001", author: "", description: "", suggestedPlayers: "", loadingScreen: { title: "", subtitle: "", text: "" } };
  const table = new StringTable(wts);
  setMapText(doc, "name", "First\n}\nSecond", table);
  assert.throws(() => table.serialize(), /string 1 .*" }"/);
});
