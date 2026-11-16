// scripts/test.mjs: two runs in one checkout (the gate's unit tests and an `npm test` beside them) don't clobber each
// other's bundles. This test runs from its own bundle, so a second run started from inside it must leave that bundle
// where it is. And it hands the bundles to node --test in batches that fit on a Windows command line.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { COMMAND_LINE_LIMIT, testBatches } from "./test-batches.mjs";

// npm test, the gate and the coverage run all start the runner in app/.
const app = process.cwd();

test("a second test run leaves the first one's bundles alone", () => {
  const runner = join(app, "scripts", "test.mjs");
  assert.ok(existsSync(runner), `run from app/: no ${runner}`);
  const mine = fileURLToPath(import.meta.url);
  assert.ok(existsSync(mine), `this test's bundle: ${mine}`);
  // The second run gets the default output folder, not the coverage run's (which this one may be running in).
  const env = { ...process.env };
  delete env.W3_TEST_OUT;
  delete env.NODE_V8_COVERAGE;
  const other = spawnSync(process.execPath, [runner, join(app, "scripts", "coverage-core.test.mjs")], { cwd: app, env, encoding: "utf8" });
  assert.equal(other.status, 0, `the second run failed:\n${other.stdout}\n${other.stderr}`);
  assert.ok(existsSync(mine), "the second run removed the first run's bundles");
});

test("the bundles go to node --test in batches whose command lines Windows accepts", () => {
  // As on GitHub's Windows runner: 291 files there made a 32820-character command line, and CreateProcess refused it.
  const out = "D:\\a\\w3proj-studio\\w3proj-studio\\app\\node_modules\\.cache\\w3-tests\\run-1234\\";
  const files = Array.from({ length: 600 }, (_, i) => `${out}src\\builtin\\terrain-painter\\file-${i}.test.mjs`);
  const exe = "C:\\Program Files\\nodejs\\node.exe";
  const fixed = ["--enable-source-maps", "--test", "--test-reporter=dot"];
  const batches = testBatches(files, fixed, exe);
  assert.ok(batches.length > 1, "600 long paths fit on one command line");
  assert.deepEqual(batches.flat(), files, "every file once, in order");
  for (const b of batches) {
    const line = [`"${exe}"`, ...fixed, ...b].join(" ");
    assert.ok(line.length < 32767 && line.length <= COMMAND_LINE_LIMIT, `a batch's command line is ${line.length} characters`);
  }
  // A short list stays one run, and a single file too long on its own still runs.
  assert.deepEqual(testBatches(files.slice(0, 3), fixed, exe), [files.slice(0, 3)]);
  assert.deepEqual(testBatches(["x".repeat(40000), "y"], [], "node"), [["x".repeat(40000)], ["y"]]);
});
