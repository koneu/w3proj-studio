// we-launch.mjs, the program the app runs instead of the World Editor when W3PROJ_WE_LAUNCH names it (app-smoke's
// worldEditorReal): its arguments (only what the app gives the editor), the folder the editor may write, the exit
// code it hands on, and that the editor is ended when the app is gone. Nothing here starts Wine or the editor.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { scratchDir } from "../../tests/scratch.mjs";
import { repoPath } from "../src/lib/testhelpers/testutil";
import { EXIT, inPlaceProblem, parseLaunchArgs, serve, sessionEditor, writeWhole } from "./we-launch.mjs";

const SCRIPT = repoPath("app", "scripts", "we-launch.mjs");

test("parseLaunchArgs: the app's -launch -loadfile <map> after --, options before; anything else for the editor refused", () => {
  const { opts, map } = parseLaunchArgs(["--slot", "0", "--ctl", "c", "--mode", "hd", "--", "-launch", "-loadfile", "/p/build/p.edit.w3x"]);
  assert.equal(map, resolve("/p/build/p.edit.w3x"), "the map is resolved: a drive letter on Windows");
  assert.equal(opts.slot, 0);
  assert.equal(opts.ctl, resolve("c"));
  assert.equal(opts.mode, "hd");
  assert.equal(parseLaunchArgs(["--", "-launch"]).map, null, "-launch alone: no map");
  assert.equal(parseLaunchArgs(["--", "-launch", "-loadfile", "/m.w3x"]).opts.mode, "sd", "SD by default");
  for (const bad of [
    ["--", "-launch", "-loadfile", "/m.w3x", "-testmapprofile", "x"],
    ["--", "-launch", "-loadfile"],
    ["--", "-launch", "-loadfile", "/a.w3x", "-loadfile", "/b.w3x"],
    ["--", "-loadfile", "/m.w3x"],
    ["--", "-launch", "-launch"],
    ["--slot", "99", "--", "-launch"],
    ["--mode", "xx", "--", "-launch"],
    ["--timeout", "0", "--", "-launch"],
    ["--wat", "--", "-launch"],
    ["-launch", "-loadfile", "/m.w3x"],
  ]) assert.throws(() => parseLaunchArgs(bad), Error, JSON.stringify(bad));
  assert.equal(parseLaunchArgs(["--check"]).opts.check, true, "--check needs no editor arguments");
});

