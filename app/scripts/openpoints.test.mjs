// scripts/openpoints-burndown.mjs and scripts/openpoints-close.mjs: tag parsing, the three lines, the edit-matching rule
// between two snapshots, and the close script on fixture files in a temp folder (never the real openpoints).

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { countsOf, diffSnapshots, idOf, idsAt, lineOf, pageOf, parsePoints, similarity, tagsOf } from "../../scripts/openpoints-burndown.mjs";
import { applyVerdicts, parseVerdicts } from "../../scripts/openpoints-close.mjs";

// The tests run from app/ (bundled elsewhere, so import.meta.url is no help).
const repo = join(process.cwd(), "..");
const burndown = join(repo, "scripts", "openpoints-burndown.mjs");
const closer = join(repo, "scripts", "openpoints-close.mjs");

test("tags are the bracketed words at the start of the text", () => {
  assert.deepEqual(tagsOf("[we] [Game] check the lake"), ["we", "game"]);
  assert.deepEqual(tagsOf("check [game] later"), []);
  assert.deepEqual(tagsOf("[ ] nothing"), []);
  const [p] = parsePoints("## S\n- [ ] [eye][extra] a thing\n", "bugs.md");
  assert.deepEqual(p.tags, ["eye", "extra"]);
});

test("the three lines and the primary/extra split", () => {
  const points = [
    ...parsePoints("- [ ] a bug\n- [ ] [extra] a feature\n- [x] done one\n", "bugs.md"),
    ...parsePoints("- [ ] prove it\n- [ ] [we] prove it too\n- [ ] [game] play it\n- [ ] [eye] [windows] run it\n", "test.md"),
    ...parsePoints("- [ ] decide\n", "user.md"),
    ...parsePoints("- [ ] on hold\n", "onhold.md"),
  ];
  assert.equal(lineOf(points[2]), null);
  const c = countsOf(points);
  assert.deepEqual(c.lines, { build: 2, agents: 2, user: 3 });
  assert.equal(c.extra, 1);
  assert.equal(c.primary, 6);
});

const item = (file, text) => ({ id: idOf(file, text), file, text });

test("edit matching: similar text with a new id is an edit, otherwise opened and closed", () => {
  const base = "The terrain view draws the water wrong at the map edge when the tileset is Lordaeron summer and the camera is low. ".repeat(2);
  const old = item("bugs.md", base + "Seen in map A.");
  const edited = item("bugs.md", "Terrain view: " + base + "Seen in map A and B.");
  const other = item("features.md", "Something quite different about unit tooltips that nobody has said before");
  const unrelated = item("bugs.md", "Brand new problem with the object editor's field list ordering");
  const same = item("bugs.md", "stays");
  const d = diffSnapshots([old, same, other], [edited, same, unrelated]);
  assert.deepEqual(d.edited, [[old.id, edited.id]]);
  assert.deepEqual(d.opened, [unrelated.id]);
  assert.deepEqual(d.closed, [other.id]);
  assert.ok(similarity("abcdefghij", "abcdefghix") >= 0.9);
  assert.equal(similarity("abc", "abcdefghij"), 0);
  // A move to another file is an edit too, a retagged item as well.
  const t = "check that the lake keeps its colour after saving and loading the map again in the editor";
  const moved = diffSnapshots([item("test.md", "[we] " + t)], [item("user.md", "[game] " + t)]);
  assert.equal(moved.edited.length, 1);
  assert.equal(moved.opened.length + moved.closed.length, 0);
  // Each item is in one pair only.
  const two = diffSnapshots([item("bugs.md", t + " one")], [item("bugs.md", t + " two"), item("bugs.md", t + " three")]);
  assert.equal(two.edited.length, 1);
  assert.equal(two.opened.length, 1);
});

test("idsAt replays the deltas", () => {
  const f = { base: { ids: "a b c" }, deltas: [{ opened: ["d"], closed: ["a"], edited: [] }, { opened: [], closed: ["d"], edited: [["b", "b2"]] }] };
  assert.deepEqual([...idsAt(f, 0)].sort(), ["a", "b", "c"]);
  assert.deepEqual([...idsAt(f, 1)].sort(), ["b", "c", "d"]);
  assert.deepEqual([...idsAt(f, 2)].sort(), ["b2", "c"]);
});

