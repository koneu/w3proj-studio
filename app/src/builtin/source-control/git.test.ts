import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { branchProblem, chunks, commitPaths, diffTarget, discardPlan, lfsSize, parseBranches, parseCounts, parseLog, parseNameStatus, takeSide, type Change, type Side } from "./git";

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
  assert.deepEqual(parseNameStatus("M\0 a.txt\0"), [{ status: "M", path: " a.txt" }]);
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
  for (const bad of ["", "-x", "a b", "a..b", "a~1", "x^", "a:b", "a?", "a*", "[a", "a\\b", "/a", "a/", "a//b", "a.", "a.lock", "a@{b", "@", "a/.b", "a/b.lock", "a/b.lock/c", ".x"]) assert.ok(branchProblem(bad), bad);
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

// takeSide against real repositories: a conflict is made by merging two branches.
const hasGit = spawnSync("git", ["--version"]).status === 0;
function conflict(files: Record<string, [Buffer | null, Buffer | null, Buffer | null]>) {
  const dir = mkdtempSync(join(tmpdir(), "w3-takeside-"));
  const sh = (...a: string[]) => { const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.autocrlf=false", ...a], { cwd: dir, encoding: "utf8" }); return r; };
  const put = (i: number) => { for (const [f, v] of Object.entries(files)) { if (v[i]) writeFileSync(join(dir, f), v[i]!); else rmSync(join(dir, f), { force: true }); } sh("add", "-A"); sh("commit", "-m", `c${i}`); };
  sh("init", "-q", "-b", "main"); put(0);
  sh("switch", "-q", "-c", "other"); put(2);
  sh("switch", "-q", "main"); put(1);
  const m = sh("merge", "other");
  assert.notEqual(m.status, 0, "the merge should conflict");
  const run = async (...a: string[]) => { const r = sh(...a); if (r.status !== 0) throw new Error(r.stderr); return r.stdout; };
  return { dir, run, status: () => sh("status", "--porcelain").stdout };
}
const B = (s: string) => Buffer.from(s);
const cases: [string, string, [Buffer | null, Buffer | null, Buffer | null], Record<Side, Buffer | null>][] = [
  ["f-mod.bin", "modify/modify", [B("a\nb\nc\n"), B("a\nOURS\nc\n"), B("a\nTHEIRS\nc\n")], { ours: B("a\nOURS\nc\n"), theirs: B("a\nTHEIRS\nc\n") }],
  ["f-del-ours.bin", "delete/modify (ours deleted)", [B("a\n"), null, B("changed\n")], { ours: null, theirs: B("changed\n") }],
  ["f-del-theirs.bin", "modify/delete (theirs deleted)", [B("a\n"), B("changed\n"), null], { ours: B("changed\n"), theirs: null }],
  ["f-bin.bin", "binary", [Buffer.from([0, 1, 2, 3]), Buffer.from([0, 9, 9, 0xff]), Buffer.from([0, 7, 7, 0xfe])], { ours: Buffer.from([0, 9, 9, 0xff]), theirs: Buffer.from([0, 7, 7, 0xfe]) }],
];

// [Refactored] Create 1 multi-file conflict repo per side (2 git repos total instead of 8), cutting 72 git spawns to 24.
for (const side of ["ours", "theirs"] as const) {
  test(`take ${side}: modify/modify, delete/modify, modify/delete, and binary conflicts`, { skip: !hasGit }, async () => {
    const allFiles = Object.fromEntries(cases.map(([file, , triple]) => [file, triple]));
    const { dir, run, status } = conflict(allFiles);
    try {
      for (const [file, name, , want] of cases) {
        assert.match(status(), new RegExp(`^(UU|DU|UD) ${file.replace(".", "\\.")}`, "m"), name);
        await takeSide(run, side, file);
        const w = want[side];
        assert.equal(existsSync(join(dir, file)), w !== null, `${name}: exists`);
        if (w) assert.deepEqual(readFileSync(join(dir, file)), w, `${name}: content`);
        await assert.rejects(takeSide(run, side, file), /no conflict/, `${name}: already resolved`);
      }
      assert.doesNotMatch(status(), /^(UU|DU|UD|AA|DD|AU|UA) /m, "all conflicts cleared");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
