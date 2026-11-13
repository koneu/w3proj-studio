// tests/gamepath.mjs: where the game is. Outside a git repository (a scratch folder) the folder itself is the main
// checkout, and git's "fatal: not a git repository" doesn't reach the tool's output.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Tests run bundled elsewhere, from app/ (scripts/test.mjs): the module is found from there.
const app = process.cwd();
const gamepath = pathToFileURL(join(app, "..", "tests", "gamepath.mjs")).href;

/** Runs mainCheckout() in a child process started in `cwd`: what it printed and returned. `env`: added to its
 *  environment. */
function mainCheckoutIn(cwd, env = {}) {
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", `const m = await import(${JSON.stringify(gamepath)}); console.log(JSON.stringify(m.mainCheckout()));`],
    { cwd, encoding: "utf8", env: { ...process.env, ...env } });
  return { status: r.status, out: r.stdout.trim(), err: r.stderr };
}

test("mainCheckout outside a git repository: the folder itself, and nothing on stderr", () => {
  const dir = mkdtempSync(join(tmpdir(), "w3proj-gamepath-"));
  try {
    // git doesn't look above the folder (a temporary folder inside some repository would be found otherwise).
    const r = mainCheckoutIn(dir, { GIT_CEILING_DIRECTORIES: tmpdir() });
    assert.equal(r.status, 0, r.err);
    assert.equal(JSON.parse(r.out), dir);
    assert.equal(r.err, "", "git's message reached the output");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test(".game-path: the first listed folder that exists wins, else the first listed; comments and blanks don't count", async () => {
  const { listedGamePaths, pickGamePath } = await import(gamepath);
  const text = "# comment\r\n/home/me/Warcraft III\r\n\r\n  C:/Program Files (x86)/Warcraft III  \n";
  const listed = listedGamePaths(text);
  assert.deepEqual(listed, ["/home/me/Warcraft III", "C:/Program Files (x86)/Warcraft III"]);
  assert.equal(pickGamePath(listed, (p) => p.startsWith("C:")), "C:/Program Files (x86)/Warcraft III");
  assert.equal(pickGamePath(listed, () => true), "/home/me/Warcraft III");
  assert.equal(pickGamePath(listed, () => false), "/home/me/Warcraft III", "none exists: the first, so the message names it");
  assert.equal(pickGamePath([], () => true), null);
});

test("mainCheckout inside this checkout: the main checkout's folder (control: git did run)", () => {
  const r = mainCheckoutIn(app);
  assert.equal(r.status, 0, r.err);
  const top = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: app, encoding: "utf8" }).stdout.trim();
  assert.equal(JSON.parse(r.out), resolve(top, ".."));
});
