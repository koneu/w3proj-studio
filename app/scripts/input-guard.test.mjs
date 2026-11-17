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

/** python3 on the helper; a python that couldn't start or ran past the time limit fails the test, with its reason. */
function py(args, env = {}) {
  const e = { ...process.env, ...env };
  if (!("W3_ALLOW_REAL_DISPLAY" in env)) delete e.W3_ALLOW_REAL_DISPLAY;
  const r = spawnSync("python3", ["-I", HELPER, ...args], { encoding: "utf8", env: e, timeout: 60_000 });
  assert.equal(r.error, undefined, `python3 did not finish: ${r.error?.message}`);
  return r;
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

const check = (display, root, env) => {
  const r = py(["guard-check", ...(display ? ["--display", display] : []), "--procroot", root], env);
  return { status: r.status, out: r.stdout ? JSON.parse(r.stdout.trim().split("\n").pop()) : null };
};

test("display guard: refuses :0, a missing --display, and a display with no Xvfb behind it", (t) => {
  if (py(["guard-check", "--display", ":0", "--procroot", "/nonexistent"]).status === null) return t.skip("python3 isn't here");
  const root = fakeProc([{ argv: ["/usr/bin/Xorg", ":0"] }, { argv: ["Xvfb", ":7", "-screen", "0", "1x1x24"] }]);
  try {
    assert.equal(check(":0", root).status, 2);
    assert.equal(check(":0", root).out.allowed, false);
    assert.equal(check(null, root).status, 2);
    assert.equal(check(":1", root).status, 2);
    assert.equal(check("localhost:0", root).status, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("display guard: allows an Xvfb we started (named by number, or by its -displayfd socket)", (t) => {
  if (py(["guard-check", "--display", ":0", "--procroot", "/nonexistent"]).status === null) return t.skip("python3 isn't here");
  const root = fakeProc([
    { argv: ["Xvfb", ":7", "-screen", "0", "1x1x24"] },
    { argv: ["/usr/bin/Xvfb", "-displayfd", "3"], sockets: [5], unix: "Num RefCount\n0000: 2 0 00010000 1 1 5 @/tmp/.X11-unix/X12\n" },
  ]);
  try {
    assert.equal(check(":7", root).status, 0);
    assert.equal(check(":12", root).out.allowed, true);
    assert.equal(check(":12.0", root).status, 0);
    assert.equal(check(":1", root).status, 2, "X1 is not X12");
    assert.equal(check(":0", root).status, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("display guard: W3_ALLOW_REAL_DISPLAY=1 allows, anything else doesn't", (t) => {
  if (py(["guard-check", "--display", ":0", "--procroot", "/nonexistent"]).status === null) return t.skip("python3 isn't here");
  const root = fakeProc([]);
  try {
    assert.equal(check(":0", root, { W3_ALLOW_REAL_DISPLAY: "1" }).status, 0);
    assert.equal(check(null, root, { W3_ALLOW_REAL_DISPLAY: "1" }).status, 0);
    assert.equal(check(":0", root, { W3_ALLOW_REAL_DISPLAY: "yes" }).status, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("display guard: a real command (click) on :0, or without --display, exits 2 before it connects", (t) => {
  const probe = py(["guard-check", "--display", ":0", "--procroot", "/nonexistent"]);
  if (probe.status === null) return t.skip("python3 isn't here");
  for (const args of [["--display", ":0", "click", "5,5"], ["click", "5,5"], ["--display", ":0", "key", "a"]]) {
    const r = py(args, { DISPLAY: ":0" });
    assert.equal(r.status, 2, args.join(" "));
    assert.match(r.stderr, /refused/);
  }
});

test("display guard: an fd that vanishes during the scan skips that fd, not the run's own Xvfb", (t) => {
  if (py(["guard-check", "--display", ":0", "--procroot", "/nonexistent"]).status === null) return t.skip("python3 isn't here");
  const unix = "Num RefCount\n0000: 2 0 00010000 1 1 5 @/tmp/.X11-unix/X12\n";
  const root = fakeProc([{ argv: ["/usr/bin/Xvfb", "-displayfd", "3"], sockets: [5], unix }]);
  try {
    assert.equal(check(":12", root).status, 0, "control: allowed with only its socket");
    // A plain file where an fd link was: readlink fails on it as on a client's fd closed between listdir and readlink.
    writeFileSync(join(root, "100", "fd", "2"), "");
    assert.equal(check(":12", root).status, 0, "still allowed");
    assert.equal(check(":0", root).status, 2, "control: another display is still refused");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("display guard: a refusal is asked again before it counts (the scan races with /proc)", (t) => {
  if (py(["guard-check", "--display", ":0", "--procroot", "/nonexistent"]).status === null) return t.skip("python3 isn't here");
  const run = (failures, display = ":5") => {
    const code = [
      "import importlib.util, json, sys",
      "sys.dont_write_bytecode = True",
      "spec = importlib.util.spec_from_file_location('wx', sys.argv[1]); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)",
      "calls = []",
      "def decide(d, p, e):",
      "    calls.append(d)",
      "    return (len(calls) > int(sys.argv[2]), 'n%d' % len(calls))",
      "print(json.dumps([m.guard_with_retries(sys.argv[3], decide=decide, pause=0), len(calls)]))",
    ].join("\n");
    const r = spawnSync("python3", ["-I", "-c", code, HELPER, String(failures), display], { encoding: "utf8", timeout: 60_000 });
    assert.equal(r.error, undefined, `python3 did not finish: ${r.error?.message}`);
    return JSON.parse(r.stdout.trim());
  };
  assert.deepEqual(run(0), [[true, "n1"], 1], "allowed at once: asked once");
  assert.deepEqual(run(2), [[true, "n3"], 3], "refused twice, then allowed: the run goes on");
  assert.deepEqual(run(5), [[false, "n3"], 3], "control: refused three times is refused");
  assert.deepEqual(run(5, "localhost:0"), [[false, "n1"], 1], "a display of the wrong form isn't asked again");
});

test("display guard: an Xvfb with -displayfd does not own the desktop's X0 just because net/unix lists every socket", (t) => {
  if (py(["guard-check", "--display", ":0", "--procroot", "/nonexistent"]).status === null) return t.skip("python3 isn't here");
  // net/unix is the machine's list: X0 (the desktop, inode 9) and X12 (this Xvfb, inode 5). The Xvfb holds only 5.
  const unix = "Num RefCount\n0000: 2 0 00010000 1 1 9 @/tmp/.X11-unix/X0\n0001: 2 0 00010000 1 1 5 @/tmp/.X11-unix/X12\n";
  const root = fakeProc([{ argv: ["/usr/bin/Xvfb", "-displayfd", "3"], sockets: [5], unix }]);
  try {
    assert.equal(check(":0", root).status, 2, "the desktop is refused");
    assert.equal(check(":12", root).status, 0, "its own display is allowed");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