test("inPlaceProblem: the map's folder inside the given roots, never the game folder or the user's Steam prefix", () => {
  const dir = scratchDir("we-launch-place-");
  try {
    const game = join(dir, "steamapps", "compatdata", "1", "pfx", "drive_c", "Warcraft III");
    const proj = join(dir, "proj", "build");
    for (const d of [game, proj]) mkdirSync(d, { recursive: true });
    const map = join(proj, "p.edit.w3x");
    writeFileSync(map, "x");
    assert.equal(inPlaceProblem(map, { game, roots: [dir] }), null);
    assert.match(inPlaceProblem(map, { game, roots: [join(dir, "elsewhere")] }), /isn't inside/);
    assert.match(inPlaceProblem(map, { game, roots: [proj] }), /isn't inside/, "the root itself isn't inside it");
    const inGame = join(game, "Maps", "m.w3x");
    mkdirSync(join(game, "Maps"));
    writeFileSync(inGame, "x");
    assert.match(inPlaceProblem(inGame, { game, roots: [dir] }), /contain one another/);
    const inPrefix = join(dir, "steamapps", "compatdata", "1", "m.w3m");
    writeFileSync(inPrefix, "x");
    assert.match(inPlaceProblem(inPrefix, { game, roots: [dir] }), /contain one another/, "the user's Steam prefix");
    assert.match(inPlaceProblem(join(proj, "gone.w3x"), { game, roots: [dir] }), /no map file/);
    assert.match(inPlaceProblem(join(proj, "notes.txt"), { game, roots: [dir] }), /isn't a \.w3x or \.w3m/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/** An editor as serve() takes it: `log` has every call, `exit` set ends it. */
function fakeEditor({ ready = { ready: true }, onClose } = {}) {
  const e = { log: [], exit: null };
  Object.assign(e, {
    ready: async () => { e.log.push("ready"); return ready; },
    save: async () => { e.log.push("save"); return { saved: true }; },
    close: async () => { e.log.push("close"); (onClose ?? (() => { e.exit = { code: 0, signal: null }; }))(); return { closed: true }; },
    windows: () => { e.log.push("windows"); return { main: { title: "WE" } }; },
    kill: () => { e.log.push("kill"); e.exit = { code: null, signal: "SIGKILL" }; },
    exited: () => e.exit,
  });
  return e;
}

const clock = () => { const c = { t: 0, now: () => c.t, sleep: async (ms) => { c.t += ms; await new Promise((r) => setImmediate(r)); } }; return c; };
const readJson = (f) => JSON.parse(readFileSync(f, "utf8"));

test("serve: the editor's exit code is handed on; the control folder's steps run in order", async () => {
  const ctl = scratchDir("we-launch-ctl-");
  try {
    const e = fakeEditor({ onClose: () => { e.exit = { code: 7, signal: null }; } });
    writeWhole(ctl, "cmd-1.json", { step: "save" });
    writeWhole(ctl, "cmd-2.json", { step: "windows" });
    writeWhole(ctl, "cmd-3.json", { step: "nonsense" });
    writeWhole(ctl, "cmd-4.json", { step: "close" });
    // cmd-6 without a cmd-5: never reached.
    writeWhole(ctl, "cmd-6.json", { step: "save" });
    const code = await serve({ editor: e, ctl, clock: clock() });
    assert.equal(code, 7);
    assert.deepEqual(e.log, ["ready", "save", "windows", "close"]);
    assert.deepEqual(readJson(join(ctl, "ready.json")), { ready: true });
    assert.deepEqual(readJson(join(ctl, "done-1.json")), { saved: true });
    assert.match(readJson(join(ctl, "done-3.json")).error, /unknown step/);
    assert.deepEqual(readJson(join(ctl, "exit.json")).code, 7);
    assert.ok(!existsSync(join(ctl, "done-6.json")));
  } finally { rmSync(ctl, { recursive: true, force: true }); }
});

test("serve: the app gone ends the editor; so do the time limit and an editor that never got ready", async () => {
  const e = fakeEditor();
  let turns = 0;
  assert.equal(await serve({ editor: e, parentGone: () => ++turns > 3, clock: clock() }), EXIT.parentGone);
  assert.deepEqual(e.log, ["ready", "kill"]);
  const control = fakeEditor();
  let left = 3;
  const t = clock();
  // Control: with the parent there, the editor's own exit ends it (the code is the editor's), nothing killed.
  const p = serve({ editor: control, parentGone: () => false, clock: { now: t.now, sleep: async (ms) => { if (--left === 0) control.exit = { code: 0, signal: null }; await t.sleep(ms); } } });
  assert.equal(await p, 0);
  assert.deepEqual(control.log, ["ready"]);
  const slow = fakeEditor();
  assert.equal(await serve({ editor: slow, maxMs: 1000, clock: clock() }), EXIT.failed);
  assert.deepEqual(slow.log, ["ready", "close"], "past the limit it's closed (killed only if it stays)");
  const stuck = fakeEditor({ onClose: () => {} });
  assert.equal(await serve({ editor: stuck, maxMs: 1000, clock: clock() }), EXIT.failed);
  assert.deepEqual(stuck.log, ["ready", "close", "kill"]);
  const never = fakeEditor({ ready: { ready: false, dialogs: [{ title: "Error" }] }, onClose: () => {} });
  assert.equal(await serve({ editor: never, clock: clock() }), EXIT.failed);
  assert.deepEqual(never.log, ["ready", "close", "kill"]);
});

test("sessionEditor: the bwrap child's exit code and a killed editor come through to serve", async () => {
  const child = new EventEmitter();
  child.exitCode = null;
  const s = { editor: child, editorExited: false, killed: 0, killEditor() { this.killed++; this.editorExited = true; } };
  const e = sessionEditor(s, "/saved.w3x");
  assert.equal(e.exited(), null);
  child.emit("exit", 5, null);
  assert.deepEqual(e.exited(), { code: 5, signal: null });
  const other = new EventEmitter();
  other.exitCode = null;
  const s2 = { editor: other, editorExited: false, killed: 0, killEditor() { this.killed++; this.editorExited = true; } };
  const e2 = sessionEditor(s2, "/saved.w3x");
  e2.kill();
  assert.equal(s2.killed, 1);
  assert.deepEqual(e2.exited(), { code: 0, signal: null }, "killed by the session: gone before its exit event");
});

test("we-launch.mjs as a program: refused arguments exit 2 before anything starts; --check starts nothing", () => {
  const ctl = scratchDir("we-launch-run-");
  try {
    const run = (...a) => spawnSync(process.execPath, [SCRIPT, ...a], { encoding: "utf8", timeout: 60000 });
    const bad = run("--ctl", ctl, "--", "-launch", "-loadfile", "/m.w3x", "-extra");
    assert.equal(bad.status, EXIT.refused, bad.stderr);
    assert.match(bad.stderr, /isn't one the app gives it/);
    const check = run("--check");
    assert.equal(check.status, 0, check.stderr);
    const said = JSON.parse(check.stdout.trim().split("\n").at(-1));
    assert.ok(said.ok === true || typeof said.skipped === "string", check.stdout);
  } finally { rmSync(ctl, { recursive: true, force: true }); }
});
