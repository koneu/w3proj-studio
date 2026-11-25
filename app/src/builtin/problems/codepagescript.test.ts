// An old map's war3map.j in its code page (CP949 strings: not UTF-8, as the World Editor wrote it, and as the map
// script extension writes strings from such a string table) is checked as the app reads it (readScriptFile, lossless):
// it used to be refused as text and taken for no script, so the Problems view said nothing about it.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { W3Api } from "../../extensions/api";
import { builtinChecks } from "./checks";

const GAME_COMMON = "type agent extends handle\ntype unit extends agent\n";
const enc = (s: string) => new TextEncoder().encode(s);
// CP949 "한국" in a string and a comment; MISSING on line 4 is a real error.
const SCRIPT = new Uint8Array([
  ...enc("// "), 0xc7, 0xd1, 0xb1, 0xb9, ...enc("\r\nfunction main takes nothing returns nothing\r\n    local string s = \""),
  0xc7, 0xd1, 0xb1, 0xb9, ...enc("\"\r\n    local integer i = MISSING\r\nendfunction\r\n"),
]);

function jassCheck(script: Uint8Array) {
  const all: Record<string, Uint8Array> = { "map/war3map.j": script };
  const bytes = (p: string) => {
    const f = all[p];
    if (!f) throw new Error(`${p}: No such file or directory (os error 2)`);
    return f;
  };
  const w3 = {
    workspace: {
      project: () => ({ root: "/p", name: "p", manifest: {}, default_output: "" }),
      files: () => Object.keys(all).map((path) => ({ path, size: 1, modified: 1 })),
      filesReady: async () => {}, unreadable: () => [],
      resolve: (p: string) => `/p/${p}`,
      // As the backend: a file that isn't UTF-8 is refused as text.
      readText: async (p: string) => {
        try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes(p)); } catch (e) { if (e instanceof TypeError) throw new Error("NOT_UTF8"); throw e; }
      },
      readBytes: async (p: string) => bytes(p),
      onDidChange: () => ({ dispose() {} }),
    },
    backend: { invoke: async (command: string) => { if (command === "fs_exists") return false; throw new Error(`${command}: not in this test`); } },
    game: { readText: async (p: string) => { if (p === "Scripts\\common.j") return GAME_COMMON; if (p === "Scripts\\Blizzard.j") return ""; throw new Error(`no ${p}`); } },
    settings: { get: () => undefined },
  } as unknown as W3Api;
  return builtinChecks(w3).find((c) => c.id === "jass")!;
}

test("a war3map.j in a code page is checked: its error is found on its line, its strings and comments are no error", async () => {
  const problems = await jassCheck(SCRIPT).run();
  assert.deepEqual(problems.map((p) => [p.message, p.location]), [["Unknown variable MISSING", "war3map.j:4"]]);
});
