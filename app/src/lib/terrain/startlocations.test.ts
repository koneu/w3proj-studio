import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addPlayer, applyAllyPriorities, autoAllyPriorities, editorAllyPriorities, firstStart, MODIFY_ALLY_PRIORITIES, startLocations, syncPlayers, type PlayerInfo, type StartPlayer,
} from "./startlocations";

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

// ---- ally priorities: the World Editor's saves (we-drive, World Editor 7003, 2026-11-09) ----------------------------

const user = (id: number, x: number, y: number, more: Partial<StartPlayer> = {}): StartPlayer =>
  ({ id, controller: 1, race: 1, fixedStart: 0, name: `P${id}`, start: [x, y], allyLow: 0, allyHigh: 0, enemyLow: 0, enemyHigh: 0, ...more });
const ids = (mask: number) => [...Array(24).keys()].filter((k) => (mask >>> k) & 1);
/** Each player's [low ids, high ids], as the saved war3map.w3i holds them. */
const masks = (players: StartPlayer[]) => players.map((p) => [ids(p.allyLow), ids(p.allyHigh)]);
const MELEE_FLAGS = 0x9c14;

test("ally priorities: exactly 1.25 times the nearest start is High, exactly 1.5 times Low (we-drive save v1)", () => {
  // Player 0 at the middle, its nearest 1280 away; 1600 is 1.25 times that, 1920 1.5 times.
  const players = [user(0, 0, 0), user(1, 0, 1280, { allyLow: 1 << 2, enemyHigh: 1 }), user(2, 0, -1600), user(3, 1920, 0)];
  assert.equal(applyAllyPriorities({ flags: MELEE_FLAGS, players }), true);
  assert.deepEqual(masks(players), [[[3], [1, 2]], [[], [0]], [[], [0]], [[2], [0, 1]]]);
  assert.equal(players[1].enemyHigh, 0, "the editor takes enemy priorities away");
  assert.equal(applyAllyPriorities({ flags: MELEE_FLAGS, players }), false, "a second save changes nothing");
});

test("ally priorities: 1.24 High, 1.26 and 1.495 Low, 1.505 none (we-drive save v2)", () => {
  const r = 1280, d45 = (k: number) => (k * r) / Math.SQRT2;
  const players = [user(0, 0, 0), user(1, 0, r), user(2, 0, -1.24 * r), user(3, 1.26 * r, 0), user(4, -1.495 * r, 0), user(5, d45(1.505), -d45(1.505))];
  applyAllyPriorities({ flags: MELEE_FLAGS, players });
  assert.deepEqual(masks(players), [[[3, 4], [1, 2]], [[], [0]], [[], [0, 5]], [[1], [0, 5]], [[2], [0, 1]], [[0], [2, 3]]]);
});

test("ally priorities: forces don't matter, a computer player is left out, Modify keeps the map's own (we-drive saves v3, v6, v4)", () => {
  // Two allied forces of diagonal partners in a square: by distance all the same.
  const square = [user(0, -1600, -1600), user(1, 1600, -1600), user(2, 1600, 1600), user(3, -1600, 1600)];
  applyAllyPriorities({ flags: 0x9c54, players: square });
  assert.deepEqual(masks(square), [[[2], [1, 3]], [[3], [0, 2]], [[0], [1, 3]], [[1], [0, 2]]]);
  // A computer between two users: neither gives nor gets; its own masks (the campaign maps' computers have some) stay.
  const withComputer = [user(0, 0, 0), user(1, 0, 1280, { controller: 2, allyLow: 5, enemyLow: 1 }), user(2, 0, -1500)];
  applyAllyPriorities({ flags: MELEE_FLAGS, players: withComputer });
  assert.deepEqual(masks(withComputer), [[[], [2]], [[0, 2], []], [[], [0]]]);
  assert.equal(withComputer[1].enemyLow, 1);
  // Modify ally priorities: as the map has them.
  const own = [user(0, 0, 0, { allyLow: 1 << 1 }), user(1, 0, 1280), user(2, 0, -1400)];
  assert.equal(applyAllyPriorities({ flags: MELEE_FLAGS | MODIFY_ALLY_PRIORITIES, players: own }), false);
  assert.deepEqual(masks(own), [[[1], []], [[], []], [[], []]]);
});

test("ally priorities: not only for melee maps, and a lone player has none (we-drive saves v5, v9)", () => {
  assert.equal(autoAllyPriorities(0x9c10), true, "not melee");
  assert.equal(autoAllyPriorities(0x9c70), true, "custom forces and fixed player settings");
  assert.equal(autoAllyPriorities(0x9c16), false);
  const alone = [user(0, 0, 0, { allyHigh: 2 })];
  applyAllyPriorities({ flags: MELEE_FLAGS, players: alone });
  assert.deepEqual(masks(alone), [[[], []]]);
  // A file version without enemy priorities stays without.
  const old = [user(0, 0, 0, { enemyLow: undefined, enemyHigh: undefined }), user(1, 0, 640, { enemyLow: undefined, enemyHigh: undefined })];
  applyAllyPriorities({ flags: MELEE_FLAGS, players: old });
  assert.equal("enemyLow" in old[0] && old[0].enemyLow !== undefined, false);
  assert.deepEqual(editorAllyPriorities(old), new Map([[0, [0, 2]], [1, [0, 1]]]));
});
