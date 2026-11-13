// we-compare-core.mjs: reading a spec (and refusing a bad one), and the field-by-field, cell and byte comparisons.
// Each "differs" case has its "matches" control next to it.

import test from "node:test";
import assert from "node:assert/strict";
import { autoKind, compareFile, diffBytes, diffJson, diffText, diffWpm, expandPath, formatReport, parseSpec, parseSpecFile } from "./we-compare-core.mjs";
import { layout, testerCommands } from "./verify-build.mjs";

const good = () => ({ name: "ramp", input: { map: "R.w3x" }, compare: ["war3map.wpm"] });

test("a minimal spec gets its defaults", () => {
  const s = parseSpec(good(), "/specs", {});
  assert.equal(s.input.map, "/specs/R.w3x");
  assert.deepEqual(s.compare, [{ file: "war3map.wpm", as: "auto", expect: "match" }]);
  assert.equal(s.we.mode, "sd");
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

test("compareFile: a missing file is a difference, both missing is MISSING; formatReport shows it", () => {
  assert.equal(compareFile("f", "bytes", null, { bytes: Buffer.alloc(1) }).status, "DIFFERS");
  assert.equal(compareFile("f", "bytes", null, null).status, "MISSING");
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
  assert.equal(l.dir, "/main/target/verify/abc123");
  const built = { exe: l.exe, cli: l.cli, id: "dev.x" };
  const a = testerCommands(built, l.runs, "p1"), b = testerCommands(built, l.runs, "p2");
  assert.notEqual(a.appDrive, b.appDrive);
  assert.match(a.appSmoke, /W3_SMOKE_DIR="[^"]*p1[^"]*smoke"/);
  assert.equal(a.env.W3_APP_BIN, l.exe);
});
