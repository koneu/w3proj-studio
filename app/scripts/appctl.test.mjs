// appctl.mjs (the app's start for app-drive and we-compare): the settings folder it removes is always its own, a
// failed start leaves none behind, and the build runs without a shell.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as appctl from "./appctl.mjs";
import { scratchDir } from "../../tests/scratch.mjs";
import { repoPath } from "../src/lib/testhelpers/testutil";

test("startApp never removes a W3PROJ_CONFIG_DIR of the caller's; a start that fails removes the folder it made", { skip: process.platform !== "linux" && "the failing start is the Linux one (tauri-driver not found)" }, async () => {
  const dir = scratchDir("appctl-");
  const saved = { ...process.env };
  try {
    // Someone's real settings, named by the environment.
    const theirs = join(dir, "their-settings");
    mkdirSync(theirs);
    writeFileSync(join(theirs, "settings.json"), "{\"keep\": true}");
    const exe = join(dir, "w3proj-studio");
    writeFileSync(exe, "");
    Object.assign(process.env, { W3PROJ_CONFIG_DIR: theirs, W3_APP_BIN: exe, W3_ALLOW_STALE: "1", PATH: join(dir, "no-tools") });
    const work = join(dir, "work");
    // No xvfb-run or tauri-driver on this PATH: the start fails at once.
    await assert.rejects(appctl.startApp({ id: "dev.w3proj.studio.smoke.appctl-test", work }), /missing for the Linux smoke test/);
    assert.equal(readFileSync(join(theirs, "settings.json"), "utf8"), "{\"keep\": true}", "the caller's folder is untouched");
    assert.equal(existsSync(appctl.configDirOf(work)), false, "the run's own settings folder is gone after the failed start");
    assert.equal(appctl.configDirOf(work), join(work, "config"));
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the app reads the game's TriggerData when there is a game folder, the made-up one only when asked or without one", () => {
  const fixture = repoPath("tests", "fixtures", "TriggerData.txt");
  assert.deepEqual(appctl.triggerDataEnv("/games/Warcraft III"), {});
  assert.equal(appctl.triggerDataEnv("/games/Warcraft III", true).W3PROJ_TRIGGERDATA.endsWith(join("tests", "fixtures", "TriggerData.txt")), true);
  assert.equal(appctl.triggerDataEnv(null).W3PROJ_TRIGGERDATA.endsWith(join("tests", "fixtures", "TriggerData.txt")), true);
  assert.equal(existsSync(fixture), true);
});

test("buildApp's command is an argument list: a config path with spaces and quotes stays one argument", () => {
  const patch = join("/w o\"rk", "tauri smoke.json");
  const [cmd, args] = appctl.buildCommand("/app dir", patch);
  assert.equal(cmd, process.execPath, "node itself, no shell and no npx (.cmd on Windows)");
  assert.deepEqual(args.slice(1), ["build", "--debug", "--no-bundle", "--config", patch]);
  assert.equal(args[0], join("/app dir", "node_modules", "@tauri-apps", "cli", "tauri.js"));
  assert.ok(existsSync(repoPath("app", "node_modules", "@tauri-apps", "cli", "tauri.js")), "control: the Tauri CLI's script is where the command looks");
  assert.ok(appctl.BUILD_TIMEOUT_MS >= 30 * 60 * 1000, "a cold build gets its time");
});
