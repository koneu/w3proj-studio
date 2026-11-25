import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addPage, branchProblem, chunks, commitPaths, deleteBranchArgs, diffTarget, discardPlan, lfsSize, logArgs, LOG_FORMAT, noFilter, notFullyMerged, PAGE, parseBranches, parseCounts, parseFilter, parseLog, parseNameStatus, renameBranchArgs, takeSide, type Change, type Commit, type Side } from "./git";

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

const commit = (n: number): Commit => ({ hash: `h${n}`, short: `h${n}`, author: "a", date: "2026-01-01", subject: `c${n}` });
const list = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => commit(from + i));

test("history paging: one more than a page tells there is a next one", () => {
  // 450 commits, pages of 200: the fetch asks for 201 each time.
  let page = addPage([], list(0, 201), PAGE);
  assert.equal(page.commits.length, 200);
  assert.equal(page.more, true);
  page = addPage(page.commits, list(200, 401), PAGE);
  assert.equal(page.commits.length, 400);
  assert.equal(page.more, true);
  page = addPage(page.commits, list(400, 450), PAGE);
  assert.equal(page.commits.length, 450);
  assert.equal(page.more, false, "the last page has no more");
  assert.equal(addPage([], list(0, 200), PAGE).more, false, "exactly a page: nothing more");
  // The history moved on between two pages: what's listed already isn't listed twice.
  const again = addPage(list(0, 200), list(199, 399), PAGE);
  assert.deepEqual(again.commits.map((c) => c.hash).slice(198, 202), ["h198", "h199", "h200", "h201"]);
  assert.equal(new Set(again.commits.map((c) => c.hash)).size, again.commits.length);
});

test("history search: what the box means, and the log arguments", () => {
  assert.deepEqual(parseFilter("  fix water "), { message: "fix water", author: "", path: "" });
  assert.deepEqual(parseFilter("author: Ann"), { message: "", author: "Ann", path: "" });
  assert.deepEqual(parseFilter("PATH:map/war3map.w3e"), { message: "", author: "", path: "map/war3map.w3e" });
  assert.equal(noFilter(parseFilter("  ")), true);
  assert.deepEqual(logArgs(parseFilter(""), 0, 200), ["log", "--skip=0", "--max-count=201", `--format=${LOG_FORMAT}`, "--date=short", "--", "."]);
  const a = logArgs(parseFilter("--output=x"), 200, 200);
  assert.ok(a.includes("--grep=--output=x"), "text starting with - is an option's value");
  assert.ok(a.includes("--skip=200") && a.includes("--fixed-strings"));
  assert.deepEqual(logArgs(parseFilter("path:-rf"), 0, 5).slice(-2), ["--", "-rf"], "a path comes after --");
  assert.ok(logArgs(parseFilter("author:x"), 0, 5).includes("--author=x"));
});

test("branch commands: names are checked and go after --", () => {
  assert.deepEqual(deleteBranchArgs("feature/a", false), ["branch", "-d", "--", "feature/a"]);
  assert.deepEqual(deleteBranchArgs("feature/a", true), ["branch", "-D", "--", "feature/a"]);
  assert.deepEqual(renameBranchArgs("old", "new"), ["branch", "-m", "--", "old", "new"]);
  for (const bad of ["--delete", "-D", "a; rm -rf", "a b", "", "a..b", "x.lock", "/a", "a~1", "a:b"]) {
    assert.throws(() => deleteBranchArgs(bad, true), `delete ${JSON.stringify(bad)}`);
    assert.throws(() => renameBranchArgs("old", bad), `rename to ${JSON.stringify(bad)}`);
    assert.throws(() => renameBranchArgs(bad, "new"), `rename from ${JSON.stringify(bad)}`);
  }
  // Shell characters that git allows are data: there's no shell.
  assert.deepEqual(renameBranchArgs("a", "x;rm"), ["branch", "-m", "--", "a", "x;rm"]);
  assert.equal(notFullyMerged(new Error("error: the branch 'x' is not fully merged.")), true);
  assert.equal(notFullyMerged(new Error("error: branch 'x' not found")), false);
});

test("the branch rules agree with git check-ref-format", { skip: !hasGit }, () => {
  const names = ["ok", "a/b", "a b", "-x", "a..b", "a.lock", "a/.b", "a@{b", "a\\b", "a^", "a?", "a*", "a[", "x/", "/x", "a//b", "a.", "ü", "a;b", "$(x)"];
  // "@" alone passes check-ref-format --branch (it means HEAD there) but git branch refuses it.
  assert.notEqual(branchProblem("@"), null);
  for (const n of names) {
    const git = spawnSync("git", ["check-ref-format", "--branch", n], { encoding: "utf8" }).status === 0;
    // A name starting with - is read by git as an option here, so it can't say; the rule refuses it.
    if (n.startsWith("-")) { assert.notEqual(branchProblem(n), null, n); continue; }
    assert.equal(branchProblem(n) === null, git, `${JSON.stringify(n)}: git ${git}`);
  }
});

test("rename and delete run as git does, even for odd names", { skip: !hasGit }, () => {
  const dir = mkdtempSync(join(tmpdir(), "w3-branches-"));
  const sh = (args: string[]) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir, encoding: "utf8" });
  try {
    sh(["init", "-q", "-b", "main"]);
    sh(["commit", "-q", "--allow-empty", "-m", "one"]);
    sh(["branch", "x"]);
    assert.equal(sh(renameBranchArgs("x", "x;rm")).status, 0);
    assert.match(sh(["branch", "--list"]).stdout, /x;rm/);
    assert.equal(sh(deleteBranchArgs("x;rm", false)).status, 0);
    // Unmerged: -d refuses (the message that asks for a question), -D deletes.
    sh(["switch", "-q", "-c", "work"]);
    sh(["commit", "-q", "--allow-empty", "-m", "two"]);
    sh(["switch", "-q", "main"]);
    const refused = sh(deleteBranchArgs("work", false));
    assert.notEqual(refused.status, 0);
    assert.equal(notFullyMerged(new Error(refused.stderr)), true);
    assert.equal(sh(deleteBranchArgs("work", true)).status, 0);
    assert.equal(sh(["branch", "--list"]).stdout.trim(), "* main");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
