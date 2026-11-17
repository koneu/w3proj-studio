// `w3proj rebuild` (rebuild.ts) in this process: the app's code over a backend that answers from a copy of the mini map
// on disk and has no game data (every game command fails, as the CLI's server answers without readable storage).
// The CLI's end-to-end runs (crates/cli/tests/rebuild.rs) need the game, and refuse to start without one; this is the
// part's own decision when the game's data can't be read after all.

import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fixturePath, repoPath } from "../lib/testhelpers/testutil";

const mini = fixturePath("mini-map");

// A scratch folder inside the checkout (git-ignored, like the test runner's own), not the OS temp folder.
const cache = join(repoPath("app", "node_modules"), ".cache", "w3-rebuild-test");
mkdirSync(cache, { recursive: true });
const work = mkdtempSync(join(cache, "run-"));
const gameCalls: string[] = [];

function list(root: string) {
  const files: { path: string; size: number; modified: number }[] = [], folders: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      const rel = relative(root, p).split(sep).join("/");
      if (e.isDirectory()) { folders.push(rel); walk(p); } else {
        const s = statSync(p);
        files.push({ path: rel, size: s.size, modified: Math.floor(s.mtimeMs) });
      }
    }
  };
  walk(root);
  return { files, folders };
}

const g = globalThis as unknown as Record<string, unknown>;
g.window ??= globalThis;
g.__TAURI_INTERNALS__ = {
  async invoke(command: string, args: Record<string, unknown> | Uint8Array, options?: { headers?: Record<string, string> }) {
    if (command.startsWith("game_")) { gameCalls.push(command); throw "game data: no storage in this folder"; }
    const a = args as Record<string, unknown>;
    const path = String(a.path ?? "");
    const root = String(a.root ?? "");
    const stat = (p: string) => { const s = statSync(p); return { size: s.size, modified: Math.floor(s.mtimeMs) }; };
    switch (command) {
      case "project_open": return { root: path, name: "mini", manifest: {}, default_output: join(path, "build") };
      case "project_files_partial": return { files: list(root).files, unreadable: [] };
      case "project_folders": return list(root).folders;
      case "path_normalize": return path;
      case "fs_exists": return existsSync(path);
      case "fs_stat": case "fs_stat_hashed": return existsSync(path) ? stat(path) : null;
      case "fs_read_text":
        if (!existsSync(path)) throw `${path}: No such file or directory (os error 2)`;
        return readFileSync(path, "utf8");
      case "fs_read_bytes": {
        if (!existsSync(path)) throw `${path}: No such file or directory (os error 2)`;
        const b = readFileSync(path);
        return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
      }
      case "fs_write_text": mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, String(a.text)); return stat(path);
      case "fs_write_bytes": {
        const target = decodeURIComponent(options?.headers?.path ?? "");
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, args as Uint8Array);
        return stat(target);
      }
      default: throw `unexpected ${command}`;
    }
  },
  transformCallback: () => 1, unregisterCallback() {}, convertFileSrc: (p: string) => p,
};

const { rebuild } = await import("./rebuild");

test.after(() => rmSync(work, { recursive: true, force: true }));

test("shadows without the game's data keep the stored war3map.shd and say why; the control writes one where none is stored", async () => {
  const project = join(work, "kept");
  cpSync(mini, project, { recursive: true });
  // The baked shadows the World Editor stored (any bytes: they must come back as they were).
  const baked = new Uint8Array(4096).map((_, i) => (i * 7) & 0xff);
  writeFileSync(join(project, "map", "war3map.shd"), baked);
  const report = await rebuild({ root: project, parts: ["shd"], settings: { "game.installDir": join(work, "no-game") } });
  assert.ok(gameCalls.length > 0, "the game was asked (and couldn't answer)");
  const shd = report.parts.find((p) => p.part === "shd");
  assert.equal(shd?.status, "kept", JSON.stringify(report.parts));
  assert.match(shd?.note ?? "", /game.*(couldn't be read|game folder)/);
  assert.match(shd?.note ?? "", /war3map\.shd is kept/);
  assert.deepEqual([...readFileSync(join(project, "map", "war3map.shd"))], [...baked], "the stored shadows are untouched");

  // The control: the mini map without doodads (cliffs only is right then) writes its shadows.
  const bare = join(work, "bare");
  cpSync(mini, bare, { recursive: true });
  writeFileSync(join(bare, "map", "war3map.shd"), baked);
  const doo = JSON.parse(readFileSync(join(bare, "map", "war3map.doo.json"), "utf8")) as Record<string, unknown>;
  for (const [k, v] of Object.entries(doo)) if (Array.isArray(v)) doo[k] = [];
  writeFileSync(join(bare, "map", "war3map.doo.json"), JSON.stringify(doo));
  const written = (await rebuild({ root: bare, parts: ["shd"], settings: { "game.installDir": join(work, "no-game") } })).parts.find((p) => p.part === "shd");
  assert.equal(written?.status, "written", JSON.stringify(written));
  assert.notDeepEqual([...readFileSync(join(bare, "map", "war3map.shd"))], [...baked]);
});
