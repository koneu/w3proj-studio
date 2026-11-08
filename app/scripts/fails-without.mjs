// Proves a test can fail: runs it on the code as it is (it must pass), then with the named source files put
// back to how they are on a base branch (it must fail), then puts them back. This is the "fails without the
// fix" evidence a fix needs (TESTING.md), without copying old code into scratch files or writing stubs.
//
//   node scripts/fails-without.mjs [--base dev] [--run "<command>"] <test file> <source file>...
//
//   <test file>    a TypeScript test (src/…/x.test.ts, run with `npm test -- <file>`), or anything when --run is given
//   <source file>  the files the fix changed; each is taken from the base as it is there (removed if the base
//                  doesn't have it) for the second run. Never the test file itself: the test must stay the new one.
//   --base REF     what "without the fix" is (default: dev)
//   --run CMD      the command to run instead of `npm test -- <test file>`, e.g. a Rust test:
//                  --run "cargo test -p w3proj-studio --lib an_unreadable_subfolder"
//   --keep-rust-tests  for Rust files whose tests are in the file itself (`#[cfg(test)] mod tests` at its end):
//                  the code before that comes from the base, the tests stay the new ones
//
// Exit 0 only for pass-then-fail; 3 when the test without the fix merely doesn't build (weak evidence). The files are put back on every way out (also Ctrl+C); a file that differed
// from the base before the run is exactly as it was afterwards. Paths are relative to where it's run.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const app = fileURLToPath(new URL("..", import.meta.url));

const argv = process.argv.slice(2);
let base = "dev", run = null, keepRustTests = false;
const files = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--base") base = argv[++i];
  else if (argv[i] === "--run") run = argv[++i];
  else if (argv[i] === "--keep-rust-tests") keepRustTests = true;
  else files.push(argv[i]);
}
const [test, ...sources] = files;
if (!test || !sources.length) {
  console.error("usage: node scripts/fails-without.mjs [--base dev] [--run \"<command>\"] <test file> <source file>...");
  process.exit(2);
}
const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).stdout.trim();
if (!top) { console.error("not inside a git checkout"); process.exit(2); }
const testPath = resolve(test);
const paths = sources.map((s) => resolve(s));
if (paths.includes(testPath)) { console.error("the test file can't be one of the source files: the test must stay the new one"); process.exit(2); }

const command = run ?? `npm test -- "${relative(app, testPath)}"`;
const cwd = run ? process.cwd() : app;
/** Runs the test; its output is shown and kept, to tell an assertion failing from code that doesn't build. */
const runTest = (label) => {
  console.log(`\n--- ${label}: ${command}`);
  const r = spawnSync(command, { cwd, shell: true, encoding: "utf8", maxBuffer: 1 << 28 });
  process.stdout.write(r.stdout ?? "");
  process.stderr.write(r.stderr ?? "");
  const text = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  return { ok: r.status === 0, unbuilt: /Build failed with|No matching export|error\[E\d+\]|could not compile/.test(text) };
};

// What each file is now (null: not there), and what it is on the base (null: not there).
const now = new Map(paths.map((p) => [p, existsSync(p) ? readFileSync(p) : null]));
const atBase = new Map();
for (const p of paths) {
  const rel = relative(top, p).replaceAll("\\", "/");
  const r = spawnSync("git", ["show", `${base}:${rel}`], { cwd: top, maxBuffer: 1 << 28 });
  atBase.set(p, r.status === 0 ? r.stdout : null);
}
// The base's code with the file's own tests as they are now.
if (keepRustTests) {
  const TESTS = /^#\[cfg\(test\)\]\s*\nmod tests\b/m;
  for (const p of paths.filter((p) => p.endsWith(".rs"))) {
    const old = atBase.get(p)?.toString("utf8"), cur = now.get(p)?.toString("utf8");
    const [o, c] = [old?.search(TESTS) ?? -1, cur?.search(TESTS) ?? -1];
    if (o < 0 || c < 0) { console.error(`${relative(process.cwd(), p)}: no "#[cfg(test)] mod tests" ${c < 0 ? "now" : `on ${base}`} to keep the tests of`); process.exit(2); }
    atBase.set(p, Buffer.from(old.slice(0, o) + cur.slice(c), "utf8"));
  }
}
const same = paths.filter((p) => (now.get(p) === null && atBase.get(p) === null) || (now.get(p) !== null && atBase.get(p) !== null && now.get(p).equals(atBase.get(p))));
if (same.length === paths.length) {
  console.error(`none of the source files differs from ${base}: there's nothing to take away`);
  process.exit(2);
}
for (const p of same) console.warn(`note: ${relative(process.cwd(), p)} is the same on ${base}`);

let swapped = false;
const restore = () => {
  if (!swapped) return;
  for (const [p, bytes] of now) {
    if (bytes === null) rmSync(p, { force: true });
    else writeFileSync(p, bytes);
  }
  swapped = false;
};
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { restore(); process.exit(130); });
process.on("exit", restore);

const withFix = runTest("with the fix");
let withoutFix;
try {
  swapped = true;
  for (const [p, bytes] of atBase) {
    if (bytes === null) rmSync(p, { force: true });
    else writeFileSync(p, bytes);
  }
  withoutFix = runTest(`without the fix (${paths.length - same.length} file(s) as on ${base})`);
} finally {
  restore();
}

console.log(`\nwith the fix: ${withFix.ok ? "passes" : "FAILS"}; without it: ${withoutFix.ok ? "PASSES" : withoutFix.unbuilt ? "doesn't build" : "fails"}`);
if (withFix.ok && !withoutFix.ok && !withoutFix.unbuilt) {
  console.log("ok: the test fails without the fix and passes with it");
  process.exit(0);
}
if (!withFix.ok) console.log("not shown: the test doesn't pass with the fix");
else if (withoutFix.unbuilt) {
  // A test that only can't be built against the old code proves nothing about the behaviour: name the new
  // function in the test only where it must be, or give the old code the new name as a stub that keeps the old behaviour.
  console.log("weak: without the fix the test doesn't even build (a new export or signature), so no assertion was shown to catch the bug");
  process.exit(3);
} else console.log("not shown: the test passes without the fix too, so it doesn't prove the fix");
process.exit(1);
