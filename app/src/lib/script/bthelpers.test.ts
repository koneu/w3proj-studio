import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { betterTriggersHelpers, hasBetterTriggersHelpers } from "./bthelpers";
import { generateScript as generate, type ScriptInput } from "./jass";
import { parseTriggerData } from "../triggers/triggerdata";
import { lostFunctions } from "./guard";
import { gameCli, mainCheckout } from "../testhelpers/gamefiles";
import { skipOrFail } from "../testhelpers/testutil";

const data = parseTriggerData("[TriggerTypes]\ninteger=0,1,1,Integer\n");
const info = (lua: boolean) => ({
  name: "Test Map", author: "Someone", description: "D", version: 28, editorVersion: 7003, scriptType: lua ? 1 : 0, flags: 0, tileset: "L", cameraBounds: [-1024, -1024, 1024, 1024],
  soundEnvironment: "", lightEnvironment: "", players: [{ id: 0, controller: 1, race: 1, fixedStart: 0, name: "P", start: [0, 0], allyLow: 0, allyHigh: 0 }],
  forces: [{ flags: 0, players: 1, name: "F" }],
});
const generateScript = (i: Partial<ScriptInput> & { info: ScriptInput["info"] }) => generate({ data, lights: { terrain: "T.mdl", unit: "U.mdl" }, ...i });

test("a Lua script with the Better Triggers helpers gets them again after InitGlobals; others, and JASS, don't", () => {
  const withHelpers = generateScript({ info: info(true), betterTriggers: true });
  const plain = generateScript({ info: info(true) });
  assert.ok(hasBetterTriggersHelpers(withHelpers) && !hasBetterTriggersHelpers(plain));
  const at = withHelpers.indexOf("function array2DLua("), init = withHelpers.indexOf("function InitGlobals(");
  assert.ok(init >= 0 && at > init, "after InitGlobals");
  assert.ok(withHelpers.includes("\r\nfunction BlzCreateFrameBT(name, owner, priority, createContext, attachEvents)\r\n"), "Lua's CRLF, as the map's own lines");
  // Replacing the one with the other loses nothing but these helpers, which come back.
  assert.equal(lostFunctions(withHelpers, plain).length, 35, "array2DLua, FrameAttachEvents and 33 *BT functions");
  assert.deepEqual(lostFunctions(withHelpers, generateScript({ info: info(true), betterTriggers: true })), []);
  assert.ok(!hasBetterTriggersHelpers(generateScript({ info: info(false), betterTriggers: true })), "a JASS map never");
});

/** FOE (smoketest_maps), the Lua map saved with Better Triggers: its script's helper block is ours, line for line (but for
 *  the indented banner line after array2DLua and the next section's banner glued to the last `end`, as it has them). */
test("Fires Over Eversong's helpers are the ones written", (ctx) => {
  const cli = gameCli(), where = mainCheckout();
  const map = where ? join(process.env.W3PROJ_CORPUS ?? join(where.main, "smoketest_maps"), "FiresOverEversong(FOE)-v3.0.0.w3x") : "";
  if (!cli || !existsSync(map)) return skipOrFail(ctx, "no release CLI or no smoketest_maps/FiresOverEversong(FOE)-v3.0.0.w3x");
  const r = spawnSync(cli.bin, ["cat", map, "war3map.lua"], { maxBuffer: 1 << 28 });
  assert.equal(r.status, 0, String(r.stderr));
  const script = r.stdout.toString("utf8");
  assert.ok(hasBetterTriggersHelpers(script));
  const from = script.indexOf("function array2DLua("), to = script.indexOf("end-----", from);
  assert.ok(from > 0 && to > from);
  const theirs = script.slice(from, to + 3).split("\r\n").map((l) => (/^\s+-{20,}$/.test(l) ? l.trim() : l));
  const ours = betterTriggersHelpers();
  while (ours[ours.length - 1] === "") ours.pop();
  assert.deepEqual(theirs, ours);
});
