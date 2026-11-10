import assert from "node:assert/strict";
import { test } from "node:test";
import { followGraphicsMode, SAVE_AND_REOPEN, type GraphicsModeHost } from "./graphicsmode";
import { graphicsModeReopens, keptView, VIEW_STATE_LIMIT } from "./tabmemory";

function host(answer?: string) {
  const listeners = new Set<(k: string) => void>();
  const calls: string[] = [];
  let mode = "hd";
  let kept: string[] = [];
  const h: GraphicsModeHost = {
    get: () => mode,
    onDidChange: (l) => { listeners.add(l); return { dispose: () => listeners.delete(l) }; },
    follow: async () => { calls.push("follow"); return kept; },
    save: async (p) => { calls.push(`save ${p}`); return 1; },
    reopen: async (p) => { calls.push(`reopen ${p}`); return 0; },
    ask: async (m) => { calls.push(`ask ${m}`); return answer; },
  };
  return {
    h, calls,
    set(m: string, key = "game.graphicsMode") { mode = m; for (const l of listeners) l(key); },
    keep(paths: string[]) { kept = paths; },
  };
}
const settle = () => new Promise((r) => setTimeout(r, 0));

test("only a real change of the mode reopens: settings loaded again fire every key with the same value", async () => {
  const t = host();
  followGraphicsMode(t.h);
  t.set("hd");
  t.set("sd", "game.installDir");
  await settle();
  assert.deepEqual(t.calls, [], "the same mode, another key: nothing");
  t.set("sd");
  await settle();
  assert.deepEqual(t.calls, ["follow"]);
  t.set("sd");
  await settle();
  assert.deepEqual(t.calls, ["follow"], "sd again: nothing more");
});

test("editors left for unsaved changes are named, and Save and Reopen saves then reopens each", async () => {
  const t = host(SAVE_AND_REOPEN);
  followGraphicsMode(t.h);
  t.keep(["map/war3map.w3u.json", "map/units.mdx"]);
  t.set("de");
  await settle(); await settle(); await settle();
  assert.match(t.calls[1], /^ask war3map\.w3u\.json, units\.mdx have unsaved changes/);
  assert.deepEqual(t.calls.slice(2), ["save map/war3map.w3u.json", "reopen map/war3map.w3u.json", "save map/units.mdx", "reopen map/units.mdx"]);
});

test("without the answer nothing is saved", async () => {
  const t = host(undefined);
  followGraphicsMode(t.h);
  t.keep(["map/a.mdx"]);
  t.set("sd");
  await settle(); await settle();
  assert.equal(t.calls.length, 2);
  assert.match(t.calls[1], /a\.mdx has unsaved changes, so it still shows/);
});

test("which tabs follow the mode: art editors and game files; never one that follows by itself", () => {
  assert.equal(graphicsModeReopens({ graphicsMode: "reopen" }, "map/x.mdx"), true);
  assert.equal(graphicsModeReopens({}, "map/war3map.j"), false);
  assert.equal(graphicsModeReopens(undefined, "game:Units/UnitData.slk"), true, "a game file is read in the mode");
  assert.equal(graphicsModeReopens({ graphicsMode: "self" }, "game:Maps/x.w3m"), false);
});

test("view states are kept as JSON copies up to the limit", () => {
  const v = { line: 3, sel: [1, 2] };
  const k = keptView(v) as typeof v;
  assert.deepEqual(k, v);
  assert.notEqual(k, v, "a copy");
  assert.equal(keptView("x".repeat(VIEW_STATE_LIMIT)), undefined, "too big (the quotes count)");
  assert.equal(keptView("x".repeat(VIEW_STATE_LIMIT - 2))?.toString().length, VIEW_STATE_LIMIT - 2);
  const loop: Record<string, unknown> = {};
  loop.self = loop;
  assert.equal(keptView(loop), undefined, "not JSON");
  assert.equal(keptView(() => 1), undefined, "a function has no JSON");
  assert.equal(keptView(undefined), undefined);
});
