// A map whose string table isn't UTF-8 (an old Chinese or Korean map: readWts keeps its bytes as private-use characters,
// lib/formats/lossless) gets a script holding those bytes, not the private-use characters in UTF-8 (U+10FFxx, four
// bytes each, which the game shows as junk). The script so written reads back as the same text, so the next save finds
// it up to date rather than "can't be read as text".

import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext, W3Api } from "../../extensions/api";
import { activate } from "./index";
import { readFixture } from "../../lib/testhelpers/testutil";

const ROOT = "/maps/CodePage";
const enc = (s: string) => new TextEncoder().encode(s);
const cat = (...parts: (string | number[])[]) => new Uint8Array(parts.flatMap((p) => (typeof p === "string" ? [...enc(p)] : p)));
// CP949 "한국" and GBK "中文": neither is UTF-8.
const KOREAN = [0xc7, 0xd1, 0xb1, 0xb9], CHINESE = [0xd6, 0xd0, 0xce, 0xc4];

function project(wts: Uint8Array) {
  const files = new Map<string, Uint8Array>([
    ["map/war3map.w3i.json", enc(readFixture("mini-map", "map", "war3map.w3i.json"))],
    ["map/war3map.wts", wts],
  ]);
  const writes: string[] = [], out: string[] = [], warnings: string[] = [];
  const commands = new Map<string, (...a: unknown[]) => unknown>();
  const none = { dispose() {} };
  const notFound = (p: string) => new Error(`${p}: No such file or directory (os error 2)`);
  const readBytes = async (p: string) => {
    const f = files.get(p);
    if (!f) throw notFound(p);
    return f;
  };
  const w3 = {
    output: { channel: () => ({ append: (l: string) => out.push(l) }) },
    services: { provide: () => none },
    settings: { get: () => undefined },
    game: { readText: async () => "", read: async (p: string) => { throw notFound(p); } },
    window: { showInfo: async () => undefined, showWarning: (m: string) => { warnings.push(m); return new Promise(() => {}); }, showError: async () => undefined, notify: (_l: string, m: string) => { warnings.push(m); return new Promise(() => {}); } },
    editors: { isDirty: () => false, registerProvider: () => none, open: async () => {} },
    commands: {
      register: (id: string, f: (...a: unknown[]) => unknown) => { commands.set(id, f); return none; },
      execute: async (id: string, ...a: unknown[]) => commands.get(id)?.(...a),
    },
    mcp: { registerTool: () => none },
    workspace: {
      project: () => ({ root: ROOT, name: "CodePage", manifest: {}, default_output: "" }),
      files: () => [...files.keys()].map((path) => ({ path, size: 1, modified: 1 })),
      resolve: (p: string) => `${ROOT}/${p}`,
      // As the backend: a file that isn't UTF-8 is refused as text (NOT_UTF8).
      readText: async (p: string) => {
        const b = await readBytes(p);
        try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(b); } catch { throw new Error("NOT_UTF8"); }
      },
      readBytes,
      writeText: async (p: string, t: string) => { writes.push(p); files.set(p, enc(t)); },
      writeBytes: async (p: string, b: Uint8Array) => { writes.push(p); files.set(p, new Uint8Array(b)); },
      onDidChange: () => none,
      onDidSave: () => none,
      readTriggers: async () => null,
    },
    backend: {
      invoke: async (command: string, args: Record<string, unknown> = {}) => {
        if (command === "script_state") return { mode: null };
        if (command === "codec_canonicalize") return args.text;
        if (command === "codec_decode") throw notFound(String(args.path));
        throw new Error(`unexpected ${command}`);
      },
    },
  };
  const ctx: ExtensionContext = { extensionId: "w3.mapScript", extensionPath: null, subscriptions: [] };
  activate(w3 as unknown as W3Api, ctx);
  const run = (id: string, ...a: unknown[]) => Promise.race([
    Promise.resolve(commands.get(id)!(...a)),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${id} is still waiting (a question nobody answers?)`)), 5000)),
  ]);
  return { files, writes, out, warnings, run };
}

const table = (name: (string | number[])[], author: (string | number[])[]) =>
  cat("STRING 1\r\n{\r\n", ...name, "\r\n}\r\n\r\nSTRING 2\r\n{\r\n", ...author, "\r\n}\r\n");

/** Where `needle` is in `hay`, -1 when it isn't. */
function indexOf(hay: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let k = 0; k < needle.length; k++) if (hay[i + k] !== needle[k]) continue outer;
    return i;
  }
  return -1;
}

test("a map name and author from a string table in a code page go into war3map.j as their own bytes", async () => {
  const p = project(table(["Map ", KOREAN], [CHINESE]));
  await p.run("w3.script.generate", { quiet: true });
  const script = p.files.get("map/war3map.j");
  assert.ok(script, `war3map.j written (${p.out.join(" | ")})`);
  assert.ok(indexOf(script, cat("// Map ", KOREAN, "\r\n")) >= 0, "the name's CP949 bytes");
  assert.ok(indexOf(script, cat("//   Map Author: ", CHINESE, "\r\n")) >= 0, "the author's GBK bytes");
  // Private-use characters in UTF-8 start with F4 8F: none of them may reach the file.
  assert.equal(indexOf(script, new Uint8Array([0xf4, 0x8f])), -1, "no U+10FFxx in the script");

  // The script so written is the one the data makes: the next run finds it up to date, writes nothing and asks nothing.
  p.writes.length = 0;
  await p.run("w3.script.generate", { quiet: true });
  assert.deepEqual(p.writes, [], p.out.join(" | "));
  assert.deepEqual(p.warnings, []);
  assert.match(p.out.at(-1) ?? "", /war3map\.j up to date/);
});

test("control: a UTF-8 table gives a UTF-8 script, the same bytes as the text", async () => {
  const p = project(table(["Mini ", "한국"], ["中文"]));
  await p.run("w3.script.generate", { quiet: true });
  const script = p.files.get("map/war3map.j")!;
  const text = new TextDecoder("utf-8", { fatal: true }).decode(script);
  assert.deepEqual(script, enc(text));
  assert.match(text, /\/\/ Mini 한국\r\n/);
  assert.match(text, /\/\/   Map Author: 中文\r\n/);
});
