// we-compare-core.mjs: reading a spec (and refusing a bad one), and the field-by-field, cell and byte comparisons.
// Each "differs" case has its "matches" control next to it.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import * as core from "./we-compare-core.mjs";
import { asExpected, autoKind, compareFile, diffBytes, diffJson, diffText, diffWpm, editorPath, expandPath, expandText, formatReport, parseSpec, parseSpecFile } from "./we-compare-core.mjs";
import { layout, testerCommands } from "./verify-build.mjs";

const good = () => ({ name: "ramp", input: { map: "R.w3x" }, compare: ["war3map.wpm"] });

test("a minimal spec gets its defaults", () => {
  const s = parseSpec(good(), "/specs", {});
  assert.equal(s.input.map, resolve("/specs", "R.w3x"));
  assert.deepEqual(s.compare, [{ file: "war3map.wpm", as: "auto", expect: "match", tolerance: 0, ignore: [] }]);
  assert.equal(s.we.mode, "sd");
  assert.equal(s.we.from, "input");
  assert.equal(s.limit, 10);
});

test("${MAIN} is expanded, an unknown variable is refused", () => {
  assert.equal(expandPath("${MAIN}/x/y.w3x", "/s", { MAIN: "/main" }), "/main/x/y.w3x");
  assert.throws(() => expandPath("${NOPE}/x", "/s", { MAIN: "/main" }), /unknown \$\{NOPE\}/);
});

test("World Editor steps: a string or a pair; the ones we-compare does itself are refused", () => {
  const s = parseSpec({ ...good(), we: { steps: ["--key d", ["--click", "1,2"], "--shot-window"] } }, "/s");
  assert.deepEqual(s.we.steps, [["--key", "d"], ["--click", "1,2"], ["--shot-window"]]);
  assert.throws(() => parseSpec({ ...good(), we: { steps: ["--save x.w3x"] } }, "/s"), /done by we-compare itself/);
  assert.throws(() => parseSpec({ ...good(), we: { steps: ["key d"] } }, "/s"), /World Editor step/);
});

test("a --type text gets the checkout as the editor sees it, an eval the checkout's path; other ${…} stay", () => {
  assert.equal(editorPath("/home/u/repo", "linux"), "Z:\\home\\u\\repo");
  assert.equal(editorPath("C:\\repo", "win32"), "C:\\repo");
  const vars = { REPO: "/home/u/repo", MAIN: "/home/u/main" };
  const s = parseSpec({ ...good(),
    we: { steps: [["--type", "${REPO_WE}\\a.wav"], ["--key", "${REPO_WE}"]] },
    studio: { steps: [{ eval: "const p = \"${REPO}/a.wav\"; return `${p}${MAIN}`;" }] } }, "/s", vars);
  assert.deepEqual(s.we.steps[0], ["--type", `${editorPath("/home/u/repo")}\\a.wav`]);
  // Only --type is filled in.
  assert.deepEqual(s.we.steps[1], ["--key", "${REPO_WE}"]);
  assert.equal(s.studio.steps[0].eval, "const p = \"/home/u/repo/a.wav\"; return `${p}/home/u/main`;");
  // A backslash in a path is quoted for the string literal; an unknown name and a script's own ${p} are left.
  assert.equal(expandText("\"${REPO}\" ${p} ${NOPE}", { REPO: "C:\\r" }, true), "\"C:\\\\r\" ${p} ${NOPE}");
  assert.equal(expandText("${REPO}", { REPO: "C:\\r" }), "C:\\r");
});

test("Studio steps have one kind each", () => {
  const s = parseSpec({ ...good(), studio: { steps: [{ mcp: "rebuild_map" }, { sleep: 5 }, { setting: ["a", 1] }] } }, "/s");
  assert.equal(s.studio.steps.length, 3);
  assert.throws(() => parseSpec({ ...good(), studio: { steps: [{ mcp: "a", eval: "b" }] } }, "/s"), /exactly one/);
  assert.throws(() => parseSpec({ ...good(), studio: { steps: [{ sleep: "x" }] } }, "/s"), /milliseconds/);
  assert.throws(() => parseSpec({ ...good(), studio: { steps: [{ sleep: 1, why: 2 }] } }, "/s"), /unknown why/);
});

