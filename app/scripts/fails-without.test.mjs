// fails-without.mjs --keep-rust-tests, run as a program in a git checkout of its own: a Rust file's test modules stay
// the new ones whatever their name and cfg (`mod fs_tests`, `#[cfg(all(test, unix))]`, in the middle of the file),
// the rest comes from the base. The "test" it runs records what the file held, so the second run's file is seen.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// npm test, the gate and the coverage run all start the runner in app/.
const script = join(process.cwd(), "scripts", "fails-without.mjs");

/** A checkout whose `dev` has `base` as src.rs and whose work tree has `now`; runs fails-without on it with a check
 *  that passes while src.rs has FIXED. Gives the exit code and, per run of the check, what src.rs held. */
function tryIt(base, now) {
  const dir = mkdtempSync(join(tmpdir(), "fails-without-"));
  try {
    const git = (...a) => {
      const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a], { cwd: dir, encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
    };
    git("init", "-q", "-b", "dev");
    writeFileSync(join(dir, "src.rs"), base);
    git("add", "src.rs");
    git("commit", "-q", "-m", "base");
    writeFileSync(join(dir, "src.rs"), now);
    writeFileSync(join(dir, "check.mjs"), [
      `import { appendFileSync, readFileSync } from "node:fs";`,
      `const s = readFileSync("src.rs", "utf8");`,
      `appendFileSync("seen.txt", JSON.stringify(s) + "\\n");`,
      `process.exit(s.includes("FIXED") ? 0 : 1);`,
    ].join("\n"));
    const r = spawnSync(process.execPath, [script, "--base", "dev", "--keep-rust-tests", "--run", `"${process.execPath}" check.mjs`, "check.mjs", "src.rs"], { cwd: dir, encoding: "utf8" });
    let seen = [];
    try { seen = readFileSync(join(dir, "seen.txt"), "utf8").trim().split("\n").map((l) => JSON.parse(l)); } catch { /* the check never ran */ }
    return { status: r.status, out: `${r.stdout}${r.stderr}`, seen, after: readFileSync(join(dir, "src.rs"), "utf8") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

test("a module under cfg(not(test)) or cfg(unix) is code, taken from the base (the control)", () => {
  for (const cfg of ["not(test)", "unix", `any(test, feature = "x")`]) {
    const mod = (body) => `#[cfg(${cfg})]\nmod real {\n    fn work() { ${body} }\n}\n`;
    const tests = `#[cfg(test)]\nmod tests {\n    fn t() { NEW_TEST }\n}\n`;
    const r = tryIt(mod("1") + tests, mod("2 /* FIXED */") + tests);
    assert.equal(r.status, 0, `${cfg}: ${r.out}`);
    assert.equal(r.seen[1], mod("1") + tests, cfg);
  }
});

test("a file without a test module now is refused, and nothing is run", () => {
  const r = tryIt(`fn work() {}\n`, `fn work() {} // FIXED\n#[cfg(not(test))]\nmod tests {}\n`);
  assert.equal(r.status, 2, r.out);
  assert.match(r.out, /has no test module/);
  assert.equal(r.seen.length, 0);
});
