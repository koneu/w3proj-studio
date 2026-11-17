// we-x11.py's own behaviour: how it reads keys and rectangles (no display), and on an Xvfb of the test's own (skipped
// where there is none, or no python-xlib): Num Lock read and set, a closed window not reported closed, Shift for a
// shifted character, a text it can't type refused whole, a held key let go when the helper is stopped, and the
// deadline that ends a command on a hung X server. we-drive drives the World Editor through these commands.

import { test as nodeTest } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scratchDir } from "../../tests/scratch.mjs";
import { repoPath } from "../src/lib/testhelpers/testutil";

// The helper and Xvfb are Linux tools (we-drive runs there only).
const test = (name, fn) => nodeTest(name, { skip: process.platform === "win32" }, fn);

// Tests run bundled elsewhere (not next to this file): found from the working directory up.
const HELPER = repoPath("app", "scripts", "we-x11.py");

const py = (args, opts = {}) => spawnSync("python3", ["-I", HELPER, ...args], { encoding: "utf8", timeout: 60_000, ...opts });
const json = (r) => JSON.parse(r.stdout.trim().split("\n").pop());

/** Skips the test when python3 can't run the helper's display-free modes at all. */
function skipWithoutPython(t) {
  const r = py(["key", "--dry", "a"]);
  if (r.error?.code === "ENOENT") { t.skip("python3 isn't here"); return true; }
  assert.equal(r.status, 0, `the helper's dry key failed: ${r.stderr}`);
  return false;
}

test("key specs: modifiers and key, '+' as the plus key; an unknown modifier is a message, not a traceback", (t) => {
  if (skipWithoutPython(t)) return;
  const read = (spec) => json(py(["key", "--dry", spec]));
  assert.deepEqual(read("ctrl+shift+s"), { mods: ["ctrl", "shift"], key: "s" });
  assert.deepEqual(read("+"), { mods: [], key: "+" });
  assert.deepEqual(read("ctrl++"), { mods: ["ctrl"], key: "+" });
  assert.deepEqual(read("KP_6"), { mods: [], key: "KP_6" });
  for (const [spec, re] of [["meta+x", /unknown modifier 'meta'/], ["ctrl+", /empty part/], ["ctrl++x", /empty part/]]) {
    const r = py(["key", "--dry", spec]);
    assert.equal(r.status, 1, spec);
    assert.match(r.stderr, re, spec);
    assert.doesNotMatch(r.stderr, /Traceback/, spec);
  }
});

test("rectangles: clipped to the screen with the size shrinking at a negative edge; an empty one is refused", (t) => {
  if (skipWithoutPython(t)) return;
  const rect = (r, screen = "800x600") => py(["rect", "--dry", r, "--screen", screen]);
  assert.deepEqual(json(rect("-10,-20,50,50")).rect, [0, 0, 40, 30], "the size shrinks with the edge moved in");
  assert.deepEqual(json(rect("780,590,50,50")).rect, [780, 590, 20, 10]);
  assert.deepEqual(json(rect("10,10,50,50")).rect, [10, 10, 50, 50], "control: inside, unchanged");
  assert.equal(json(rect("900,10,50,50")).rect, null, "outside the screen: nothing");
  for (const bad of ["1,1,0,5", "1,1,5,-1", "1,2,3", "a,b,c,d"]) {
    const r = rect(bad);
    assert.equal(r.status, 1, bad);
    assert.match(r.stderr, /--rect/, bad);
  }
});

// ---- on an Xvfb of the test's own -------------------------------------------------------------------------------

/** Starts Xvfb (-noreset: the lock state of Num Lock stays when a helper disconnects, as it does while the editor is
 *  connected) and returns { display, stop }, or null when Xvfb or python-xlib isn't there. */
async function xvfb(t) {
  if (spawnSync("Xvfb", ["-help"], { stdio: "ignore" }).error) { t.skip("no Xvfb"); return null; }
  if (spawnSync("python3", ["-I", "-c", "import Xlib"], { stdio: "ignore" }).status !== 0) { t.skip("no python-xlib"); return null; }
  const x = spawn("Xvfb", ["-displayfd", "3", "-noreset", "-screen", "0", "640x480x24", "-nolisten", "tcp"], { stdio: ["ignore", "ignore", "ignore", "pipe"] });
  const n = await new Promise((ok, fail) => {
    let got = "";
    const timer = setTimeout(() => fail(new Error("Xvfb didn't start")), 15000);
    x.stdio[3].on("data", (d) => { got += d; if (got.includes("\n")) { clearTimeout(timer); ok(got.trim()); } });
    x.on("exit", (c) => { clearTimeout(timer); fail(new Error(`Xvfb exited (${c})`)); });
  });
  const stop = () => { try { process.kill(x.pid, "SIGCONT"); x.kill("SIGKILL"); } catch { /* gone */ } };
  t.after(stop);
  return { display: `:${n}`, pid: x.pid, stop };
}

/** A window of a test client that records the keys it gets: { id, done } where done resolves to its key events. */
const RECORDER = String.raw`
import json, sys, time
from Xlib import display, X, XK
d = display.Display(sys.argv[1])
s = d.screen()
w = s.root.create_window(10, 10, 200, 100, 0, s.root_depth, event_mask=X.KeyPressMask)
w.map()
d.sync()
print(json.dumps({"id": w.id}), flush=True)
end = time.time() + float(sys.argv[2])
events = []
while time.time() < end:
    while d.pending_events():
        e = d.next_event()
        if e.type == X.KeyPress:
            sym = d.keycode_to_keysym(e.detail, 1 if e.state & X.ShiftMask else 0)
            events.append({"sym": XK.keysym_to_string(sym), "shift": bool(e.state & X.ShiftMask)})
    time.sleep(0.02)
print(json.dumps({"events": events}), flush=True)
`;