test("bad specs name what is wrong", () => {
  assert.throws(() => parseSpec({ ...good(), name: "a/b" }, "/s"), /"name" is needed/);
  assert.throws(() => parseSpec({ name: "x", compare: ["a"] }, "/s"), /"input" is needed/);
  assert.throws(() => parseSpec({ ...good(), compare: [] }, "/s"), /at least one file/);
  assert.throws(() => parseSpec({ ...good(), compare: ["a", "a"] }, "/s"), /twice/);
  assert.throws(() => parseSpec({ ...good(), compare: [{ file: "a", as: "xml" }] }, "/s"), /compare\[0\]\.as/);
  assert.throws(() => parseSpec({ ...good(), compare: ["dir/a"] }, "/s"), /no folders/);
  assert.throws(() => parseSpec({ ...good(), extra: 1 }, "/s"), /unknown key extra/);
  assert.throws(() => parseSpec({ ...good(), input: { map: "a", new: { name: "x", width: 1, height: 1 } } }, "/s"), /not both/);
  assert.throws(() => parseSpec({ ...good(), input: { new: { name: "x" } } }, "/s"), /name, width and height/);
});

test("a spec file may hold a list; two of one name are refused; bad JSON is named", () => {
  assert.equal(parseSpecFile(JSON.stringify([good(), { ...good(), name: "b" }]), "/s/f.json").length, 2);
  assert.throws(() => parseSpecFile(JSON.stringify([good(), good()]), "/s/f.json"), /two specs are named ramp/);
  assert.throws(() => parseSpecFile("{", "/s/f.json"), /f\.json: not JSON/);
});

test("diffJson names field and entry, counts, and a control matches", () => {
  const we = { doodads: [{ id: "A", angle: 1, scale: [1, 1, 1] }, { id: "B", angle: 2, scale: [1, 1, 1] }] };
  assert.equal(diffJson(we, structuredClone(we)).equal, true);
  const st = structuredClone(we);
  st.doodads[1].angle = 5;
  st.doodads[1].scale[2] = 3;
  const d = diffJson(we, st);
  assert.equal(d.count, 2);
  assert.deepEqual(d.entries, { doodads: { total: 2, differing: 1, indices: [1] } });
  assert.equal(d.diffs[0].text, "doodads[1].angle: WE 2, Studio 5");
  assert.equal(d.diffs[1].path, "doodads[1].scale[2]");
});

test("diffJson: lists of another length, missing fields, and the limit keeps the count", () => {
  const d = diffJson({ a: [1, 2, 3], b: 1 }, { a: [1], c: 2 }, 2);
  assert.equal(d.count, 4); // a[1], a[2], b, c
  assert.equal(d.diffs.length, 2);
  assert.match(d.diffs[0].text, /a\[1\]: WE 2, Studio \(absent\)/);
  assert.equal(diffJson({ x: NaN }, { x: NaN }).equal, true);
  assert.equal(diffJson({ x: 1 }, { x: "1" }).equal, false);
});

test("diffJson tolerance: numbers within it are equal, beyond it differ, strings never", () => {
  const we = { units: [{ id: "hfoo", z: 0 }, { id: "hbar", z: 10 }] };
  const st = { units: [{ id: "hfoo", z: 0.005 }, { id: "hbar", z: 17.5 }] };
  assert.equal(diffJson(we, st).count, 2); // control: no tolerance, both differ
  const d = diffJson(we, st, 10, 5);
  assert.equal(d.count, 1);
  assert.deepEqual(d.entries.units.indices, [1]);
  assert.equal(diffJson(we, st, 10, 5).diffs[0].path, "units[1].z");
  assert.equal(diffJson({ a: "x" }, { a: "y" }, 10, 100).equal, false);
});

test("diffJson ignore: a named path (with what is below it, [] for any index) doesn't count; entries follow", () => {
  const we = { units: [{ id: "a", z: 1, hero: { str: 0 } }, { id: "b", z: 2 }], version: 11 };
  const st = { units: [{ id: "a", z: 1 }, { id: "b", z: 3 }], version: 9 };
  assert.equal(diffJson(we, st).count, 3); // control
  const d = diffJson(we, st, 10, 0, ["version", "units[].hero"]);
  assert.equal(d.count, 1);
  assert.deepEqual(d.entries.units, { total: 2, differing: 1, indices: [1] });
  assert.equal(diffJson(we, st, 10, 0, ["units[0].hero", "version", "units[1].z"]).equal, true);
  assert.equal(diffJson(we, st, 10, 0, ["unit"]).count, 3); // a prefix of a name is not a path
  assert.equal(diffJson(we, st, 10, 0, ["units[0].z"]).count, 3); // not the differing one
});

