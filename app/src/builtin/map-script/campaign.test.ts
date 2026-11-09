// A chapter map's script is made from its campaign's object data too (war3campaign.w3u, … in the campaign project
// two folders up), under the map's own as the World Editor does: CSW Tides of Darkness' WC2Orc01 places o619, whose
// colour 24 only war3campaign.w3u sets, and the editor's war3map.j has SetUnitColor(…, ConvertPlayerColor(24)) for it.
// Saving one of the campaign's object files regenerates the script; one that can't be read fails the generation
// rather than leaving the campaign's objects out.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { ExtensionContext, W3Api } from "../../extensions/api";
import { activate } from "./index";

/** The mini map's map/ folder, found from where the tests run (app/ or the repository). */
function fixture(name: string): string {
  for (let dir = process.cwd(); ; dir = dirname(dir)) {
    const p = join(dir, "tests", "fixtures", "mini-map", "map", name);
    if (existsSync(p)) return readFileSync(p, "utf8");
    if (dirname(dir) === dir) throw new Error("tests/fixtures/mini-map not found");
  }
}
const CHAPTER = "/camp/maps/Chapter.w3x";

const objects = (custom: object[], original: object[] = []) => JSON.stringify({ format: "w3proj.objects/1", version: 3, original, custom });
const mod = (field: string, value: unknown, type = "int") => ({ field, type, value });

/** A chapter map's project in its campaign, with the app's API around the map script extension. `campaign` holds the
 *  campaign's files by name in its map/ folder (a value of null: there but unreadable). */
function chapter(campaign: Record<string, string | null>, own: Record<string, string> = {}) {
  const info = JSON.parse(fixture("war3map.w3i.json"));
  const unit = JSON.parse(fixture("war3mapUnits.doo.json"));
  const placed = (id: string, editorId: number) => ({ ...unit.units[0], id, skinId: id, editorId, position: [editorId * 128, 0, 0] });
  unit.units = [placed("c001", 10), placed("c002", 11), placed("c003", 12)];
  const files: Record<string, string | null> = {
    "map/war3map.w3i.json": JSON.stringify(info),
    "map/war3mapUnits.doo.json": JSON.stringify(unit),
    ...own,
    "/camp/map/war3campaign.w3f.json": "{}",
    ...Object.fromEntries(Object.entries(campaign).map(([k, v]) => [`/camp/map/${k}`, v])),
  };
  const written = new Map<string, string>();
  const commands = new Map<string, (...a: unknown[]) => unknown>();
  const saved: ((path: string) => void)[] = [];
  const none = { dispose() {} };
  const notFound = (p: string) => new Error(`${p}: No such file or directory (os error 2)`);
  const read = async (p: string) => {
    if (written.has(p)) return written.get(p)!;
    if (!(p in files)) throw notFound(p);
    if (files[p] === null) throw new Error(`${p}: Permission denied (os error 13)`);
    return files[p]!;
  };
  const w3 = {
    output: { channel: () => ({ append() {} }) },
    services: { provide: () => none },
    settings: { get: (key: string) => (key === "script.generateOnSave" ? true : undefined) },
    // The game's tables empty: nothing of hfoo's own (no colour, not a building) comes from the game.
    game: { readText: async () => "", read: async (p: string) => { throw notFound(p); } },
    window: { showInfo: async () => undefined, showWarning: async () => undefined, showError: async () => undefined },
    editors: { isDirty: () => false, registerProvider: () => none, open: async () => {} },
    commands: {
      register: (id: string, f: (...a: unknown[]) => unknown) => { commands.set(id, f); return none; },
      execute: async (id: string, ...a: unknown[]) => commands.get(id)?.(...a),
    },
    mcp: { registerTool: () => none },
    workspace: {
      project: () => ({ root: CHAPTER, name: "Chapter", manifest: {}, default_output: "" }),
      files: () => Object.keys(files).filter((p) => p.startsWith("map/")).map((path) => ({ path, size: 1, modified: 1 })),
      resolve: (p: string) => (p.startsWith("/") ? p : `${CHAPTER}/${p}`),
      readText: read,
      readBytes: async (p: string) => new TextEncoder().encode(await read(p)),
      writeText: async (p: string, t: string) => { written.set(p, t); },
      onDidChange: () => none,
      onDidSave: (f: (path: string) => void) => { saved.push(f); return none; },
    },
    backend: {
      invoke: async (command: string, args: Record<string, unknown> = {}) => {
        if (command === "fs_exists") return (args.path as string) in files;
        if (command === "codec_canonicalize") return args.text;
        if (command === "codec_decode") throw notFound(String(args.path));
        throw new Error(`unexpected ${command}`);
      },
    },
  };
  const ctx: ExtensionContext = { extensionId: "w3.mapScript", extensionPath: null, subscriptions: [] };
  activate(w3 as unknown as W3Api, ctx);
  return {
    files, written,
    generate: () => commands.get("w3.script.generate")!({ quiet: true }) as Promise<void>,
    save: async (path: string) => { for (const f of saved) f(path); await commands.get("w3.script.settle")!(); },
    script: () => written.get("map/war3map.j") ?? "",
  };
}