async function recorder(display, seconds) {
  const dir = scratchDir("we-x11-rec-");
  const file = join(dir, "recorder.py");
  writeFileSync(file, RECORDER);
  const child = spawn("python3", ["-I", file, display, String(seconds)], { stdio: ["ignore", "pipe", "inherit"] });
  let buf = "";
  const lines = [];
  let wake = null;
  child.stdout.on("data", (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) { lines.push(JSON.parse(buf.slice(0, nl))); buf = buf.slice(nl + 1); wake?.(); }
  });
  const next = () => new Promise((ok) => { if (lines.length) ok(lines.shift()); else wake = () => { wake = null; ok(lines.shift()); }; });
  const { id } = await next();
  return { id, done: next().finally(() => rmSync(dir, { recursive: true, force: true })) };
}

test("numlock: read from the X server, pressed only when it differs, and the state stays", async (t) => {
  const x = await xvfb(t);
  if (!x) return;
  const nl = (want) => json(py(["--display", x.display, "numlock", want]));
  assert.deepEqual(nl("status"), { numlock: "off", was: "off", pressed: false });
  assert.deepEqual(nl("on"), { numlock: "on", was: "off", pressed: true });
  // A second "on" (the next spec on the same display) doesn't toggle it off again, as a blind Num_Lock key would.
  assert.deepEqual(nl("on"), { numlock: "on", was: "on", pressed: false });
  assert.deepEqual(nl("off"), { numlock: "off", was: "on", pressed: true });
  assert.equal(py(["--display", x.display, "numlock", "maybe"]).status, 1);
});

test("close, click: a window that is gone isn't reported closed or clicked", async (t) => {
  const x = await xvfb(t);
  if (!x) return;
  const gone = String(0x7ffffff0);
  assert.deepEqual(json(py(["--display", x.display, "close", gone])), { close: 0x7ffffff0, closed: false, reason: `window ${0x7ffffff0} is gone or not mapped` });
  assert.equal(json(py(["--display", x.display, "click", "5,5", "--window", gone])).pressed, false);
  // Control: a live window is asked to close.
  const rec = await recorder(x.display, 3);
  assert.equal(json(py(["--display", x.display, "close", String(rec.id)])).closed, true);
  await rec.done;
});

test("keys: Shift for a capital and '+', none for a plain letter; a text with a character it can't type types nothing", async (t) => {
  const x = await xvfb(t);
  if (!x) return;
  const rec = await recorder(x.display, 4);
  const at = ["--display", x.display];
  for (const k of ["a", "A", "+"]) assert.equal(py([...at, "key", "--window", String(rec.id), k]).status, 0, k);
  const bad = py([...at, "type", "--window", String(rec.id), "abé"]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /can't type 'é'/);
  const { events } = await rec.done;
  // The Shift key's own press has no printable name (null) here.
  const keys = events.filter((e) => e.sym !== null && !/^Shift/.test(e.sym));
  assert.deepEqual(keys, [{ sym: "a", shift: false }, { sym: "A", shift: true }, { sym: "+", shift: true }], "and nothing of 'abé'");
});

test("a held key is let go when the helper is stopped (SIGTERM) or its deadline passes on a hung X server", async (t) => {
  const x = await xvfb(t);
  if (!x) return;
  const at = ["--display", x.display];
  const keysDown = () => json(spawnSync("python3", ["-I", "-c", "import json, sys\nfrom Xlib import display\nprint(json.dumps(sum(bin(b).count('1') for b in display.Display(sys.argv[1]).query_keymap())))", x.display], { encoding: "utf8" }));
  const held = spawn("python3", ["-I", HELPER, ...at, "key", "a", "--hold", "20000"], { stdio: "ignore" });
  const exited = new Promise((ok) => held.on("exit", (code, signal) => ok({ code, signal })));
  await new Promise((ok) => setTimeout(ok, 1500));
  assert.equal(keysDown(), 1, "control: the key is down while held");
  held.kill("SIGTERM");
  const end = await exited;
  assert.equal(end.signal, null, "the helper ended itself (its SIGTERM handler), it wasn't killed by the signal");
  assert.equal(keysDown(), 0, "the key was let go");
  // A hung X server (stopped): the deadline ends the command instead of hanging until someone kills it.
  process.kill(x.pid, "SIGSTOP");
  try {
    const t0 = Date.now();
    const r = py(["--deadline", "1", ...at, "windows"], { timeout: 20_000 });
    assert.equal(r.error, undefined, "ended by its own deadline, not by the test's timeout");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /timed out after 1/);
    assert.ok(Date.now() - t0 < 10_000);
  } finally {
    process.kill(x.pid, "SIGCONT");
  }
});

test("frames and grabs refuse what would divide by zero or ask X for an empty picture", async (t) => {
  const x = await xvfb(t);
  if (!x) return;
  const at = ["--display", x.display];
  const zero = py([...at, "frames", "0"]);
  assert.equal(zero.status, 1);
  assert.match(zero.stderr, /frames wants MS above 0/);
  const out = py([...at, "stats", "--rect", "900,10,5,5"]);
  assert.equal(out.status, 1);
  assert.match(out.stderr, /outside the 640x480 screen/);
  // Control: a rect half off the screen is grabbed as its part on it.
  const dir = scratchDir("we-x11-shot-");
  try {
    assert.deepEqual(json(py([...at, "shot", join(dir, "a.png"), "--rect", "-10,-10,30,30"])).size, [20, 20]);
    assert.ok(existsSync(join(dir, "a.png")));
  } finally { rmSync(dir, { recursive: true, force: true }); }
  assert.doesNotMatch(zero.stderr + out.stderr, /Traceback/);
});
