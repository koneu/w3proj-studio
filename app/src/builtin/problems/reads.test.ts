// How much one run of the Problems checks asks the backend for, on the mini map: each project file is
// read at most once per run, game paths are looked up in batches, and the total stays within a budget.
// Counting calls, not timing them, so the guard isn't flaky. A run of the same checks without the
// shared reads is the control: the same counting has to see it read files again.

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import type { FileInfo, W3Api } from "../../extensions/api";
import type { ProblemsService } from "../../extensions/services";
import { builtinChecks } from "./checks";
import { activate } from "./index";
import { mapChecks } from "./mapchecks";

/** Every backend call of a run, from the most it may be: the count after the shared reads and batched
 *  lookups (40 calls on the mini map with the additions below, against 75 before them). A new check
 *  that reads more raises it, on purpose. */
const BUDGET = 121;

/** The mini map, found from where the tests run (app/ or the repository). */
function fixture(): string {
  for (let dir = process.cwd(); ; dir = dirname(dir)) {
    const p = join(dir, "tests", "fixtures", "mini-map");
    if (existsSync(p)) return p;
    if (dirname(dir) === dir) throw new Error("tests/fixtures/mini-map not found");
  }
}

/** SLK text of a table: the first row is the header. */
function slk(rows: string[][]) {
  const out = ["ID;PWXL;N;E"];
  rows.forEach((row, y) => row.forEach((v, x) => { if (v !== "") out.push(`C;X${x + 1};Y${y + 1};K"${v}"`); }));
  return [...out, "E"].join("\r\n");
}

/** A made-up game: unit metadata with a model and an icon field, one stored model; nothing else. */
const GAME: Record<string, string> = {
  "Units\\UnitMetaData.slk": slk([["ID", "field", "slk", "category", "displayName", "sort", "type", "useUnit"],
    ["umdl", "file", "Profile", "art", "", "1", "model", "1"], ["uico", "Art", "Profile", "art", "", "2", "icon", "1"]]),
  "Units\\UnitData.slk": slk([["unitID"], ["hfoo"]]),
  "Units\\UnitBalance.slk": slk([["unitBalanceID"]]),
  "Units\\UnitUI.slk": slk([["unitUIID"]]),
  "Units\\UnitWeapons.slk": slk([["unitWeaponID"]]),
  "Units\\UnitAbilities.slk": slk([["unitAbilID"]]),
};
const STORED = new Set(["units\\stored\\model.mdx"]);

/** Made-up files on top of the mini map, so that every kind of lookup happens: object data with
 *  paths, sounds, import entries and Game Interface art. */
const OVERLAY: Record<string, string> = {
  "map/war3map.w3u.json": JSON.stringify({ format: "w3proj.objects/1", version: 3, original: [], custom: [
    { base: "hfoo", id: "h000", mods: [{ field: "umdl", value: "Units\\Stored\\Model.mdl" }, { field: "uico", value: "UI\\Made\\Icon.blp" }] },
    { base: "hfoo", id: "h001", mods: [{ field: "umdl", value: "Units\\Made\\Missing" }, { field: "uico", value: "C:\\Users\\someone\\icon.blp" }] },
  ] }),
  "map/war3map.w3s.json": JSON.stringify({ sounds: [{ name: "gg_snd_One", file: "Sound\\Made\\One.wav" }, { name: "gg_snd_Two", file: "war3mapImported\\readme.txt" }] }),
  "map/war3map.imp.json": JSON.stringify({ files: [{ flags: 10, path: "war3mapImported\\readme.txt" }, { flags: 10, path: "Sound\\Gone.mp3" }] }),
  "map/war3mapSkin.txt": "[Skin]\nArt=UI\\Made\\Art.blp,UI\\Made\\Thing.mdx\n",
};

function walk(dir: string, base = dir): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name), base) : [join(dir, e.name).slice(base.length + 1).replace(/\\/g, "/")]));
}

/** The part of the app the checks and the service use, over the mini map, counting every call that
 *  would go to the backend (key: "what path"). */
