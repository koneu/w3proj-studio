// verify-build.mjs pruneBuilds: old builds go, the newest N, locked and recently used ones stay, nothing outside
// target/verify and target/verify-runs is touched, a dry run removes nothing.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { scratchDir } from "../../tests/scratch.mjs";
import { inside, pruneBuilds } from "./verify-build.mjs";

const NOW = Date.now();
const HOUR = 3600 * 1000;
const at = (path, ms) => utimesSync(path, new Date(ms), new Date(ms));

/** builds: { sha: { age (hours since built), runsAge (hours since the runs folder changed; omit = no runs), lock } } */
function fake(builds) {
  const root = scratchDir("w3proj-verify-prune-");
  for (const [sha, b] of Object.entries(builds)) {
    const dir = join(root, "target", "verify", sha);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "verify.json"), "{}");
    writeFileSync(join(dir, "big.bin"), "x".repeat(1000));
    at(join(dir, "verify.json"), NOW - b.age * HOUR);
    at(dir, NOW - b.age * HOUR);
    if (b.runsAge !== undefined) {
      const runs = join(root, "target", "verify-runs", sha);
      mkdirSync(join(runs, "t1"), { recursive: true });
      writeFileSync(join(runs, "t1", "log"), "r");
      for (const p of [join(runs, "t1", "log"), join(runs, "t1"), runs]) at(p, NOW - b.runsAge * HOUR);
    }
    if (b.lock) mkdirSync(`${dir}.lock`);
  }
  return root;
}
const has = (root, sha) => existsSync(join(root, "target", "verify", sha));
const hasRuns = (root, sha) => existsSync(join(root, "target", "verify-runs", sha));

test("keeps the newest N, deletes older builds with their runs folders, reports the space", () => {
  const root = fake({ a: { age: 50, runsAge: 40 }, b: { age: 40, runsAge: 30 }, c: { age: 30 }, d: { age: 20 } });
  try {
    const r = pruneBuilds(root, { keep: 2, now: NOW });
    assert.deepEqual(r.kept.sort(), ["c", "d"]);
    assert.ok(!has(root, "a") && !has(root, "b") && has(root, "c") && has(root, "d"));
    assert.ok(!hasRuns(root, "a") && !hasRuns(root, "b"));
    assert.equal(r.removed.filter((x) => x.sha === "a").length, 2);
    assert.ok(r.freed >= 2 * 1000);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("keep 0 keeps everything", () => {
  const root = fake({ a: { age: 500 }, b: { age: 400 }, c: { age: 300 } });
  try {
    const r = pruneBuilds(root, { keep: 0, now: NOW });
    assert.equal(r.removed.length, 0);
    assert.ok(has(root, "a") && has(root, "b") && has(root, "c"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a locked build, one used within 2 hours and the current commit stay; an old runs folder does not protect", () => {
  const root = fake({
    locked: { age: 90, lock: true },
    used: { age: 80, runsAge: 1 },
    cur: { age: 70 },
    stale: { age: 60, runsAge: 3 },
    n1: { age: 2 },
  });
  try {
    pruneBuilds(root, { keep: 1, now: NOW, current: "cur" });
    assert.ok(has(root, "locked") && has(root, "used") && has(root, "cur") && has(root, "n1"));
    assert.ok(hasRuns(root, "used"));
    assert.ok(!has(root, "stale") && !hasRuns(root, "stale"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a dry run removes nothing but reports the same", () => {
  const root = fake({ a: { age: 50, runsAge: 40 }, b: { age: 20 } });
  try {
    const r = pruneBuilds(root, { keep: 1, dryRun: true, now: NOW });
    assert.deepEqual(r.removed.map((x) => x.sha), ["a", "a"]);
    assert.ok(r.freed > 0);
    assert.ok(has(root, "a") && hasRuns(root, "a"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("refuses a path outside target/verify (control: a symlink-free escape through the injected remover is never reached)", () => {
  const root = fake({ a: { age: 50 }, b: { age: 20 } });
  const outside = scratchDir("w3proj-verify-outside-");
  const seen = [];
  try {
    pruneBuilds(root, { keep: 1, now: NOW, remove: (p) => seen.push(p) });
    assert.ok(seen.length > 0 && seen.every((p) => p.startsWith(join(root, "target", "verify") + sep) || p.startsWith(join(root, "target", "verify-runs") + sep)));
    // a root whose target/verify is missing: nothing happens, nothing outside is touched
    writeFileSync(join(outside, "keep.txt"), "k");
    assert.equal(pruneBuilds(outside, { keep: 1, now: NOW }).removed.length, 0);
    assert.ok(existsSync(join(outside, "keep.txt")));
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test("the guard: only what is strictly below the folder, not a sibling with the same start, not a way out through ..", () => {
  const base = join(scratchDir("w3proj-verify-inside-"), "target", "verify");
  assert.equal(inside(base, join(base, "abc")), true);
  assert.equal(inside(base, join(base, "..x")), true, "a name that merely starts with two dots is inside");
  assert.equal(inside(base, base), false);
  assert.equal(inside(base, base + "-evil"), false, "target/verify-evil is not inside target/verify");
  assert.equal(inside(base, join(base, "..", "x")), false);
  assert.equal(inside(base, join(base, "a", "..", "..", "x")), false);
});

test("a build folder named like a way out (..x) is an ordinary build and is pruned, nothing outside goes", () => {
  const root = fake({ "..x": { age: 50 }, b: { age: 20 } });
  const seen = [];
  try {
    pruneBuilds(root, { keep: 1, now: NOW, remove: (p) => seen.push(p) });
    assert.deepEqual(seen, [join(root, "target", "verify", "..x")]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
