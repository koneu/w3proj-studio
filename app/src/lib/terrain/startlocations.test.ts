import assert from "node:assert/strict";
import { test } from "node:test";
import { addPlayer, firstStart, startLocations, syncPlayers, type PlayerInfo } from "./startlocations";

/** A map that lost its only player: what a deleted start location left behind. */
const noPlayers = (more: Partial<PlayerInfo> = {}): PlayerInfo => ({ version: 39, playerHudSkins: true, players: [], forces: [{ players: 0xfffffffe }], ...more });

test("the first player of a map gets every field its file version needs", () => {
  const p = addPlayer(noPlayers(), 0, [64, 128]);
  assert.deepEqual([p.id, p.controller, p.name, p.start], [0, 1, "Player 1", [64, 128]]);
  assert.equal(p.hudSkin, 0, "v39 with HUD skins stores one per player");
  assert.equal(p.enemyLow, 0);
  assert.equal(p.enemyHigh, 0);
});

test("older versions don't get fields they can't hold", () => {
  const old = addPlayer(noPlayers({ version: 28, playerHudSkins: undefined }), 0, [0, 0]);
  assert.equal("enemyLow" in old, false);
  assert.equal("hudSkin" in old, false);
  assert.equal("hudSkin" in addPlayer(noPlayers({ playerHudSkins: false }), 0, [0, 0]), false);
  assert.equal("hudSkin" in addPlayer(noPlayers({ version: 31, playerHudSkins: undefined }), 0, [0, 0]), false);
});

test("further players still go by the first", () => {
  const info = noPlayers();
  addPlayer(info, 0, [0, 0]);
  const next = addPlayer(info, 3, [64, 64]);
  assert.equal(next.hudSkin, 0);
  assert.deepEqual(info.players.map((p) => p.id), [0, 3]);
});

test("a map with no players comes back whole from a start location", () => {
  const info = noPlayers();
  const start = [{ id: "sloc", player: 0, position: [0, 0, 0] }];
  assert.deepEqual(syncPlayers(info, startLocations(start), new Map()), ["added player 1"]);
  assert.equal(info.players.length, 1);
  assert.equal(info.forces[0].players, 0xffffffff, "back in the force it was taken from");
});

test("the first start goes in the middle of the playable part, on the grid", () => {
  assert.deepEqual(firstStart({ left: -1000, right: 1000, bottom: -500, top: 1500 }), [0, 512]);
  assert.deepEqual(firstStart({ left: 100, right: 230, bottom: 0, top: 0 }), [192, 0]);
});
