// The display guard of we-x11.py (no test tool may click on the user's real desktop), through its `guard-check`
// mode with a fake /proc, plus the real command refusing without touching any display.
import { test as nodeTest } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { scratchDir } from "../../tests/scratch.mjs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { repoPath } from "../src/lib/testhelpers/testutil";

// The guard reads Linux /proc: nothing to test on Windows.
const test = (name, fn) => nodeTest(name, { skip: process.platform === "win32" }, fn);

// Tests run bundled elsewhere (not next to this file): found from the working directory up.
const HELPER = repoPath("app", "scripts", "we-x11.py");

// [Refactored] Check Python availability once per file instead of spawning a redundant probe at the start of every test.
let hasPy;
function skipWithoutPython(t) {
  if (hasPy === undefined) {
    const r = py(["guard-check", "--display", ":0", "--procroot", "/nonexistent"]);
    hasPy = r.status !== null;
  }
  if (!hasPy) t.skip("python3 isn't here");
  return !hasPy;
}

/** python3 on the helper; a python that couldn't start or ran past the time limit fails the test, with its reason. */
function py(args, env = {}) {
  const e = { ...process.env, ...env };
  if (!("W3_ALLOW_REAL_DISPLAY" in env)) delete e.W3_ALLOW_REAL_DISPLAY;
  const r = spawnSync("python3", ["-I", HELPER, ...args], { encoding: "utf8", env: e, timeout: 60_000 });
  assert.equal(r.error, undefined, `python3 did not finish: ${r.error?.message}`);
  return r;
}

/**
 * [Refactored] Evaluates multiple guard-check calls in a single Python process startup (using we-x11.py's main()),
 * cutting 17 separate python3 process spawns down to 1 per test while testing the exact CLI main() entry point.
 */
function batchChecks(cases) {
  const code = [
    "import importlib.util, io, json, os, sys, contextlib",
    "sys.dont_write_bytecode = True",
    "spec = importlib.util.spec_from_file_location('wx', sys.argv[1]); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)",
    "out = []",
    "for disp, root, env in json.loads(sys.argv[2]):",
    "    old = dict(os.environ)",
    "    os.environ.pop('W3_ALLOW_REAL_DISPLAY', None)",
    "    if env: os.environ.update(env)",
    "    buf = io.StringIO()",
    "    args = ['guard-check', '--procroot', root] + (['--display', disp] if disp is not None else [])",
    "    with contextlib.redirect_stdout(buf):",
    "        status = m.main(args)",
    "    os.environ.clear(); os.environ.update(old)",
    "    txt = buf.getvalue().strip()",
    "    out.append({'status': status, 'out': json.loads(txt.split('\\n')[-1]) if txt else None})",
    "print(json.dumps(out))",
  ].join("\n");
  const r = spawnSync("python3", ["-I", "-c", code, HELPER, JSON.stringify(cases)], { encoding: "utf8", timeout: 60_000 });
  assert.equal(r.error, undefined, `python3 did not finish: ${r.error?.message}`);
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim());
}

/** A fake /proc: each entry is { argv, unix?, sockets? } (unix: the text of net/unix; sockets: inodes the process holds open). */
function fakeProc(procs) {
  const root = scratchDir("w3-guard-");
  procs.forEach((p, i) => {
    const dir = join(root, String(100 + i));
    mkdirSync(join(dir, "net"), { recursive: true });
    writeFileSync(join(dir, "cmdline"), p.argv.join("\0") + "\0");
    if (p.unix) writeFileSync(join(dir, "net", "unix"), p.unix);
    if (p.sockets) {
      mkdirSync(join(dir, "fd"));
      p.sockets.forEach((ino, j) => symlinkSync(`socket:[${ino}]`, join(dir, "fd", String(3 + j))));
    }
  });
  return root;
}

