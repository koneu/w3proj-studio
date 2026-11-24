// fails-without.mjs --keep-rust-tests, run as a program in a git checkout of its own: a Rust file's test modules stay
// the new ones whatever their name and cfg (`mod fs_tests`, `#[cfg(all(test, unix))]`, in the middle of the file),
// the rest comes from the base. The "test" it runs records what the file held, so the second run's file is seen.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scratchDir } from "../../tests/scratch.mjs";
import { repoPath } from "../src/lib/testhelpers/testutil";

// npm test, the gate and the coverage run all start the runner in app/.
const script = repoPath("app", "scripts", "fails-without.mjs");

// [Refactored] Initialize one shared git checkout for the file instead of running `git init` 6 separate times.
let repoDir;
test.before(() => {
  repoDir = scratchDir("fails-without-");
  const r = spawnSync("git", ["init", "-q", "-b", "dev"], { cwd: repoDir, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  writeFileSync(join(repoDir, "check.mjs"), [
    `import { appendFileSync, readFileSync } from "node:fs";`,
    `const s = readFileSync("src.rs", "utf8");`,
    `appendFileSync("seen.txt", JSON.stringify(s) + "\\n");`,
    `process.exit(s.includes("FIXED") ? 0 : 1);`,
  ].join("\n"));
});
test.after(() => {
  if (repoDir) rmSync(repoDir, { recursive: true, force: true });
});

/** Updates `dev` in the shared checkout to have `base` as src.rs and the working tree to have `now`; runs fails-without
 *  on it with a check that passes while src.rs has FIXED. Gives the exit code and, per run of the check, what src.rs held. */
function tryIt(base, now) {
  const git = (...a) => {
    const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a], { cwd: repoDir, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  };
  rmSync(join(repoDir, "seen.txt"), { force: true });
  writeFileSync(join(repoDir, "src.rs"), base);
  git("add", "src.rs");
  git("commit", "-q", "--allow-empty", "-m", "base");
  writeFileSync(join(repoDir, "src.rs"), now);
  const r = spawnSync(process.execPath, [script, "--base", "dev", "--keep-rust-tests", "--run", `"${process.execPath}" check.mjs`, "check.mjs", "src.rs"], { cwd: repoDir, encoding: "utf8" });
  let seen = [];
  try { seen = readFileSync(join(repoDir, "seen.txt"), "utf8").trim().split("\n").map((l) => JSON.parse(l)); } catch { /* the check never ran */ }
  return { status: r.status, out: `${r.stdout}${r.stderr}`, seen, after: readFileSync(join(repoDir, "src.rs"), "utf8") };
}

test("a test module named otherwise, under cfg(all(test, unix)), in the middle of the file, stays the new one", () => {
  const code = (body) => `fn work() -> u32 {\n    ${body}\n}\n`;
  const tests = (name, cfg, body) => `#[cfg(${cfg})]\nmod ${name} {\n    // a brace in a comment: {\n    #[test]\n    fn t() { let _c = '{'; let _s = "}"; let _r = r#"}"#; ${body} }\n}\n`;
  const tail = `\nfn after() {}\n`;
  const base = code("1") + tests("fs_tests", "all(test, unix)", "OLD_TEST") + tail;
  const now = code("2 // FIXED") + tests("fs_tests", "all(test, unix)", "NEW_TEST") + tail;
  const r = tryIt(base, now);
  assert.equal(r.status, 0, r.out);
  assert.equal(r.seen.length, 2);
  assert.equal(r.seen[0], now);
  // Without the fix: the base's code, the new tests, the code after them as on the base.
  assert.equal(r.seen[1], code("1") + tests("fs_tests", "all(test, unix)", "NEW_TEST") + tail);
  assert.equal(r.after, now, "the file is put back");
});

test("cfg(test) mod tests at the end, and a test module the base hadn't yet", () => {
  const now = `fn work() {} // FIXED\n\n#[cfg(test)]\nmod tests {\n    fn t() { NEW_TEST }\n}\n`;
  const r = tryIt(`fn work() {}\n\n#[cfg(test)]\nmod tests {\n    fn t() { OLD_TEST }\n}\n`, now);
  assert.equal(r.status, 0, r.out);
  assert.equal(r.seen[1], `fn work() {}\n\n#[cfg(test)]\nmod tests {\n    fn t() { NEW_TEST }\n}\n`);
  const fresh = tryIt(`fn work() {}\n`, now);
  assert.equal(fresh.status, 0, fresh.out);
  assert.equal(fresh.seen[1], `fn work() {}\n\n#[cfg(test)]\nmod tests {\n    fn t() { NEW_TEST }\n}\n`);
});

// [Refactored] Run 1 end-to-end control for non-test `#[cfg(not(test))]` instead of 3 subprocess loops; the full
// `cfgOnlyInTests` predicate matrix (`not(test)`, `unix`, `any(test, feature = "x")`) is unit-tested in rust-test-modules.test.mjs.
test("a module under cfg(not(test)) is code, taken from the base (the control)", () => {
  const mod = (body) => `#[cfg(not(test))]\nmod real {\n    fn work() { ${body} }\n}\n`;
  const tests = `#[cfg(test)]\nmod tests {\n    fn t() { NEW_TEST }\n}\n`;
  const r = tryIt(mod("1") + tests, mod("2 /* FIXED */") + tests);
  assert.equal(r.status, 0, r.out);
  assert.equal(r.seen[1], mod("1") + tests);
});

test("a file without a test module now is refused, and nothing is run", () => {
  const r = tryIt(`fn work() {}\n`, `fn work() {} // FIXED\n#[cfg(not(test))]\nmod tests {}\n`);
  assert.equal(r.status, 2, r.out);
  assert.match(r.out, /has no test module/);
  assert.equal(r.seen.length, 0);
});

// Exit codes and refusals, with --run commands that are node one-liners (no cargo, no npm test).
function cli(args, setup = {}) {
  const dir = scratchDir("fails-without-cli-");
  try {
    const git = (...a) => {
      const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a], { cwd: dir, encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
    };
    git("init", "-q", "-b", "dev");
    writeFileSync(join(dir, "t.txt"), "test");
    writeFileSync(join(dir, "src.txt"), setup.base ?? "old");
    git("add", ".");
    git("commit", "-q", "-m", "base");
    writeFileSync(join(dir, "src.txt"), setup.now ?? "new");
    const r = spawnSync(process.execPath, [script, ...args], { cwd: dir, encoding: "utf8" });
    return { status: r.status, out: `${r.stdout}${r.stderr}`, after: readFileSync(join(dir, "src.txt"), "utf8") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const check = (expr) => ["--run", `"${process.execPath}" -e "${expr}"`];
const readsNew = `process.exit(require('fs').readFileSync('src.txt','utf8')==='new'?0:1)`;

test("exit 0 only for pass-then-fail; the file is put back", () => {
  const r = cli([...check(readsNew), "t.txt", "src.txt"]);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /fails without the fix and passes with it/);
  assert.equal(r.after, "new");
});

test("exit 1: the check passes without the fix too, or doesn't pass with it", () => {
  const always = cli([...check("process.exit(0)"), "t.txt", "src.txt"]);
  assert.equal(always.status, 1, always.out);
  assert.match(always.out, /passes without the fix too/);
  const never = cli([...check("process.exit(1)"), "t.txt", "src.txt"]);
  assert.equal(never.status, 1, never.out);
  assert.match(never.out, /doesn't pass with the fix/);
});

test("exit 3: without the fix it doesn't even build (weak evidence)", () => {
  const r = cli([...check(`if(require('fs').readFileSync('src.txt','utf8')==='new')process.exit(0);console.error('Build failed with 1 error');process.exit(1)`), "t.txt", "src.txt"]);
  assert.equal(r.status, 3, r.out);
  assert.match(r.out, /weak/);
});

test("exit 2: usage, the test among the sources, an unknown base, nothing differing, a missing value", () => {
  assert.equal(cli([]).status, 2);
  const one = cli(["t.txt"]);
  assert.equal(one.status, 2);
  assert.match(one.out, /usage/);
  const self = cli([...check("process.exit(0)"), "t.txt", "t.txt"]);
  assert.equal(self.status, 2);
  assert.match(self.out, /test file can't be one of the source files/);
  const base = cli(["--base", "nonesuch", ...check("process.exit(0)"), "t.txt", "src.txt"]);
  assert.equal(base.status, 2);
  assert.match(base.out, /nonesuch isn't a commit/);
  const same = cli([...check("process.exit(0)"), "t.txt", "src.txt"], { base: "x", now: "x" });
  assert.equal(same.status, 2);
  assert.match(same.out, /nothing to take away/);
});

test("--keep-rust-tests is refused for a file that isn't on the base", () => {
  const dir = scratchDir("fails-without-new-");
  try {
    const run = (...a) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: dir, encoding: "utf8" });
    run("init", "-q", "-b", "dev");
    writeFileSync(join(dir, "t.txt"), "t");
    run("add", ".");
    run("commit", "-q", "-m", "b");
    writeFileSync(join(dir, "n.rs"), "#[cfg(test)]\nmod tests {}\n");
    const r = spawnSync(process.execPath, [script, "--keep-rust-tests", ...check("process.exit(0)"), "t.txt", "n.rs"], { cwd: dir, encoding: "utf8" });
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /isn't on dev/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