test("a not-done note doesn't change an id", () => {
  assert.equal(idOf("test.md", "short item"), idOf("test.md", "short item (not done: no time, 2026-11-13)"));
});

test("the page builds with and without the new fields", () => {
  const pts = parsePoints("- [ ] one\n", "bugs.md");
  const old = { entries: [{ time: "2026-11-12T10:00:00Z", byFile: { "bugs.md": 1 }, active: 1, total: 1 }] };
  assert.match(pageOf(old, pts), /<svg id="chart"/);
  const c = countsOf(pts);
  assert.match(pageOf({ entries: [...old.entries, { time: "2026-11-13T10:00:00Z", ...c, opened: 1, closed: 0, edited: 0 }] }, pts), /"opened":1/);
});

test("burndown run writes ids and flows; second run sees a close, an open and an edit", () => {
  const dir = mkdtempSync(join(tmpdir(), "op-burn-"));
  try {
    const long = "the lake keeps its colour after saving and loading the map again in the editor, ok";
    writeFileSync(join(dir, "bugs.md"), `## A\n- [ ] first bug\n- [ ] ${long}\n- [ ] gone bug\n`);
    const run = (...a) => spawnSync(process.execPath, [burndown, "--dir", dir, ...a], { encoding: "utf8" });
    assert.equal(run().status, 0);
    writeFileSync(join(dir, "bugs.md"), `## A\n- [ ] first bug\n- [ ] Lake: ${long}\n- [ ] new bug\n`);
    const r = run();
    assert.equal(r.status, 0, r.stderr);
    const h = JSON.parse(readFileSync(join(dir, "burndown.json"), "utf8"));
    assert.equal(h.entries[0].opened, undefined);
    assert.deepEqual([h.entries[1].opened, h.entries[1].closed, h.entries[1].edited], [1, 1, 1]);
    const ids = JSON.parse(readFileSync(join(dir, "burndown-ids.json"), "utf8"));
    assert.equal(idsAt(ids, 1).size, 3);
    assert.ok(existsSync(join(dir, "burndown.html")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const FIXTURE = {
  "bugs.md": "# bugs\n\n## General\n- [ ] bug one\n  second line of one\n\n  third after blank\n- [ ] bug two\n\n## Other\n- [ ] bug three\n",
  "test.md": "# test\n\n## S\n- [ ] [we] prove alpha\n  more alpha\n- [ ] prove beta (not done: no map, 2026-11-10)\n- [ ] [game] prove gamma (not done: no map, 2026-11-10)\n- [ ] prove delta\n",
  "user.md": "# user\n\n## Decisions\n- [ ] decide x\n",
  "onhold.md": "# onhold\n\n- [ ] parked\n",
};
const maps = (o) => new Map(Object.entries(o));
const id = (file, prefix) => parsePoints(FIXTURE[file], file).find((p) => p.text.startsWith(prefix)).id;

test("verdict lines parse; other lines are skipped", () => {
  const v = parseVerdicts("intro\nabcdef0123: PASS\n`abcdef0124`: FAIL — it crashed (hard)\n- abcdef0125: NOT DONE - no time\nnotanid: PASS\nabcdef0126: differs — x\n");
  assert.deepEqual(v.map((x) => [x.id, x.verdict, x.text]), [
    ["abcdef0123", "PASS", ""], ["abcdef0124", "FAIL", "it crashed (hard)"], ["abcdef0125", "NOT DONE", "no time"], ["abcdef0126", "DIFFERS", "x"],
  ]);
});

test("PASS removes the whole block and nothing else", () => {
  const r = applyVerdicts(maps(FIXTURE), [{ id: id("bugs.md", "bug one"), verdict: "PASS", text: "" }], "2026-11-13");
  assert.deepEqual(r.problems, []);
  assert.equal(r.files.get("bugs.md"), "# bugs\n\n## General\n- [ ] bug two\n\n## Other\n- [ ] bug three\n");
  assert.equal(r.files.get("test.md"), FIXTURE["test.md"]);
});

test("FAIL and DIFFERS add one line to bugs.md, section From verification", () => {
  const r = applyVerdicts(maps(FIXTURE), [
    { id: id("test.md", "[we] prove alpha"), verdict: "FAIL", text: "alpha crashes" },
    { id: id("test.md", "prove delta"), verdict: "DIFFERS", text: "delta is blue" },
  ], "2026-11-13");
  const bugs = r.files.get("bugs.md");
  assert.ok(bugs.startsWith(FIXTURE["bugs.md"].trimEnd()));
  assert.match(bugs, /\n## From verification\n\n- \[ \] alpha crashes \(verification FAIL of [0-9a-f]{10} in test\.md: "\[we\] prove alpha more alpha", 2026-11-13\)\n- \[ \] delta is blue \(verification DIFFERS/);
  assert.equal(r.files.get("test.md"), FIXTURE["test.md"]);
  // A second batch lands in the same section.
  const again = applyVerdicts(r.files, [{ id: id("test.md", "prove beta"), verdict: "FAIL", text: "beta" }], "2026-11-14");
  assert.equal(again.files.get("bugs.md").match(/## From verification/g).length, 1);
});

test("NOT DONE: the first adds a note, the second moves the item", () => {
  const first = applyVerdicts(maps(FIXTURE), [{ id: id("test.md", "prove delta"), verdict: "NOT DONE", text: "no (time)" }], "2026-11-13");
  assert.match(first.files.get("test.md"), /- \[ \] prove delta \(not done: no \[time\], 2026-11-13\)\n$/);
  const second = applyVerdicts(first.files, [{ id: id("test.md", "prove delta"), verdict: "NOT DONE", text: "still no" }], "2026-11-14");
  assert.ok(!second.files.get("test.md").includes("prove delta"));
  assert.match(second.files.get("onhold.md"), /## From verification\n\n- \[ \] prove delta \(not done: no \[time\], 2026-11-13\) \(not done: still no, 2026-11-14\)/);
  // [game] goes to user.md; an item in user.md goes on to onhold.md.
  const g = applyVerdicts(maps(FIXTURE), [{ id: id("test.md", "[game] prove gamma"), verdict: "NOT DONE", text: "x" }], "2026-11-13");
  assert.match(g.files.get("user.md"), /## From verification\n\n- \[ \] \[game\] prove gamma/);
  assert.match(g.plan[0], /to user\.md/);
  const b = applyVerdicts(maps(FIXTURE), [{ id: id("test.md", "prove beta"), verdict: "NOT DONE", text: "needs the user's login" }], "2026-11-13");
  assert.match(b.files.get("user.md"), /prove beta/);
});

test("unknown, duplicate and incomplete verdicts change nothing", () => {
  const known = id("bugs.md", "bug two");
  const r = applyVerdicts(maps(FIXTURE), [
    { id: known, verdict: "PASS", text: "" },
    { id: "0000000000", verdict: "PASS", text: "" },
    { id: known, verdict: "FAIL", text: "" },
  ], "2026-11-13");
  assert.equal(r.problems.length, 3);
  assert.match(r.problems.join("\n"), /0000000000: not found/);
  assert.equal(r.files.get("bugs.md"), FIXTURE["bugs.md"]);
});

test("the script: dry run changes nothing, a real run backs up what it changes, a bad id refuses", () => {
  const dir = mkdtempSync(join(tmpdir(), "op-close-"));
  try {
    for (const [f, t] of Object.entries(FIXTURE)) writeFileSync(join(dir, f), t);
    const verdicts = join(dir, "verdicts.txt");
    writeFileSync(verdicts, `${id("bugs.md", "bug two")}: PASS\n${id("test.md", "prove delta")}: FAIL — delta wrong\n`);
    const run = (...a) => spawnSync(process.execPath, [closer, verdicts, "--dir", dir, ...a], { encoding: "utf8" });
    const dry = run("--dry-run");
    assert.equal(dry.status, 0, dry.stderr);
    assert.equal(readFileSync(join(dir, "bugs.md"), "utf8"), FIXTURE["bugs.md"]);
    assert.ok(!existsSync(join(dir, ".backup")));
    const real = run();
    assert.equal(real.status, 0, real.stderr);
    assert.ok(!readFileSync(join(dir, "bugs.md"), "utf8").includes("- [ ] bug two"));
    const [stamp] = readdirSync(join(dir, ".backup"));
    assert.equal(readFileSync(join(dir, ".backup", stamp, "bugs.md"), "utf8"), FIXTURE["bugs.md"]);
    assert.deepEqual(readdirSync(join(dir, ".backup", stamp)), ["bugs.md"]);
    writeFileSync(verdicts, "ffffffffff: PASS\n");
    const bad = run();
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /ffffffffff: not found/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
