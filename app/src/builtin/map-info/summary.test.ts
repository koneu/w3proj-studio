import assert from "node:assert/strict";
import { test } from "node:test";
import { mapSummary } from "./summary";

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
