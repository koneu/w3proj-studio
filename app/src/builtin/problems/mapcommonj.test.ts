// A map that imports its own Scripts\common.j (or Blizzard.j) has its war3map.j compiled against it: the game reads
// the map's files first. WoW Reforged 4.6 (smoketest_models/wc3_wowr) declares about 160 constants only in its own
// common.j; checked against the game's, its script got 200 false "Unknown variable" errors.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { W3Api } from "../../extensions/api";
import { builtinChecks } from "./checks";
import { mapScriptJassEnv } from "../../lib/jass/env";

const GAME_COMMON = "type agent extends handle\ntype unit extends agent\nnative KillUnit takes unit u returns nothing\n";
const GAME_BLIZZARD = "function DoNothing takes nothing returns nothing\nendfunction\n";
const OWN_COMMON = `${GAME_COMMON}globals\n    constant integer MY_HERO = 'H000'\nendglobals\n`;
const SCRIPT = "function main takes nothing returns nothing\n    local integer i = MY_HERO\n    call DoNothing()\nendfunction\n";

/** A project with war3map.j and the given other files (project path → text, or an Error reading it fails with). */
function project(files: Record<string, string | Error>) {
  const all: Record<string, string | Error> = { "map/war3map.j": SCRIPT, ...files };
  const text = (p: string) => {
    const f = all[p];
    if (f === undefined) throw new Error(`no ${p}`);
    if (f instanceof Error) throw f;
    return f;
  };
  const w3 = {
    workspace: {
      project: () => ({ root: "/p", name: "p", manifest: {}, default_output: "" }),
      files: () => Object.keys(all).map((path) => ({ path, size: 1, modified: 1 })),
      filesReady: async () => {}, unreadable: () => [],
      resolve: (p: string) => `/p/${p}`,
      readText: async (p: string) => text(p),
      readBytes: async (p: string) => new TextEncoder().encode(text(p)),
      onDidChange: () => ({ dispose() {} }),
    },
    backend: {
      // No war3campaign.w3f above: not a chapter map.
      invoke: async (command: string) => { if (command === "fs_exists") return false; throw new Error(`${command}: not in this test`); },
    },
    game: {
      readText: async (p: string) => {
        if (p === "Scripts\\common.j") return GAME_COMMON;
        if (p === "Scripts\\Blizzard.j") return GAME_BLIZZARD;
        throw new Error(`no ${p}`);
      },
    },
    settings: { get: () => undefined },
  } as unknown as W3Api;
  return builtinChecks(w3).find((c) => c.id === "jass")!;
}

test("war3map.j is checked against the map's own Scripts\\common.j where it imports one", async () => {
  assert.deepEqual((await project({ "map/Scripts/common.j": OWN_COMMON }).run()).map((p) => p.message), []);
  // The archive's names don't care about case: scripts\Common.J is the same file.
  assert.deepEqual((await project({ "map/scripts/Common.J": OWN_COMMON }).run()).map((p) => p.message), []);
});

test("control: without the map's common.j the same script has an unknown variable", async () => {
  assert.deepEqual((await project({}).run()).map((p) => p.message), ["Unknown variable MY_HERO"]);
  // A common.j elsewhere in the map isn't the one the game reads.
  assert.deepEqual((await project({ "map/war3mapImported/common.j": OWN_COMMON }).run()).map((p) => p.message), ["Unknown variable MY_HERO"]);
});

test("a map's common.j that is there but can't be read fails the check instead of falling back to the game's", async () => {
  await assert.rejects(project({ "map/Scripts/common.j": new Error("Permission denied (os error 13)") }).run(), /Permission denied/);
});

test("a map's common.j lacking a game native isn't used: the game's is, and a warning names what it lacks", async () => {
  // An older copy: the map's constant, but not the game's KillUnit.
  const older = "type agent extends handle\ntype unit extends agent\nglobals\n    constant integer MY_HERO = 'H000'\nendglobals\n";
  const problems = await project({ "map/Scripts/common.j": older }).run();
  assert.deepEqual(problems.map((p) => [p.severity, p.location]), [["warning", "Scripts\\common.j"], ["error", "war3map.j:2"]]);
  assert.match(problems[0].message, /lacks 1 of the game's declarations \(native KillUnit\)/);
  assert.equal(problems[1].message, "Unknown variable MY_HERO", "checked against the game's common.j, nothing of the map's merged in");
});

test("mapScriptJassEnv: the map's Blizzard.j alone replaces the game's Blizzard.j, the game's common.j stays", async () => {
  const read = async (p: string) => (p === "Scripts\\common.j" ? GAME_COMMON : GAME_BLIZZARD);
  const env = await mapScriptJassEnv(read, async (p) => (p === "Scripts\\Blizzard.j" ? "function MyBj takes nothing returns nothing\nendfunction\n" : null));
  assert.equal(env.functions.get("MyBj")?.source, "map:Scripts\\Blizzard.j");
  assert.equal(env.functions.get("DoNothing"), undefined, "the game's Blizzard.j was read although the map has its own");
  assert.equal(env.functions.get("KillUnit")?.source, "game:Scripts\\common.j");
});