const CAMPAIGN = {
  // c001: a colour only the campaign gives; c002: a building by the campaign; c003: the map's own replaces the campaign's.
  "war3campaign.w3u.json": objects([
    { id: "c001", base: "hfoo", mods: [mod("utco", 24)] },
    { id: "c002", base: "hfoo", mods: [mod("ubdg", 1)] },
    { id: "c003", base: "hfoo", mods: [mod("utco", 5)] },
  ]),
  "war3campaignSkin.w3u.json": objects([{ id: "c001", base: "hfoo", mods: [mod("unam", "Campaign Grunt", "string")] }]),
};

test("a chapter map's script has its campaign's custom objects, the map's own over them", async () => {
  const c = chapter(CAMPAIGN, { "map/war3map.w3u.json": objects([{ id: "c003", base: "hfoo", mods: [mod("utco", 7)] }]) });
  await c.generate();
  const script = c.script();
  assert.match(script, /'c001'[^\n]*\n\s*call SetUnitColor\( \w+, ConvertPlayerColor\(24\) \)/, "the campaign's colour");
  assert.match(script, /function CreateBuildingsForPlayer0 takes nothing returns nothing[\s\S]*?'c002'[\s\S]*?endfunction/, "the campaign's building");
  assert.match(script, /'c003'[^\n]*\n\s*call SetUnitColor\( \w+, ConvertPlayerColor\(7\) \)/, "the map's colour over the campaign's");
  assert.doesNotMatch(script, /ConvertPlayerColor\(5\)/);
});

test("saving one of the campaign's object files makes the chapter's script again", async () => {
  const c = chapter(CAMPAIGN);
  await c.generate();
  assert.match(c.script(), /ConvertPlayerColor\(24\)/);
  c.files["/camp/map/war3campaign.w3u.json"] = objects([{ id: "c001", base: "hfoo", mods: [mod("utco", 3)] }]);
  await c.save("/camp/map/war3campaign.w3u.json");
  assert.match(c.script(), /ConvertPlayerColor\(3\)/);
  // Another campaign's file isn't this chapter's.
  c.files["/camp/map/war3campaign.w3u.json"] = objects([{ id: "c001", base: "hfoo", mods: [mod("utco", 9)] }]);
  await c.save("/other/map/war3campaign.w3u.json");
  assert.doesNotMatch(c.script(), /ConvertPlayerColor\(9\)/);
});

test("a campaign object file that can't be read fails the generation, not passes for none", async () => {
  const c = chapter({ ...CAMPAIGN, "war3campaign.w3u.json": null });
  await assert.rejects(c.generate(), /war3campaign\.w3u\.json is there but can't be read/);
  assert.equal(c.written.has("map/war3map.j"), false);
});
