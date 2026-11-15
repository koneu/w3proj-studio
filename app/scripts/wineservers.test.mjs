import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findOurWineservers, wineserverReport } from "../../tests/wineservers.mjs";

/** A fake /proc with the given processes: [pid, argv0, env]. */
function fakeProc(procs) {
  const root = mkdtempSync(join(tmpdir(), "w3proj-fakeproc-"));
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