test("a spec's tolerance and from are checked", () => {
  const s = parseSpec({ ...good(), we: { from: "studio" }, compare: [{ file: "a.doo", as: "parsed", tolerance: 0.5 }] }, "/specs", {});
  assert.equal(s.we.from, "studio");
  assert.equal(s.compare[0].tolerance, 0.5);
  assert.throws(() => parseSpec({ ...good(), we: { from: "nowhere" } }, "/specs", {}), /we\.from/);
  assert.throws(() => parseSpec({ ...good(), compare: [{ file: "a.doo", tolerance: -1 }] }, "/specs", {}), /tolerance/);
  assert.throws(() => parseSpec({ ...good(), compare: [{ file: "a.doo", ignore: "z" }] }, "/specs", {}), /ignore/);
});

test("diffBytes: positions and the extra length", () => {
  assert.equal(diffBytes(Buffer.from([1, 2, 3]), Buffer.from([1, 2, 3])).equal, true);
  const d = diffBytes(Buffer.from([1, 2, 3]), Buffer.from([1, 9, 3, 4]));
  assert.equal(d.count, 2);
  assert.match(d.diffs[0].text, /byte 1 \(0x1\): WE 0x02, Studio 0x09/);
  assert.match(d.diffs[1].text, /length: WE 3 bytes, Studio 4/);
});

function wpm(w, h, cells) {
  const b = Buffer.alloc(16 + w * h);
  b.write("MP3W", 0, "latin1");
  b.writeUInt32LE(0, 4);
  b.writeUInt32LE(w, 8);
  b.writeUInt32LE(h, 12);
  for (const [x, y, v] of cells) b[16 + y * w + x] = v;
  return b;
}

test("diffWpm names cells; another size falls back to bytes", () => {
  assert.equal(diffWpm(wpm(4, 3, []), wpm(4, 3, [])).equal, true);
  const d = diffWpm(wpm(4, 3, [[1, 2, 0xca]]), wpm(4, 3, [[1, 2, 0x08], [3, 0, 1]]));
  assert.equal(d.count, 2);
  assert.equal(d.cells, 12);
  assert.equal(d.diffs[0].text, "cell (3, 0): WE 0x00, Studio 0x01");
  assert.deepEqual(d.diffs[1].cell, [1, 2]);
  assert.match(diffWpm(wpm(4, 3, []), wpm(2, 2, [])).note, /compared as bytes/);
});

test("diffText counts lines", () => {
  assert.equal(diffText("a\nb", "a\r\nb").equal, true);
  const d = diffText("a\nb\nc", "a\nx");
  assert.equal(d.count, 2);
  assert.match(d.diffs[0].text, /line 2: WE "b", Studio "x"/);
});

test("compareFile: a file missing from one save or both is MISSING, never DIFFERS; formatReport shows it", () => {
  const one = compareFile("f", "bytes", null, { bytes: Buffer.alloc(1) });
  assert.equal(one.status, "MISSING");
  assert.match(one.diffs[0].text, /Studio's save only/);
  assert.equal(compareFile("f", "bytes", { bytes: Buffer.alloc(1) }, null).status, "MISSING");
  assert.equal(compareFile("f", "bytes", null, null).status, "MISSING");
  // A file only one save has doesn't satisfy "expect": "differs" (it was the runner's way to go green on a lost file).
  assert.equal(asExpected({ ...one, expect: "differs" }), false);
  assert.match(formatReport({ name: "s", files: [{ ...one, expect: "differs" }] }), /s: UNEXPECTED/);
  const r = compareFile("war3map.w3i", "parsed", { json: { flags: 1 } }, { json: { flags: 2 } });
  assert.equal(r.status, "DIFFERS");
  const text = formatReport({ name: "s", files: [{ ...r, expect: "match" }] });
  assert.match(text, /s: UNEXPECTED/);
  assert.match(text, /flags: WE 1, Studio 2/);
  const known = formatReport({ name: "s", files: [{ ...r, expect: "differs" }] });
  assert.match(known, /s: OK/);
  assert.match(known, /\(expected\)/);
  const same = compareFile("war3map.w3i", "parsed", { json: { a: 1 } }, { json: { a: 1 } });
  assert.match(formatReport({ name: "s", files: [{ ...same, expect: "differs" }] }), /s: UNEXPECTED/);
});

test("autoKind: the codecs' json first, then the name", () => {
  assert.equal(autoKind("war3map.doo", "json"), "parsed");
  assert.equal(autoKind("war3map.wpm", "raw"), "wpm");
  assert.equal(autoKind("war3map.j", "raw"), "text");
  assert.equal(autoKind("war3map.shd", "raw"), "bytes");
});

test("verify-build: folders per commit and per tester differ", () => {
  const l = layout("/main", "abc123");
  assert.equal(l.dir, join("/main", "target", "verify", "abc123"));
  const built = { exe: l.exe, cli: l.cli, id: "dev.x" };
  const a = testerCommands(built, l.runs, "p1"), b = testerCommands(built, l.runs, "p2");
  assert.notEqual(a.appDrive, b.appDrive);
  assert.match(a.appSmoke, /W3_SMOKE_DIR="[^"]*p1[^"]*smoke"/);
  assert.equal(a.env.W3_APP_BIN, l.exe);
});

function isGenerated(map, repo, gens) {
  const rel = relative(join(repo, "target"), map);
  if (rel.startsWith("..") || resolve(rel) === rel) return false;
  const folder = basename(dirname(map));
  const file = basename(map);
  // A generator names its output either literally or as a template (`melee-valid-${name}.w3x`): then the template's
  // fixed prefix and suffix must fit the file and the case name between them must appear in the generator.
  const templated = (g) => [...g.matchAll(/([\w.-]*)\$\{[^}]+\}([\w.-]*)/g)].some(([, pre, post]) => {
    if (!pre && !post) return false;
    if (!file.startsWith(pre) || !file.endsWith(post) || file.length <= pre.length + post.length) return false;
    return g.includes(file.slice(pre.length, file.length - post.length));
  });
  return gens.some((g) => g.includes(folder) && (g.includes(file) || templated(g)));
}

