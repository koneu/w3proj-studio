import assert from "node:assert/strict";
import { test } from "node:test";
import { branchProblem, chunks, commitPaths, diffTarget, discardPlan, lfsSize, parseBranches, parseCounts, parseLog, parseNameStatus, type Change } from "./git";

test("LFS pointers give the file's real size", () => {
  const pointer = "version https://git-lfs.github.com/spec/v1\noid sha256:4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393\nsize 271253\n";
  assert.equal(lfsSize(pointer), 271253);
  assert.equal(lfsSize("size 12\n"), null);
  assert.equal(lfsSize(null), null);
});

test("log lines", () => {
  const out = "abc123\u001fabc\u001fKonstantin\u001f2026-11-05\u001fFix: a | b\ndef\u001fde\u001fX\u001f2026-11-04\u001f\n";
  assert.deepEqual(parseLog(out), [
    { hash: "abc123", short: "abc", author: "Konstantin", date: "2026-11-05", subject: "Fix: a | b" },
    { hash: "def", short: "de", author: "X", date: "2026-11-04", subject: "" },
  ]);
  assert.deepEqual(parseLog(""), []);
});

test("files of a commit, with renames", () => {
  assert.deepEqual(parseNameStatus("M\0map/a.json\0A\0map/b c.txt\0R100\0map/old.blp\0map/new.blp\0D\0x\0"), [
    { status: "M", path: "map/a.json" }, { status: "A", path: "map/b c.txt" },
    { status: "R", from: "map/old.blp", path: "map/new.blp" }, { status: "D", path: "x" },
  ]);
  assert.deepEqual(parseNameStatus("\nM\0a\0"), [{ status: "M", path: "a" }]);
});

test("branches and how far they are from their upstream", () => {
  assert.deepEqual(parseBranches("dev\u001f*\u001forigin/dev\nmaster\u001f \u001f\n"), [
    { name: "dev", current: true, upstream: "origin/dev" }, { name: "master", current: false, upstream: "" },
  ]);
  assert.deepEqual(parseCounts("2\t5\n"), { behind: 2, ahead: 5 });
  assert.equal(parseCounts("fatal: no upstream"), null);
});

test("branch names", () => {
  for (const ok of ["dev", "feature/terrain", "v1.2", "ÄÖ"]) assert.equal(branchProblem(ok), null, ok);
  for (const bad of ["", "-x", "a b", "a..b", "a~1", "x^", "a:b", "a?", "a*", "[a", "a\\b", "/a", "a/", "a//b", "a.", "a.lock", "a@{b"]) assert.ok(branchProblem(bad), bad);
});

test("a selection's paths: renames count twice, none repeats", () => {
  assert.deepEqual(commitPaths([{ path: "a", status: "M" }, { path: "new", status: "R", from: "old" }, { path: "a", status: "M" }]), ["a", "old", "new"]);
});

test("throwing changes away, per kind", () => {
  const c: Change[] = [
    { path: "m", status: "M" }, { path: "d", status: "D" }, { path: "new", status: "U" }, { path: "staged", status: "A" },
    { path: "moved", status: "R", from: "was" }, { path: "conflict", status: "C" },
  ];
  assert.deepEqual(discardPlan(c), { restore: ["m", "d", "was"], unstage: ["staged", "moved"], remove: ["new", "staged", "moved"] });
});

test("long path lists are split, nothing lost", () => {
  const paths = Array.from({ length: 1000 }, (_, i) => `map/war3mapImported/file-${i}.blp`);
  const parts = chunks(paths, 2000);
  assert.ok(parts.length > 1);
  assert.ok(parts.every((p) => p.join("   ").length <= 2000));
  assert.deepEqual(parts.flat(), paths);
  assert.deepEqual(chunks([]), []);
  assert.deepEqual(chunks(["x".repeat(50)], 10), [["x".repeat(50)]]);
});

test("diff tabs: a working copy file or a file of a commit", () => {
  assert.deepEqual(diffTarget("map/a.json"), { rev: null, path: "map/a.json" });
  assert.deepEqual(diffTarget("@abc1234:map/a.json"), { rev: "abc1234", path: "map/a.json" });
  assert.deepEqual(diffTarget("@not-hash:map/a.json"), { rev: null, path: "@not-hash:map/a.json" });
});
