// The display guard of we-x11.py (no test tool may click on the user's real desktop), through its `guard-check`
// mode with a fake /proc, plus the real command refusing without touching any display.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// Tests run from app/ (the runner copies the compiled tests elsewhere, so not next to this file).
const HELPER = join(process.cwd(), "scripts", "we-x11.py");

function py(args, env = {}) {
  const e = { ...process.env, ...env };
  if (!("W3_ALLOW_REAL_DISPLAY" in env)) delete e.W3_ALLOW_REAL_DISPLAY;
  return spawnSync("python3", ["-I", HELPER, ...args], { encoding: "utf8", env: e });
}

/** A fake /proc: each entry is { argv, unix? } (unix: the text of net/unix). */
function fakeProc(procs) {
  const root = mkdtempSync(join(tmpdir(), "w3-guard-"));
  procs.forEach((p, i) => {
    const dir = join(root, String(100 + i));
    mkdirSync(join(dir, "net"), { recursive: true });
    writeFileSync(join(dir, "cmdline"), p.argv.join("\0") + "\0");
    if (p.unix) writeFileSync(join(dir, "net", "unix"), p.unix);
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
    { argv: ["/usr/bin/Xvfb", "-displayfd", "3"], unix: "Num RefCount\n0000: 2 0 00010000 1 1 5 @/tmp/.X11-unix/X12\n" },
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