test("no spec under tests/we-compare reads openpoints, and every input map is in the repository (or in smoketest_maps)", () => {
  const root = resolve(process.cwd(), "..", "tests", "we-compare");
  const files = [];
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith(".json") && files.push(join(d, e.name)); };
  walk(root);
  assert.ok(files.length > 50, "found the specs");
  // A main checkout without openpoints: ${MAIN} points at a folder that has none.
  const vars = { MAIN: join(root, "no-such-main"), REPO: resolve(root, "..", "..") };
  // A map under <repo>/target/ is made by a make-*.mjs in tests/fixtures/we-specs (from maps that must not be committed,
  // e.g. the game's own): that generator has to name the file and its folder.
  const gens = readdirSync(resolve(root, "..", "fixtures", "we-specs")).filter((n) => /^make-.*\.mjs$/.test(n)).map((n) => readFileSync(resolve(root, "..", "fixtures", "we-specs", n), "utf8"));
  const generated = (map) => isGenerated(map, vars.REPO, gens);
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    assert.ok(!/openpoints/i.test(text), `${f} mentions openpoints`);
    // smoketest_maps/ is the user's own folder of real maps (read only, not in the repository): a spec may name one there.
    for (const s of parseSpecFile(text, f, vars)) if (s.input.map && !/[\\/]smoketest_maps[\\/]/.test(s.input.map)) assert.ok(existsSync(s.input.map) || generated(s.input.map), `${f}: ${s.name}: no input map at ${s.input.map}`);
  }
  // The control: a spec text that does name it is caught by the same check.
  assert.ok(/openpoints/i.test('{"input":{"map":"${MAIN}/openpoints/x.w3x"}}'));
  // Controls: a target/ input needs a generator that names it; anything outside target/ never counts as generated.
  const gen = ['// into <repo>/target/studio-paths/\n// echo-plain.w3x  unpack, pack\nconst out = join(repo, "target", "studio-paths");'];
  const repo = vars.REPO;
  assert.ok(isGenerated(join(repo, "target", "studio-paths", "echo-plain.w3x"), repo, gen));
  assert.ok(!isGenerated(join(repo, "target", "studio-paths", "other.w3x"), repo, gen));
  assert.ok(!isGenerated(join(repo, "target", "nowhere", "echo-plain.w3x"), repo, gen));
  assert.ok(!isGenerated(join(repo, "tests", "echo-plain.w3x"), repo, gen));
  // A templated name counts when the case name appears in the generator and the fixed parts fit; an unnamed case does not.
  const tpl = ['// into <repo>/target/melee-valid/\nconst cases = { "tree-256": 1 };\nwrite(join(out, `melee-valid-${name}.w3x`));'];
  assert.ok(isGenerated(join(repo, "target", "melee-valid", "melee-valid-tree-256.w3x"), repo, tpl));
  assert.ok(!isGenerated(join(repo, "target", "melee-valid", "melee-valid-other.w3x"), repo, tpl));
  assert.ok(!isGenerated(join(repo, "target", "melee-valid", "other-tree-256.w3x"), repo, tpl));
});
