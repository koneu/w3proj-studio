// check-scripts.mjs: the repository's scripts as they are pass (the control), and broken copies of app-smoke.mjs fail it
// the ways merges broke it: a syntax error, a check the full run calls that --only doesn't name, and the other way round.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { scratchDir } from "../../tests/scratch.mjs";
import { repoPath } from "../src/lib/testhelpers/testutil";
import { checkScripts, generatorProblems, readmeProblems, scriptFiles, smokeChecks, smokeListProblems, smokeRunProblems, syntaxProblems } from "./check-scripts.mjs";

// The repository's root, found from the working directory up.
const repo = dirname(dirname(repoPath("tests", "gate.mjs")));
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
  assert.ok(checks.run.includes("heightsPreserve") && checks.run.includes("newMaps"));
});

test("a broken copy of app-smoke.mjs doesn't load", async (t) => {
  const dir = scratchDir("w3proj-check-scripts-");
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
  const runOnly = smoke.replace("  [viewModes, ", "  [brandNew, \"brand new\"],\n  [viewModes, ") + "\nasync function brandNew() {}\n";
  assert.notEqual(runOnly, smoke);
  assert.match(smokeListProblems(runOnly).join("\n"), /--only can't run.*brandNew/);
  // One taken out of the --only map.
  const map = /const onlyChecks = \{[\s\S]*?\};/.exec(smoke)[0];
  const lessOnly = smoke.replace(map, map.replace(" viewModes,", ""));
  assert.notEqual(lessOnly, smoke);
  assert.match(smokeListProblems(lessOnly).join("\n"), /--only can't run.*viewModes/);
  // One taken out of the full run.
  const lessRun = smoke.replace(/\n  \[viewModes, [^\n]*/, "");
  assert.notEqual(lessRun, smoke);
  assert.match(smokeListProblems(lessRun).join("\n"), /the full run doesn't call: viewModes/);
  // One named in both but declared nowhere.
  const undeclared = smoke.replace("async function viewModes(", "async function viewModesRenamed(");
  assert.match(smokeListProblems(undeclared).join("\n"), /not declared as functions: viewModes/);
  // Two checks on one line, and one out of alphabetical order: both said (parallel branches then conflict on the line).
  const crowded = smoke.replace(map, map.replace("        cameraEditing,\n", "").replace("        byHand,", "        byHand, cameraEditing,"));
  assert.notEqual(crowded, smoke);
  assert.match(smokeListProblems(crowded).join("\n"), /one check per line; split: byHand, cameraEditing,/);
  const unsorted = smoke.replace(map, map.replace("        viewModes,\n", "").replace("        byHand,", "        viewModes,\n        byHand,"));
  assert.notEqual(unsorted, smoke);
  assert.match(smokeListProblems(unsorted).join("\n"), /alphabetical order; byHand comes before viewModes/);
  // One in the full run's list twice: it would run twice.
  const twice = smoke.replace("  [viewModes, ", "  [byHand, \"again\"],\n  [viewModes, ");
  assert.match(smokeListProblems(twice).join("\n"), /named twice in the full run's list: byHand/);
  // The list gone (renamed), or the map: said so, not passed.
  assert.match(smokeListProblems(smoke.replace("const CHECKS = [", "const LIST = [")).join("\n"), /full run's list .* wasn't found/);
  assert.match(smokeListProblems(smoke.replace("const onlyChecks = {", "const checks = {")).join("\n"), /wasn't found/);
});

test("a generator that names war3map.wtg.json or war3map.wct.txt is a problem", () => {
  assert.deepEqual(generatorProblems({ "make-ok.mjs": 'join(map, "triggers")' }), []);
  const p = generatorProblems({ "make-a.mjs": 'join(map, "war3map.wtg.json")', "make-b.mjs": "// war3map.wct.txt and war3map.wtg.json" });
  assert.equal(p.length, 3);
  assert.ok(p[0].startsWith("make-a.mjs: names war3map.wtg.json"));
});

test("a function of app-smoke.mjs that calls run( without a local run is a problem", () => {
  // The real file passes (the control), and takes the real local runs away: each function that declares one then fails.
  assert.deepEqual(smokeRunProblems(smoke), []);
  const stripped = smoke.replace("  const run = (id) => page.evaluate(`w3.commands.execute(${lit(id)})`);", "");
  assert.notEqual(stripped, smoke);
  assert.match(smokeRunProblems(stripped).join("\n"), /calls run\( but declares no run/);
  const bad = "async function check(page) {\n  await run(\"x\");\n}\nasync function run() {}\nawait run();\n";
  assert.equal(smokeRunProblems(bad).length, 1);
  assert.match(smokeRunProblems(bad)[0], /^app-smoke\.mjs:2: check\(\)/);
  // Declared locally in any way, named only in a string or comment, a method, or marked: all fine.
  for (const ok of [
    "async function c(page) {\n  const run = (id) => id;\n  await run(1);\n}",
    "async function c(page, run) {\n  await run(1);\n}",
    "async function c(page) {\n  const { run } = k;\n  await run(1);\n}",
    "async function c(page) {\n  await k.run(1); // run(2)\n  const s = \"run(3)\", t = `run(4) ${k.run(5)}`;\n}",
    "async function c(page) {\n  await run(1); // top-level run\n}",
  ]) assert.deepEqual(smokeRunProblems(ok), [], ok);
  assert.equal(smokeRunProblems("async function c(page) {\n  const t = `${run(1)}`;\n}").length, 1);
});

test("a built-in extension folder without a README.md is a problem", () => {
  // The repository passes (the control); a copy of its builtin folder names with one README missing fails.
  assert.deepEqual(readmeProblems(repo), []);
  const fake = scratchDir("readme-problems");
  const dir = join(fake, "app", "src", "builtin");
  mkdirSync(join(dir, "has"), { recursive: true });
  mkdirSync(join(dir, "lacks"), { recursive: true });
  writeFileSync(join(dir, "has", "README.md"), "x");
  assert.deepEqual(readmeProblems(fake).map((p) => p.split(":")[0]), ["app/src/builtin/lacks"]);
  rmSync(fake, { recursive: true, force: true });
});
