// The make-*.mjs generators (tests/fixtures/we-specs): a mode or argument they don't know exits 2 and leaves the committed
// fixtures alone (it used to run the default mode and overwrite camps.w3x and the like).

import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { repoPath } from "../src/lib/testhelpers/testutil";
import { modeArgs, requireValid } from "../../tests/gen-args.mjs";

const specs = repoPath("tests", "fixtures", "we-specs");
/** name -> size and mtime of every file in the folder, to see that nothing was written. */
const snapshot = () => Object.fromEntries(readdirSync(specs).map((n) => [n, `${statSync(join(specs, n)).size}/${statSync(join(specs, n)).mtimeMs}`]));
// Any existing file stands in for the cli and the game folder: the arguments are checked before they are used.
const run = (script, ...args) => spawnSync(process.execPath, [join(specs, script), process.execPath, specs, ...args], { encoding: "utf8", env: { ...process.env, W3_ALLOW_STALE: "1" } });

test("modeArgs leaves out --allow-stale", () => {
  assert.deepEqual(modeArgs(["node", "x.mjs", "cli", "game", "--allow-stale", "far", "1,2"]), ["far", "1,2"]);
  assert.deepEqual(modeArgs(["node", "x.mjs", "cli", "game"]), []);
  requireValid(true, "never printed"); // returns when valid (the exit 2 is tested through the generators below)
});

test("an unknown mode exits 2 and writes nothing", () => {
  const before = snapshot();
  const bad = [
    ["make-camps.mjs", "bb"], ["make-camps.mjs", "far"], ["make-camps.mjs", "far", "1,2,3,4,5"], ["make-camps.mjs", "far", "x"], ["make-camps.mjs", "b", "extra"],
    ["make-doodad-snap.mjs", "mroe"], ["make-doodad-snap.mjs", "more", "tex"],
    ["make-fence.mjs", "angels"], ["make-neutral-facing.mjs", "pos"],
    ["make-custom-tilesets.mjs", "rev7"], ["make-minimap-tiles.mjs", "randd"],
    ["make-import-modes.mjs", "--out"], ["make-import-modes.mjs", "--oops"],
    ["make-melee-valid.mjs", "--out"], ["make-melee-valid.mjs", "--case"], ["make-melee-valid.mjs", "--case", "x"], ["make-melee-valid.mjs", "--case", "../x={}"],
  ];
  for (const [script, ...args] of bad) {
    const r = run(script, ...args);
    assert.equal(r.status, 2, `${script} ${args.join(" ")}: exit ${r.status}\n${r.stderr}`);
  }
  assert.deepEqual(snapshot(), before);
});

test("control: a known mode is not refused (it gets as far as the missing tools)", () => {
  // The cli here is node itself, so the unpack step fails (exit 1, not 2); nothing is written before it.
  const before = snapshot();
  for (const [script, ...args] of [["make-camps.mjs", "b"], ["make-camps.mjs", "far", "1700,2800"], ["make-fence.mjs", "dest"], ["make-neutral-facing.mjs", "neg"], ["make-doodad-snap.mjs", "misc"], ["make-custom-tilesets.mjs", "few3"], ["make-minimap-tiles.mjs", "impulse"]]) {
    const r = run(script, ...args);
    assert.notEqual(r.status, 2, `${script} ${args.join(" ")}: refused\n${r.stderr}`);
  }
  assert.deepEqual(snapshot(), before);
});
