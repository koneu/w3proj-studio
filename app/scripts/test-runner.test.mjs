// scripts/test.mjs: two runs in one checkout (the gate's unit tests and an `npm test` beside them) don't clobber each
// other's bundles. This test runs from its own bundle, so a second run started from inside it must leave that bundle
// where it is.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

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
