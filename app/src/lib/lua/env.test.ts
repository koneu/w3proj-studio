import assert from "node:assert/strict";
import { test } from "node:test";
import { MINI_BLIZZARD_J, MINI_COMMON_J } from "../jass/mini-game.fixture";
import { checkLua } from "./check";
import { gameLuaApi, mapLuaNames } from "./env";

const FILES: Record<string, string> = {
  "Scripts\\common.j": MINI_COMMON_J,
  "Scripts\\Blizzard.j": MINI_BLIZZARD_J,
  "Scripts\\common.ai": "native UnitAlive takes unit id returns boolean\n",
};

test("the game's Lua API: null while the game's scripts can't be read, then read (and kept)", async () => {
  // Without common.ai names can't be judged: its natives would be taken for unknown.
  const lacking = async (p: string) => { if (!(p in FILES) || p.endsWith(".ai")) throw new Error(`no ${p}`); return FILES[p]; };
  assert.equal(await gameLuaApi(lacking), null);
  let reads = 0;
  const read = async (p: string) => { reads++; if (!(p in FILES)) throw new Error(`no ${p}`); return FILES[p]; };
  const api = await gameLuaApi(read);
  assert.ok(api?.has("UnitAlive") && api.has("Player") && api.has("BJDebugMsg") && api.has("pairs"));
  const after = reads;
  assert.equal(await gameLuaApi(read), api, "read once");
  assert.equal(reads, after);
});

test("a text in a map: the API and the map's scripts' globals; a script with dynamic globals: not judged", async () => {
  const read = async (p: string) => FILES[p];
  const text = "function F()\n  Helper()\n  UnitAlive(nil)\n  Nope()\nend\n";
  const names = await mapLuaNames(read, ["function Helper() end\n", null]);
  assert.deepEqual(checkLua(text, names).map((p) => p.message), ["Unknown function Nope"]);
  assert.equal(await mapLuaNames(read, ["load(s)()\n"]), null);
});
