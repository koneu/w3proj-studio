// check-scripts.mjs: the repository's scripts as they are pass (the control), and broken copies of app-smoke.mjs fail it
// the ways merges broke it: a syntax error, a check the full run calls that --only doesn't name, and the other way round.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkScripts, scriptFiles, smokeChecks, smokeListProblems, syntaxProblems } from "./check-scripts.mjs";

// npm test, the gate and the coverage run all start the runner in app/.
const repo = join(process.cwd(), "..");
const smokePath = join(repo, "app", "scripts", "app-smoke.mjs");
const smoke = readFileSync(smokePath, "utf8");

test("the scripts as they are load, and app-smoke's two lists agree", async () => {
  const files = scriptFiles(repo);
  for (const f of ["app/scripts/app-smoke.mjs", "app/scripts/script-check/run.mjs", "tests/gate.mjs"]) assert.ok(files.includes(join(repo, ...f.split("/"))), f);
  assert.ok(!files.some((f) => f.includes("fixtures")), "tests/fixtures are left out");
  const { problems } = await checkScripts(repo);
  assert.deepEqual(problems, []);
  const checks = smokeChecks(smoke);
  assert.ok(checks.only.length >= 30 && checks.run.length >= 30, `${checks.only.length} in --only, ${checks.run.length} in the run`);
  // The checks a for loop runs count too.
  assert.ok(checks.run.includes("heightsPreserve") && checks.run.includes("heightsLimits"));
});

test("a broken copy of app-smoke.mjs doesn't load", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "w3proj-check-scripts-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const good = join(dir, "good.mjs"), broken = join(dir, "broken.mjs");
  writeFileSync(good, smoke);
  // What the bad merge left: a function's closing brace gone.
  const at = smoke.indexOf("\n}\n", smoke.indexOf("async function viewModes"));
  writeFileSync(broken, smoke.slice(0, at) + smoke.slice(at + 2));
  const problems = await syntaxProblems([good, broken]);
  assert.deepEqual(problems.map((p) => p.file), [broken]);
  assert.match(problems[0].message, /SyntaxError/);
});

test("the --only map and the full run must name the same checks", () => {
  assert.deepEqual(smokeListProblems(smoke), []);
  // A check added to the full run only.
  const runOnly = smoke.replace("    await viewModes(page, found).catch(", "    await brandNew(page, found).catch(() => {});\n    await viewModes(page, found).catch(") + "\nasync function brandNew() {}\n";
  assert.notEqual(runOnly, smoke);
  assert.match(smokeListProblems(runOnly).join("\n"), /--only can't run.*brandNew/);
  // One taken out of the --only map.
  const map = /const onlyChecks = \{[\s\S]*?\};/.exec(smoke)[0];
  const lessOnly = smoke.replace(map, map.replace(" viewModes,", ""));
  assert.notEqual(lessOnly, smoke);
  assert.match(smokeListProblems(lessOnly).join("\n"), /--only can't run.*viewModes/);
  // One taken out of the full run.
  const lessRun = smoke.replace(/\n\s*await viewModes\(page, found\)[^\n]*/, "");
  assert.notEqual(lessRun, smoke);
  assert.match(smokeListProblems(lessRun).join("\n"), /the full run doesn't call: viewModes/);
  // One named in both but declared nowhere.
  const undeclared = smoke.replace("async function viewModes(", "async function viewModesRenamed(");
  assert.match(smokeListProblems(undeclared).join("\n"), /not declared as functions: viewModes/);
  // The map itself gone (renamed): said so, not passed.
  assert.match(smokeListProblems(smoke.replace("const onlyChecks = {", "const checks = {")).join("\n"), /wasn't found/);
});
