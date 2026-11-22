import assert from "node:assert/strict";
import { test } from "node:test";
import { withOwnCommon } from "./owncommon";
import { checkJass, envFrom } from "./check";

const game = [
  "type agent extends handle",
  "type unit extends agent",
  "native GetUnitX takes unit whichUnit returns real",
  "globals",
  "    constant integer PLAYER_NEUTRAL_AGGRESSIVE = 24",
  "    constant real BRAND_NEW = 1.0 // newer than the map's file",
  "endglobals",
  "native BlzGetUnitSkin takes unit whichUnit returns integer",
  "",
].join("\r\n");

// WoW Reforged's own common.j: older (no BlzGetUnitSkin, no BRAND_NEW), with constants and natives of its own.
const own = [
  "type agent extends handle",
  "type unit extends agent",
  "type itemvalue extends handle",
  "native GetUnitX takes unit u returns real",
  "globals",
  "    constant integer PLAYER_NEUTRAL_AGGRESSIVE = 24",
  "    constant integer ITEM_VALUES_DUMMY_HERO = 'Hpal'",
  "    // a comment line",
  "    constant itemvalue ITEM_VALUE_NONE = null",
  "endglobals",
  "native GetUnitGoldCost takes integer unitid returns integer",
  "native GetUnitWoodCost takes integer unitid returns integer",
].join("\r\n");

test("the map's own common.j adds what the game's lacks, the game's declarations stay its own", () => {
  const merged = withOwnCommon(game, own);
  assert.ok(merged.startsWith(game), "the game's file comes first, as it is");
  const added = merged.slice(game.length);
  for (const want of ["type itemvalue extends handle", "constant integer ITEM_VALUES_DUMMY_HERO = 'Hpal'", "constant itemvalue ITEM_VALUE_NONE = null",
    "native GetUnitGoldCost takes integer unitid returns integer", "native GetUnitWoodCost takes integer unitid returns integer"]) {
    assert.ok(added.includes(want), `${want} was added`);
  }
  // Declared by both: never twice (the game's signature wins), nor comments.
  for (const not of ["GetUnitX", "PLAYER_NEUTRAL_AGGRESSIVE", "type unit ", "a comment line"]) assert.ok(!added.includes(not), `${not} isn't added again`);
  assert.ok(!/\n(?!\r)/.test(merged.replace(/\r\n/g, "")), "the game's line ends throughout");
  // The type comes before the globals that use it, the globals in a block of their own.
  assert.ok(added.indexOf("type itemvalue") < added.indexOf("globals\r\n") && added.indexOf("globals\r\n") < added.indexOf("ITEM_VALUE_NONE"));
});

test("a script using both files' declarations checks against the merged common.j (and fails with either alone)", () => {
  const script = [
    "function f takes unit u returns integer",
    "    local integer a = BlzGetUnitSkin(u) + GetUnitGoldCost(ITEM_VALUES_DUMMY_HERO)",
    "    return a",
    "endfunction",
  ].join("\n");
  const errors = (common: string) => checkJass(script, envFrom([common])).filter((d) => d.severity === "error");
  assert.deepEqual(errors(withOwnCommon(game, own)), []);
  assert.ok(errors(game).length > 0, "control: the game's alone lacks the map's natives and constants");
  assert.ok(errors(own).length > 0, "control: the map's alone lacks the game's newer natives");
});

test("nothing to add: the game's file as it is", () => {
  assert.equal(withOwnCommon(game, game), game);
  assert.equal(withOwnCommon(game, ""), game);
});
