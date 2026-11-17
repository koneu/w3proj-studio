import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { checkFresh, newestSource, staleAllowed } from "../../tests/binfresh.mjs";
import { scratchDir } from "../../tests/scratch.mjs";

function repo() {
  const root = scratchDir("binfresh-");
  const git = (...a) => execFileSync("git", a, { cwd: root, stdio: "ignore" });
  git("init", "-q");
  mkdirSync(join(root, "crates", "x"), { recursive: true });
  writeFileSync(join(root, "crates", "x", "lib.rs"), "");
  writeFileSync(join(root, "Cargo.lock"), "");
  mkdirSync(join(root, "app", "src-tauri"), { recursive: true });
  writeFileSync(join(root, "app", "src-tauri", "main.rs"), "");
  git("add", ".");
  const at = (f, s) => utimesSync(join(root, f), s, s);
  at("crates/x/lib.rs", 1000);
  at("Cargo.lock", 900);
  at("app/src-tauri/main.rs", 2000);
  const bin = join(root, "w3proj");
  writeFileSync(bin, "");
  return { root, bin, at: (s) => utimesSync(bin, s, s) };
}

test("a stale binary is refused, naming the binary and the newer file", () => {
  const r = repo();
  try {
    r.at(500);
    assert.throws(() => checkFresh(r.bin, { root: r.root }), (e) => e.message.includes(r.bin) && e.message.includes("crates/x/lib.rs"));
  } finally { rmSync(r.root, { recursive: true, force: true }); }
});

test("a fresh binary is accepted; the app's sources count only for the app", () => {
  const r = repo();
  try {
    r.at(1500);
    assert.equal(checkFresh(r.bin, { root: r.root }), r.bin);
    assert.throws(() => checkFresh(r.bin, { root: r.root, kind: "app" }), /app\/src-tauri\/main\.rs/);
    assert.equal(newestSource(r.root, "cli").file, "crates/x/lib.rs");
  } finally { rmSync(r.root, { recursive: true, force: true }); }
});

test("the override lets a stale binary through; a missing one is still refused", () => {
  const r = repo();
  try {
    r.at(500);
    assert.equal(checkFresh(r.bin, { root: r.root, allowStale: true }), r.bin);
    assert.equal(staleAllowed({ W3_ALLOW_STALE: "1" }, []), true);
    assert.equal(staleAllowed({}, ["node", "x", "--allow-stale"]), true);
    assert.equal(staleAllowed({}, ["node", "x"]), false);
    assert.throws(() => checkFresh(join(r.root, "nope"), { root: r.root, allowStale: true }), /no binary/);
  } finally { rmSync(r.root, { recursive: true, force: true }); }
});