function fakeApp() {
  const root = fixture();
  const calls = new Map<string, number>();
  const count = (key: string) => calls.set(key, (calls.get(key) ?? 0) + 1);
  const onDisk = (p: string) => existsSync(join(root, p)) && statSync(join(root, p)).isFile();
  const files: FileInfo[] = [...new Set([...walk(root), ...Object.keys(OVERLAY)])].sort().map((path) => ({ path, size: 1, modified: 1 }));
  const text = (p: string) => {
    if (p in OVERLAY) return OVERLAY[p];
    if (onDisk(p)) return readFileSync(join(root, p), "utf8");
    throw new Error(`no ${p}`);
  };
  const services = new Map<string, unknown>();
  const none = { dispose() {} };
  const w3 = {
    workspace: {
      project: () => ({ root, name: "mini", manifest: {}, default_output: "" }),
      files: () => files,
      resolve: (p: string) => join(root, p),
      readText: async (p: string) => { count(`readText ${p}`); return text(p); },
      readBytes: async (p: string) => { count(`readBytes ${p}`); return new TextEncoder().encode(text(p)); },
      onDidChange: () => none,
    },
    backend: {
      invoke: async (command: string, args: Record<string, unknown> = {}) => {
        count(`${command} ${String(args.path ?? args.root ?? "")}`);
        if (command === "fs_exists") return existsSync(String(args.path)) || Object.keys(OVERLAY).some((p) => resolve(join(root, p)) === resolve(String(args.path)));
        throw new Error(`${command}: not in this test`);
      },
    },
    game: {
      list: async () => { count("game.list"); return []; },
      read: async (p: string) => { count(`game.read ${p}`); if (!(p in GAME)) throw new Error(`no ${p}`); return new TextEncoder().encode(GAME[p]); },
      readText: async (p: string) => { count(`game.read ${p}`); if (!(p in GAME)) throw new Error(`no ${p}`); return GAME[p]; },
      resolve: async (p: string) => { count(`game.resolve ${p}`); return STORED.has(p.toLowerCase()) ? `War3.w3mod:${p}` : null; },
      resolveMany: async (paths: string[]) => { count("game.resolveMany"); return paths.map((p) => (STORED.has(p.toLowerCase()) ? `War3.w3mod:${p}` : null)); },
    },
    settings: { get: () => undefined },
    statusBar: { add: () => ({ text: "", tooltip: "", dispose() {} }) },
    services: { provide: (id: string, impl: unknown) => { services.set(id, impl); return none; } },
    mcp: { registerTool: () => none },
    commands: { register: () => none },
    views: { register: () => none, refresh() {}, show: async () => {} },
    window: { showError() {}, showInfo() {} },
  } as unknown as W3Api;
  return { w3, calls, service: () => services.get("w3.problems") as ProblemsService };
}

const total = (calls: Map<string, number>) => [...calls.values()].reduce((n, c) => n + c, 0);
/** Reads of the same project file (or the same raw-file fallback) more than once in a run. */
const repeated = (calls: Map<string, number>) => [...calls].filter(([k, n]) => n > 1 && /^(readText|readBytes|codec_decode|fs_exists) /.test(k));

test("a run of the checks reads each project file once and looks game paths up in batches", async () => {
  const app = fakeApp();
  activate(app.w3, { extensionId: "w3.problems", extensionPath: null, subscriptions: [] });
  const found = await app.service().run();
  // The run got far enough to look things up: the made-up paths are reported, the stored one isn't.
  const messages = found.map((p) => p.message).join("\n");
  assert.match(messages, /Units\\Made\\Missing not found/);
  assert.match(messages, /UI\\Made\\Icon\.blp not found/);
  assert.match(messages, /someone's disk/);
  assert.match(messages, /Sound\\Made\\One\.wav not found/);
  assert.match(messages, /Sound\\Gone\.mp3 is listed but its file is missing/);
  assert.match(messages, /UI\\Made\\Art\.blp not found/);
  assert.doesNotMatch(messages, /Stored/);
  assert.deepEqual(repeated(app.calls), [], "a project file read twice in one run");
  assert.deepEqual([...app.calls.keys()].filter((k) => k.startsWith("game.resolve ")), [], "game paths looked up one by one");
  assert.ok((app.calls.get("game.resolveMany") ?? 0) >= 1, "no batched lookup at all: the checks didn't reach it");
  assert.ok(total(app.calls) <= BUDGET, `${total(app.calls)} backend calls in one run, more than the budget of ${BUDGET}:\n${[...app.calls].map(([k, n]) => `${n} ${k}`).join("\n")}`);

  // The next run reads the files again (nothing is kept from one run to the next).
  const before = app.calls.get("readText map/war3map.w3u.json");
  await app.service().run();
  assert.equal(app.calls.get("readText map/war3map.w3u.json"), (before ?? 0) + 1);
});

test("control: the same checks without a shared run read files again, and the counting sees it", async () => {
  const app = fakeApp();
  for (const check of [...builtinChecks(app.w3), ...mapChecks(app.w3)]) await check.run().catch(() => []);
  assert.notDeepEqual(repeated(app.calls), [], "the counting saw no repeated read: it can't catch one");
  assert.ok(total(app.calls) > BUDGET, `only ${total(app.calls)} calls without sharing: the budget can't tell`);});
