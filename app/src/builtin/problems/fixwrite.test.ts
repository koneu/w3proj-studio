import assert from "node:assert/strict";
import { test } from "node:test";
import type { W3Api } from "../../extensions/api";
import { readListed, writeFix } from "./checks";
import { chooseFolder, planModelEdit } from "./fixplan";

/** The part of the app that the fix writers use, over a plain map of files. */
function fake(opts: { root?: () => string; failWrite?: string } = {}) {
  const files = new Map<string, string>();
  const w3 = {
    workspace: {
      project: () => ({ root: opts.root?.() ?? "R" }),
      writeBytes: async (p: string, b: Uint8Array) => { if (opts.failWrite === p) throw new Error("disk full"); files.set(p, new TextDecoder().decode(b)); },
      delete: async (p: string) => { files.delete(p); },
    },
  } as unknown as W3Api;
  return { w3, files };
}
const bytes = (s: string) => new TextEncoder().encode(s);

test("a file in the list that can't be read is an error, not an absent file", async () => {
  const w3 = { workspace: { readText: async () => { throw new Error("locked"); } } } as unknown as W3Api;
  await assert.rejects(readListed(w3, new Set(["map/war3map.w3d.json"]), "map/war3map.w3d.json"), /can't be read.*locked/);
  // Control: not listed is absent, and a listed readable file is read.
  assert.equal(await readListed(w3, new Set(), "map/war3map.w3d.json"), null);
  const ok = { workspace: { readText: async () => "{}" } } as unknown as W3Api;
  assert.equal(await readListed(ok, new Set(["map/x.json"]), "map/x.json"), "{}");
});

test("a fix that fails before its steps removes the files it created, and only those", async () => {
  const { w3, files } = fake({ failWrite: "map/war3mapImported/b.blp" });
  files.set("map/war3mapImported/a.mdx", "mine");
  const all = new Map([["war3mapImported\\a.mdx", bytes("same")], ["war3mapImported\\c.mdx", bytes("new")], ["war3mapImported\\b.blp", bytes("x")]]);
  await assert.rejects(writeFix(w3, "R", all, (a) => !a.endsWith("a.mdx"), []), /disk full.*removed/);
  assert.equal(files.has("map/war3mapImported/c.mdx"), false);
  assert.equal(files.get("map/war3mapImported/a.mdx"), "same");
});

test("the project is checked before every write, not only before the first", async () => {
  let root = "R";
  const { w3, files } = fake({ root: () => root });
  const all = new Map([["a.mdx", bytes("1")], ["b.mdx", bytes("2")]]);
  const orig = (w3.workspace as { writeBytes: (p: string, b: Uint8Array) => Promise<void> }).writeBytes;
  (w3.workspace as { writeBytes: unknown }).writeBytes = async (p: string, b: Uint8Array) => { await orig(p, b); root = "OTHER"; };
  await assert.rejects(writeFix(w3, "R", all, () => true, []), /Another project/);
  assert.equal(files.has("map/b.mdx"), false);
});

test("steps that fail after the first leave the files and say so", async () => {
  const { w3, files } = fake();
  await assert.rejects(writeFix(w3, "R", new Map([["a.mdx", bytes("1")]]), () => true, [async () => {}, async () => { throw new Error("no"); }]), /left in the map/);
  assert.equal(files.has("map/a.mdx"), true);
});

test("a map file that can't be read stops the folder choice instead of looking free", async () => {
  const build = async (dir: string) => new Map([[`${dir}\\x.mdx`, bytes("1")]]);
  await assert.rejects(chooseFolder("X", build, async () => { throw new Error("locked"); }), /locked/);
});

test("a skin entry that sets only the variation count is updated too", () => {
  const skin = JSON.stringify({ version: 3, original: [{ base: "LCcb", mods: [{ field: "dvar", type: "int", level: 0, data: 0, value: 4 }] }], custom: [] });
  const r = planModelEdit({ kind: "w3d", base: "LCcb", id: "LCcb", model: "m", variations: 2, fields: { model: "dfil", variations: "dvar" }, main: null, mainRaw: false, skin });
  assert.equal(r.skin!.original[0].mods!.find((m) => m.field === "dvar")!.value, 2);
  assert.equal(r.skin!.original[0].mods!.some((m) => m.field === "dfil"), false);
});

test("the project is checked before each step too", async () => {
  let root = "R";
  const { w3 } = fake({ root: () => root });
  let second = false;
  await assert.rejects(writeFix(w3, "R", new Map(), () => true, [async () => { root = "OTHER"; }, async () => { second = true; }]), /Another project/);
  assert.equal(second, false);
});

test("a first step that fails removes the new files", async () => {
  const { w3, files } = fake();
  await assert.rejects(writeFix(w3, "R", new Map([["a.mdx", bytes("1")]]), () => true, [async () => { throw new Error("bad list"); }]), /bad list.*removed/);
  assert.equal(files.size, 0);
});
