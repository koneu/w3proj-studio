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
