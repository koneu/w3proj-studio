import assert from "node:assert/strict";
import { test } from "node:test";
import { commonJFor, commonJMismatch } from "./owncommon";
import { checkJass, envFrom } from "./check";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gameFiles, mainCheckout } from "../testhelpers/gamefiles";
import { skipOrFail } from "../testhelpers/testutil";

const game = [
  "type agent extends handle",
  "type unit extends agent",
  "native GetUnitX takes unit whichUnit returns real",
  "globals",
  "    constant integer PLAYER_NEUTRAL_AGGRESSIVE = 24",
  "    constant real BRAND_NEW = 1.0 // newer than WoW Reforged's file",
  "endglobals",
  "native BlzGetUnitSkin takes unit whichUnit returns integer",
  "",
].join("\r\n");

// Everything of the game's (other parameter names, comments, another order) plus declarations of its own.
const compatible = [
  "type unit extends agent",
  "type agent extends handle",
  "type itemvalue extends handle",
  "native BlzGetUnitSkin takes unit u returns integer // the map's comment",
  "constant native GetUnitX takes unit u returns real",
  "globals",
  "    constant real BRAND_NEW = 2.0",
  "    constant integer PLAYER_NEUTRAL_AGGRESSIVE = 24",
  "    constant integer ITEM_VALUES_DUMMY_HERO = 'Hpal'",
  "endglobals",
  "native GetUnitGoldCost takes integer unitid returns integer",
].join("\r\n");

// WoW Reforged's own common.j: older (no BlzGetUnitSkin, no BRAND_NEW), with constants and natives of its own.
const older = [
  "type agent extends handle",
  "type unit extends agent",
  "native GetUnitX takes unit u returns real",
  "globals",
  "    constant integer PLAYER_NEUTRAL_AGGRESSIVE = 24",
  "    constant integer ITEM_VALUES_DUMMY_HERO = 'Hpal'",
  "endglobals",
  "native GetUnitGoldCost takes integer unitid returns integer",
].join("\r\n");

test("a compatible own common.j is used as it is, instead of the game's (never merged)", () => {
  assert.deepEqual(commonJMismatch(game, compatible), { lacks: [], changes: [] });
  const r = commonJFor(game, compatible);
  assert.equal(r.text, compatible);
  assert.equal(r.from, "map");
  assert.equal(r.warning, undefined);
  // The map's extra declarations reach the check, and so do the game's (the map's file declares them too).
  const script = "function f takes unit u returns integer\n    return BlzGetUnitSkin(u) + GetUnitGoldCost(ITEM_VALUES_DUMMY_HERO)\nendfunction\n";
  assert.deepEqual(checkJass(script, envFrom([r.text])).filter((d) => d.severity === "error"), []);
});

test("an own common.j lacking the game's newer declarations isn't used: the game's is, with a warning naming them", () => {
  assert.deepEqual(commonJMismatch(game, older), { lacks: ["native BlzGetUnitSkin", "global BRAND_NEW"], changes: [] });
  const r = commonJFor(game, older);
  assert.equal(r.text, game, "the game's file as it is, nothing of the map's added");
  assert.equal(r.from, "game");
  assert.ok(!r.text.includes("GetUnitGoldCost"));
  assert.match(r.warning ?? "", /lacks 2 of the game's declarations \(native BlzGetUnitSkin, global BRAND_NEW\)/);
});

test("an own common.j that changes a game declaration isn't used either", () => {
  const changed = compatible.replace("native GetUnitX takes unit u returns real", "native GetUnitX takes unit u returns integer")
    .replace("type unit extends agent", "type unit extends handle")
    .replace("constant real BRAND_NEW", "real BRAND_NEW");
  assert.deepEqual(commonJMismatch(game, changed), { lacks: [], changes: ["type unit", "native GetUnitX", "global BRAND_NEW"] });
  const r = commonJFor(game, changed);
  assert.equal(r.text, game);
  assert.match(r.warning ?? "", /declares 3 otherwise \(type unit, native GetUnitX, global BRAND_NEW\)/);
});

test("no own common.j: the game's, without a warning", () => {
  assert.deepEqual(commonJFor(game, null), { text: game, from: "game" });
  // An empty file is a file: it lacks everything.
  assert.equal(commonJFor(game, "").from, "game");
  assert.ok(commonJFor(game, "").warning);
  // The game's own file is compatible with itself.
  assert.equal(commonJFor(game, game).from, "map");
});

/** The game's real common.j is compatible with itself, and WoW Reforged's (smoketest_maps/wowr4.6, a project: its own
 *  map/Scripts/common.j) isn't: it lacks some of the game's newer natives, so the game's is used and the warning names them. */
test("real files: the game's common.j against itself and against WoW Reforged's", (ctx) => {
  const [gameCommon] = gameFiles(["War3.w3mod:Scripts/common.j"]).map((f) => new TextDecoder().decode(f.bytes));
  if (!gameCommon) return skipOrFail(ctx, "no game or release CLI");
  assert.deepEqual(commonJMismatch(gameCommon, gameCommon), { lacks: [], changes: [] });
  const where = mainCheckout();
  const project = where ? join(process.env.W3PROJ_CORPUS ?? join(where.main, "smoketest_maps"), "wowr4.6", "map") : "";
  if (!existsSync(join(project, "Scripts", "common.j"))) return skipOrFail(ctx, "no smoketest_maps/wowr4.6");
  const own = readFileSync(join(project, "Scripts", "common.j"), "utf8");
  const { lacks } = commonJMismatch(gameCommon, own);
  assert.ok(lacks.some((l) => l.startsWith("native ")), `WoW Reforged's lacks some of the game's natives (${lacks.slice(0, 5).join(", ")})`);
  const r = commonJFor(gameCommon, own);
  assert.equal(r.text, gameCommon);
  assert.ok(r.warning?.includes(lacks[0]));
});
