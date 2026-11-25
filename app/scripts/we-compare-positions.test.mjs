// expectPaths on text, text-exact and wpm (lines and cells), and the ui `texture` action's exact-title match.

import test from "node:test";
import assert from "node:assert/strict";
import * as core from "./we-compare-core.mjs";
import * as ui from "./we-compare-ui.mjs";

const { asExpected, compareFile, formatReport, parseSpec } = core;
const entry = (c) => parseSpec({ name: "s", input: { map: "m.w3x" }, compare: [c] }, "/s", {}, "spec", { differsWithoutPaths: "any" }).compare[0];

/** A pathing map of w x h cells, the cells in `set` ("x,y": value) changed from 0. */
const wpm = (w, h, set = {}, version = 0) => {
  const b = Buffer.alloc(16 + w * h);
  b.write("MP3W", 0, "latin1");
  b.writeUInt32LE(version, 4); b.writeUInt32LE(w, 8); b.writeUInt32LE(h, 12);
  for (const [k, v] of Object.entries(set)) { const [x, y] = k.split(",").map(Number); b[16 + y * w + x] = v; }
  return b;
};
const wpmCmp = (st, paths, we = wpm(4, 4)) => ({ expect: "differs", ...compareFile("war3map.wpm", "wpm", { bytes: we }, { bytes: st }, 10, 0, [], paths) });
const textCmp = (a, b, paths, kind = "text") => ({ expect: "differs", ...compareFile("war3map.j", kind, { text: a }, { text: b }, 10, 0, [], paths) });

test("text expectPaths: lines and ranges must hold the differences, and nothing else may differ", () => {
  const a = "a\nb\nc\nd\ne", b = "a\nB\nC\nd\nE";
  assert.equal(asExpected(textCmp(a, b, ["2-3", "5"])), true);
  const outside = textCmp(a, b, ["2-3"]);
  assert.equal(asExpected(outside), false, "line 5 differs outside the list");
  assert.match(formatReport({ name: "s", files: [outside] }), /1 difference outside expectPaths: line 5/);
  const miss = textCmp(a, b, ["2-3", "5", "4"]);
  assert.deepEqual(miss.expectMissing, ["4"]);
  assert.equal(asExpected(miss), false, "line 4 is listed but equal");
  assert.equal(asExpected(textCmp("x\ny", "x\nz\nextra", ["2-3"])), true, "extra lines count by their number");
  // The control: without expectPaths the same difference stays a plain pass.
  assert.equal(textCmp(a, b, []).unexpected, undefined);
  // text-exact: a CR is part of the line, so CRLF against LF differs on every line.
  assert.equal(asExpected(textCmp("a\r\nb", "a\nb", ["1-2"], "text-exact")), true);
  assert.equal(asExpected(textCmp("a\r\nb", "a\nb", ["2"], "text-exact")), false);
});

test("wpm expectPaths: cells and boxes of cells", () => {
  const st = wpm(4, 4, { "1,2": 8, "2,2": 8, "3,0": 2 });
  assert.equal(asExpected(wpmCmp(st, ["1,2-2,2", "3,0"])), true);
  const outside = wpmCmp(st, ["1,2-2,2"]);
  assert.equal(asExpected(outside), false);
  assert.match(formatReport({ name: "s", files: [outside] }), /1 difference outside expectPaths: cell \(3, 0\)/);
  assert.deepEqual(wpmCmp(st, ["1,2-2,2", "3,0", "0,0"]).expectMissing, ["0,0"]);
  // A box is both corners included and taller than one row.
  assert.equal(asExpected(wpmCmp(wpm(4, 4, { "0,0": 1, "1,1": 1 }), ["0,0-1,1"])), true);
  assert.equal(asExpected(wpmCmp(wpm(4, 4, { "0,0": 1, "2,1": 1 }), ["0,0-1,1"])), false);
  // A version difference or two sizes have no cell: outside every pattern.
  assert.equal(asExpected(wpmCmp(wpm(4, 4, { "1,2": 8 }, 1), ["1,2"])), false);
  assert.equal(asExpected(wpmCmp(wpm(5, 4, { "1,2": 8 }), ["1,2"])), false);
});

test("expectPaths in a spec: text and wpm take lines / cells, a malformed one is refused", () => {
  assert.deepEqual(entry({ file: "war3map.j", as: "text", expect: "differs", expectPaths: ["3", "10-12"] }).expectPaths, ["3", "10-12"]);
  assert.deepEqual(entry({ file: "war3map.wpm", as: "wpm", expect: "differs", expectPaths: ["1,2", "0,0-3,3"] }).expectPaths, ["1,2", "0,0-3,3"]);
  for (const p of ["x", "0", "5-3", "1,2", "1-"]) assert.throws(() => entry({ file: "f", as: "text", expect: "differs", expectPaths: [p] }), /line "12" or a range/, p);
  for (const p of ["3", "1,2-0,0", "a,b", "1,2-3"]) assert.throws(() => entry({ file: "f", as: "wpm", expect: "differs", expectPaths: [p] }), /cell "x,y"/, p);
  assert.throws(() => entry({ file: "f", as: "text", expectPaths: ["1"] }), /goes with "expect": "differs"/);
  assert.throws(() => entry({ file: "f", as: "bytes", expect: "differs", expectPaths: ["1"] }), /no effect/);
  // Without expectPaths an unnamed "differs" is refused as before.
  assert.throws(() => parseSpec({ name: "s", input: { map: "m.w3x" }, compare: [{ file: "war3map.wpm", as: "wpm", expect: "differs" }] }, "/s", {}, "spec", { differsWithoutPaths: new Set() }), /can't name what differs/);
});

test("ui texture action: an exact title wins over the first title that contains the text", () => {
  const run = (titles, text) => {
    const clicked = [];
    const tiles = titles.map((title) => ({ title, click: () => clicked.push(title) }));
    new Function("document", ui.textureScript(text))({ querySelectorAll: () => tiles });
    return clicked;
  };
  assert.deepEqual(run(["Lords Grass", "Lgrs", "Lgrs2"], "Lgrs"), ["Lgrs"], "exact beats an earlier contains");
  assert.deepEqual(run(["Lords Grass", "Lgrs2"], "Lgrs"), ["Lgrs2"], "no exact: the first that contains");
  assert.deepEqual(run(["Dirt", "Lgrs2", "Lgrs3"], "Lgrs"), ["Lgrs2"], "first of several contains");
  assert.throws(() => run(["Dirt"], "Lgrs"), /no tile Lgrs/);
  assert.throws(() => run(["Dirt"], "Lgr's\"x"), /no tile/, "a quote in the name stays literal");
});