test("display guard: refuses :0, a missing --display, and a display with no Xvfb behind it", (t) => {
  if (skipWithoutPython(t)) return;
  const root = fakeProc([{ argv: ["/usr/bin/Xorg", ":0"] }, { argv: ["Xvfb", ":7", "-screen", "0", "1x1x24"] }]);
  try {
    const [c0, cNull, c1, cLocal] = batchChecks([
      [":0", root, null],
      [null, root, null],
      [":1", root, null],
      ["localhost:0", root, null],
    ]);
    assert.equal(c0.status, 2);
    assert.equal(c0.out.allowed, false);
    assert.equal(cNull.status, 2);
    assert.equal(c1.status, 2);
    assert.equal(cLocal.status, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("display guard: allows an Xvfb we started (named by number, or by its -displayfd socket)", (t) => {
  if (skipWithoutPython(t)) return;
  const root = fakeProc([
    { argv: ["Xvfb", ":7", "-screen", "0", "1x1x24"] },
    { argv: ["/usr/bin/Xvfb", "-displayfd", "3"], sockets: [5], unix: "Num RefCount\n0000: 2 0 00010000 1 1 5 @/tmp/.X11-unix/X12\n" },
  ]);
  try {
    const [c7, c12, c12Screen, c1, c0] = batchChecks([
      [":7", root, null],
      [":12", root, null],
      [":12.0", root, null],
      [":1", root, null],
      [":0", root, null],
    ]);
    assert.equal(c7.status, 0);
    assert.equal(c12.out.allowed, true);
    assert.equal(c12Screen.status, 0);
    assert.equal(c1.status, 2, "X1 is not X12");
    assert.equal(c0.status, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("display guard: W3_ALLOW_REAL_DISPLAY=1 allows, anything else doesn't", (t) => {
  if (skipWithoutPython(t)) return;
  const root = fakeProc([]);
  try {
    const [cAllow0, cAllowNull, cDenyYes] = batchChecks([
      [":0", root, { W3_ALLOW_REAL_DISPLAY: "1" }],
      [null, root, { W3_ALLOW_REAL_DISPLAY: "1" }],
      [":0", root, { W3_ALLOW_REAL_DISPLAY: "yes" }],
    ]);
    assert.equal(cAllow0.status, 0);
    assert.equal(cAllowNull.status, 0);
    assert.equal(cDenyYes.status, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("display guard: a real command (click) on :0, or without --display, exits 2 before it connects", (t) => {
  if (skipWithoutPython(t)) return;
  // [Refactored] Removed redundant third `--display :0 key a` spawn (which slept another 0.8s in guard_with_retries
  // before reaching command dispatch, identical to `--display :0 click 5,5`).
  for (const args of [["--display", ":0", "click", "5,5"], ["click", "5,5"]]) {
    const r = py(args, { DISPLAY: ":0" });
    assert.equal(r.status, 2, args.join(" "));
    assert.match(r.stderr, /refused/);
  }
});

test("display guard: an fd that vanishes during the scan skips that fd, not the run's own Xvfb", (t) => {
  if (skipWithoutPython(t)) return;
  const unix = "Num RefCount\n0000: 2 0 00010000 1 1 5 @/tmp/.X11-unix/X12\n";
  const root = fakeProc([{ argv: ["/usr/bin/Xvfb", "-displayfd", "3"], sockets: [5], unix }]);
  try {
    // A plain file where an fd link was: readlink fails on it as on a client's fd closed between listdir and readlink.
    writeFileSync(join(root, "100", "fd", "2"), "");
    const [c12, c0] = batchChecks([[":12", root, null], [":0", root, null]]);
    assert.equal(c12.status, 0, "still allowed with broken fd sibling");
    assert.equal(c0.status, 2, "control: another display is still refused");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("display guard: a refusal is asked again before it counts (the scan races with /proc)", (t) => {
  if (skipWithoutPython(t)) return;
  // [Refactored] Run all 4 retry counts in a single python3 invocation instead of 4 separate spawns.
  const code = [
    "import importlib.util, json, sys",
    "sys.dont_write_bytecode = True",
    "spec = importlib.util.spec_from_file_location('wx', sys.argv[1]); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)",
    "def run(failures, display=':5'):",
    "    calls = []",
    "    def decide(d, p, e):",
    "        calls.append(d)",
    "        return (len(calls) > failures, 'n%d' % len(calls))",
    "    return [list(m.guard_with_retries(display, decide=decide, pause=0)), len(calls)]",
    "print(json.dumps([run(0), run(2), run(5), run(5, 'localhost:0')]))",
  ].join("\n");
  const r = spawnSync("python3", ["-I", "-c", code, HELPER], { encoding: "utf8", timeout: 60_000 });
  assert.equal(r.error, undefined, `python3 did not finish: ${r.error?.message}`);
  const [r0, r2, r5, rBad] = JSON.parse(r.stdout.trim());
  assert.deepEqual(r0, [[true, "n1"], 1], "allowed at once: asked once");
  assert.deepEqual(r2, [[true, "n3"], 3], "refused twice, then allowed: the run goes on");
  assert.deepEqual(r5, [[false, "n3"], 3], "control: refused three times is refused");
  assert.deepEqual(rBad, [[false, "n1"], 1], "a display of the wrong form isn't asked again");
});

test("display guard: an Xvfb with -displayfd does not own the desktop's X0 just because net/unix lists every socket", (t) => {
  if (skipWithoutPython(t)) return;
  // net/unix is the machine's list: X0 (the desktop, inode 9) and X12 (this Xvfb, inode 5). The Xvfb holds only 5.
  const unix = "Num RefCount\n0000: 2 0 00010000 1 1 9 @/tmp/.X11-unix/X0\n0001: 2 0 00010000 1 1 5 @/tmp/.X11-unix/X12\n";
  const root = fakeProc([{ argv: ["/usr/bin/Xvfb", "-displayfd", "3"], sockets: [5], unix }]);
  try {
    const [c0, c12] = batchChecks([[":0", root, null], [":12", root, null]]);
    assert.equal(c0.status, 2, "the desktop is refused");
    assert.equal(c12.status, 0, "its own display is allowed");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
