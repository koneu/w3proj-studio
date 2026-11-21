import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { checkFresh, newestSource, staleAllowed } from "../../tests/binfresh.mjs";
import { scratchDir } from "../../tests/scratch.mjs";

// [Refactored] Share a single git repository across the test file instead of running `git init` + `git add` 9 separate times.
let shared;
test.before(() => {
  const root = scratchDir("binfresh-");
  const git = (...a) => execFileSync("git", a, { cwd: root, stdio: "ignore" });
  git("init", "-q");
  mkdirSync(join(root, "crates", "x"), { recursive: true });
  writeFileSync(join(root, "crates", "x", "lib.rs"), "");
  writeFileSync(join(root, "Cargo.lock"), "");
  mkdirSync(join(root, "app", "src-tauri"), { recursive: true });
  writeFileSync(join(root, "app", "src-tauri", "main.rs"), "");
  mkdirSync(join(root, "app", "src"), { recursive: true });
  const page = ["app/src/main.ts", "app/index.html", "app/vite.config.ts", "app/tsconfig.json", "app/package.json", "app/package-lock.json"];
  for (const file of page) writeFileSync(join(root, file), "");
  git("add", ".");
  const bin = join(root, "w3proj");
  writeFileSync(bin, "");
  const resetTimes = () => {
    utimesSync(join(root, "crates/x/lib.rs"), 1000, 1000);
    utimesSync(join(root, "Cargo.lock"), 900, 900);
    utimesSync(join(root, "app/src-tauri/main.rs"), 2000, 2000);
    for (const file of page) utimesSync(join(root, file), 1000, 1000);
  };
  resetTimes();
  shared = { root, bin, page, git, resetTimes, at: (s) => utimesSync(bin, s, s) };
});
test.after(() => {
  if (shared) rmSync(shared.root, { recursive: true, force: true });
});

test("a stale binary is refused, naming the binary and the newer file", () => {
  shared.resetTimes();
  shared.at(500);
  assert.throws(() => checkFresh(shared.bin, { root: shared.root }), (e) => e.message.includes(shared.bin) && e.message.includes("crates/x/lib.rs"));
});

test("a fresh binary is accepted; the app's sources count only for the app", () => {
  shared.resetTimes();
  shared.at(1500);
  assert.equal(checkFresh(shared.bin, { root: shared.root }), shared.bin);
  assert.throws(() => checkFresh(shared.bin, { root: shared.root, kind: "app" }), /app\/src-tauri\/main\.rs/);
  assert.equal(newestSource(shared.root, "cli").file, "crates/x/lib.rs");
});

// The app embeds the web page app/dist, built from these: an app built before an edit in one of them is stale, the CLI
// isn't (batch 17's stale-binary false result was this class).
test("the web page's sources make the app stale, not the CLI", () => {
  shared.resetTimes();
  shared.at(2500);
  for (const file of shared.page) {
    utimesSync(join(shared.root, file), 3000, 3000);
    // Control: newer than every Rust source, so only the page's file can make it stale.
    assert.equal(checkFresh(shared.bin, { root: shared.root }), shared.bin, `${file}: the CLI`);
    assert.throws(() => checkFresh(shared.bin, { root: shared.root, kind: "app" }), (e) => e.message.includes(file), `${file}: the app`);
    utimesSync(join(shared.root, file), 1000, 1000);
  }
  // An untracked file there doesn't count (git lists only tracked ones).
  const untracked = "app/src/untracked.ts";
  writeFileSync(join(shared.root, untracked), "");
  utimesSync(join(shared.root, untracked), 3000, 3000);
  assert.equal(checkFresh(shared.bin, { root: shared.root, kind: "app" }), shared.bin, "untracked file ignored");
});

test("the override lets a stale binary through; a missing one is still refused", () => {
  shared.resetTimes();
  shared.at(500);
  assert.equal(checkFresh(shared.bin, { root: shared.root, allowStale: true }), shared.bin);
  assert.equal(staleAllowed({ W3_ALLOW_STALE: "1" }, []), true);
  assert.equal(staleAllowed({}, ["node", "x", "--allow-stale"]), true);
  assert.equal(staleAllowed({}, ["node", "x"]), false);
  assert.throws(() => checkFresh(join(shared.root, "nope"), { root: shared.root, allowStale: true }), /no binary/);
});
