import { test as nodeTest } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { scratchDir } from "../../tests/scratch.mjs";
import { findOurWineservers, wineserverReport } from "../../tests/wineservers.mjs";

// The check reads Linux /proc and POSIX paths: nothing to test on Windows.
const test = (name, fn) => nodeTest(name, { skip: process.platform === "win32" }, fn);

/** A fake /proc with the given processes: [pid, argv0, env]. */
function fakeProc(procs) {
  const root = scratchDir("w3proj-fakeproc-");
  for (const [pid, argv0, env] of procs) {
    const d = join(root, String(pid));
    mkdirSync(d);
    writeFileSync(d + "/cmdline", `${argv0}\0-f\0`);
    writeFileSync(d + "/environ", Object.entries(env).map(([k, v]) => `${k}=${v}\0`).join(""));
  }
  return root;
}

test("a wineserver started from inside the repository is reported, others are not", () => {
  const proc = fakeProc([
    [11, "/p/files/bin/wineserver", { PWD: "/r/app", WINEPREFIX: "/steam/pfx/" }],
    [12, "/p/files/bin/wineserver", { PWD: "/elsewhere", WINEPREFIX: "/steam/pfx/" }],
    [13, "/p/files/bin/wineserver", { PWD: "/r2/app" }], // a folder that merely starts with the same letters
    [14, "/usr/bin/sleep", { PWD: "/r/app" }], // not a wineserver
  ]);
  try {
    const found = findOurWineservers(["/r"], proc);
    assert.deepEqual(found.map((f) => f.pid), [11]);
    assert.equal(found[0].prefix, "/steam/pfx/");
    const lines = wineserverReport(["/r"], proc);
    assert.match(lines[0], /1 wineserver/);
    assert.deepEqual(wineserverReport(["/nothing"], proc), []);
  } finally {
    rmSync(proc, { recursive: true, force: true });
  }
});

test("a missing /proc or an unreadable entry finds nothing and doesn't throw", () => {
  assert.deepEqual(findOurWineservers(["/r"], "/does/not/exist"), []);
});

test("odd /proc entries are skipped, and the good one beside them is still found", () => {
  const proc = fakeProc([[21, "/p/bin/wineserver", { PWD: "/r/app" }]]); // control: found
  const entry = (name, files) => {
    const d = join(proc, name);
    mkdirSync(d);
    for (const [f, text] of Object.entries(files)) writeFileSync(join(d, f), text);
    return d;
  };
  try {
    entry("22", { environ: "PWD=/r/app\0" }); // no cmdline at all
    entry("23", { cmdline: "", environ: "PWD=/r/app\0" }); // an empty cmdline (a kernel thread)
    entry("self", { cmdline: "/p/bin/wineserver\0", environ: "PWD=/r/app\0" }); // not a pid
    entry("24", { cmdline: "/p/bin/wineserver\0" }); // no environ: unreadable
    mkdirSync(join(entry("25", { environ: "PWD=/r/app\0" }), "cmdline")); // reading a folder as a file fails
    const d = entry("26", { cmdline: "/p/bin/wineserver\0" });
    mkdirSync(join(d, "environ"));
    assert.deepEqual(findOurWineservers(["/r"], proc).map((f) => f.pid), [21]);
  } finally {
    rmSync(proc, { recursive: true, force: true });
  }
});
