// The Melee flag follows every save that can take it off, as the World Editor's save does (lib/terrain/meleesave):
// also with script.generateOnSave off, on a vJASS map whose script isn't made, and for a start location under water.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { ExtensionContext, W3Api } from "../../extensions/api";
import { writeW3e, type Corner, type Terrain } from "../../lib/terrain/w3e";
import { activate } from "./index";

/** The mini map's map/ folder, found from where the tests run (app/ or the repository). */
function fixture(name: string): string {
  for (let dir = process.cwd(); ; dir = dirname(dir)) {
    const p = join(dir, "tests", "fixtures", "mini-map", "map", name);
    if (existsSync(p)) return readFileSync(p, "utf8");
    if (dirname(dir) === dir) throw new Error("tests/fixtures/mini-map not found");
  }
}

const MELEE = 4, ROOT = "/maps/Melee";

/** A 4x3 flat terrain, the west half under water. */
function lake(): Uint8Array {
  const corners: Corner[] = [];
  for (let y = 0; y < 3; y++) for (let x = 0; x < 4; x++) {
    const wet = x < 2;
    // As stored: ground at -100 under water at 50 (raw values 0x2000 + 4 per unit), dry ground at 0.
    corners.push({ layer: 2, ramp: false, height: wet ? -100 : 0, rawHeight: 0x2000 + (wet ? -400 : 0), hasWater: wet, water: wet ? 50 : -2137.6, texture: 0, variation: 0, cliffVariation: 0, cliffTexture: 0, blight: false, boundary: false, rawWater: wet ? 0x2000 + 200 : 0, texExtra: 0 });
  }
  return writeW3e({ version: 11, tileset: "L", customTilesets: false, groundTiles: ["Ldrt"], cliffTiles: ["CLdi"], width: 4, height: 3, offsetX: 0, offsetY: 0, corners, trailer: new Uint8Array(0) } as unknown as Terrain);
}

/** The mini map as a melee map with a neutral gold mine and Player 1's start at `start`, and the app's API around the
 *  map script extension. `own`: more files (or replacements). */
function project(opts: { generateOnSave: boolean; start?: [number, number]; own?: Record<string, string>; bytes?: Record<string, Uint8Array>; dirty?: boolean }) {
  const info = JSON.parse(fixture("war3map.w3i.json"));
  // A melee map by every rule (the mini map's game data set 2 is a reason).
  info.flags |= MELEE;
  info.gameDataSet = 0;
  const units = JSON.parse(fixture("war3mapUnits.doo.json"));
  const like = units.units[0];
  const [sx, sy] = opts.start ?? [320, 64];
  units.units = [{ ...like, id: "sloc", player: 0, position: [sx, sy, 0] }, { ...like, id: "ngol", player: 27, position: [300, 300, 0] }];
  const files: Record<string, string> = {
    "map/war3map.w3i.json": JSON.stringify(info),
    "map/war3mapUnits.doo.json": JSON.stringify(units),
    ...opts.own,
  };
  for (const p of Object.keys(opts.bytes ?? {})) files[p] ??= "";
  const written = new Map<string, string>();
  const commands = new Map<string, (...a: unknown[]) => unknown>();
  const saved: ((path: string) => void)[] = [];
  const none = { dispose() {} };
  const notFound = (p: string) => new Error(`${p}: No such file or directory (os error 2)`);
  const read = async (p: string) => {
    if (written.has(p)) return written.get(p)!;
    if (!(p in files)) throw notFound(p);
    return files[p];
  };
  const w3 = {
    output: { channel: () => ({ append() {} }) },
    services: { provide: () => none },
    settings: { get: (key: string) => (key === "script.generateOnSave" ? opts.generateOnSave : undefined) },
    game: { readText: async () => "", read: async (p: string) => { throw notFound(p); } },
    window: { showInfo: async () => undefined, showWarning: async () => undefined, showError: async () => undefined, notify: async () => undefined },
    editors: { isDirty: (p: string) => !!opts.dirty && p === "map/war3map.w3i.json", registerProvider: () => none, open: async () => {} },
    commands: {
      register: (id: string, f: (...a: unknown[]) => unknown) => { commands.set(id, f); return none; },
      execute: async (id: string, ...a: unknown[]) => commands.get(id)?.(...a),
    },
    mcp: { registerTool: () => none },
    workspace: {
      project: () => ({ root: ROOT, name: "Melee", manifest: {}, default_output: "" }),
      files: () => Object.keys(files).map((path) => ({ path, size: 1, modified: 1 })),
      resolve: (p: string) => `${ROOT}/${p}`,
      readText: read,
      readBytes: async (p: string) => opts.bytes?.[p] ?? new TextEncoder().encode(await read(p)),
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
    /** A save of `path` with `change` made to the stored file first, and the map script extension's run after it. */
    save: async (path: string, change?: (doc: Record<string, unknown>) => void) => {
      if (change) { const doc = JSON.parse(files[path]); change(doc); files[path] = JSON.stringify(doc); }
      for (const f of saved) f(path);
      await commands.get("w3.script.settle")!();
    },
    flags: () => Number(JSON.parse(written.get("map/war3map.w3i.json") ?? files["map/war3map.w3i.json"]).flags),
  };
}

const footman = (u: { units: Record<string, unknown>[] }) => { u.units.push({ ...u.units[0], id: "hfoo", player: 0, position: [256, 256, 0] }); };

test("a player's unit saved with generateOnSave off takes the Melee flag off", async () => {
  const p = project({ generateOnSave: false });
  await p.save("map/war3mapUnits.doo.json");
  assert.equal(p.flags() & MELEE, MELEE, "control: a start location and a neutral gold mine keep it");
  await p.save("map/war3mapUnits.doo.json", footman as never);
  assert.equal(p.flags() & MELEE, 0);
  assert.equal(p.written.has("map/war3map.j"), false, "no script is made with generateOnSave off");
});

test("on a vJASS map, whose script isn't made, the Melee flag follows all the same", async () => {
  const p = project({ generateOnSave: true, own: { "map/war3map.j": "//globals from MyLibrary:\nglobals\nendglobals\n" } });
  await p.save("map/war3mapUnits.doo.json", footman as never);
  assert.equal(p.flags() & MELEE, 0);
  assert.equal(p.written.has("map/war3map.j"), false, "the vJASS script stays as it is");
});

test("a start location under water takes the Melee flag off when the ground is saved", async () => {
  const dry = project({ generateOnSave: false, start: [320, 64], bytes: { "map/war3map.w3e": lake() } });
  await dry.save("map/war3map.w3e");
  assert.equal(dry.flags() & MELEE, MELEE, "control: the start on dry ground");
  const wet = project({ generateOnSave: false, start: [64, 64], bytes: { "map/war3map.w3e": lake() } });
  await wet.save("map/war3map.w3e");
  assert.equal(wet.flags() & MELEE, 0);
});

test("custom gameplay constants take the Melee flag off with generateOnSave off", async () => {
  const p = project({ generateOnSave: false, own: { "map/war3mapMisc.txt": "[Misc]\nScaledAnimTime=75.0\n" } });
  await p.save("map/war3mapMisc.txt");
  assert.equal(p.flags() & MELEE, 0);
});

test("Map Properties with unsaved changes isn't written over: it gets its turn when it's saved", async () => {
  const p = project({ generateOnSave: false, dirty: true });
  await p.save("map/war3mapUnits.doo.json", footman as never);
  assert.equal(p.written.has("map/war3map.w3i.json"), false);
});
