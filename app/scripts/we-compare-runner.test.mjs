// we-compare's verdicts on recorded and made-up saves: a lost or unreadable file is never "the expected difference",
// expectPaths names what must differ, --no-we is not a pass, options a kind doesn't use are refused, the child's last
// line is read, the work folder is locked. No World Editor and no app: fake readers stand for the unpacked saves.
// New functions are reached through the module objects (core.x, run.x), so on the old code a test fails, not the file.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as core from "./we-compare-core.mjs";
import * as w3e from "./we-compare-w3e.mjs";
import * as run from "./we-compare.mjs";
import { checkFresh } from "../../tests/binfresh.mjs";

const { asExpected, compareFile, diffJson, formatReport, parseSpec } = core;
const good = () => ({ name: "ramp", input: { map: "R.w3x" }, compare: ["war3map.wpm"] });

/** A reader of an unpacked save (we-compare.mjs `reader`) from a table: name -> { json } | { text } | { bytes } | { raw }. */
function fakeReader(files) {
  const has = (f) => Object.hasOwn(files, f);
  return {
    has,
    listed: has,
    unpackedAs: (f) => (!has(f) ? null : files[f].json !== undefined ? "json" : files[f].text !== undefined ? "text" : "raw"),
    json: (f) => files[f].json,
    text: (f) => files[f].text,
    bytes: (f) => files[f].bytes ?? Buffer.from(files[f].text ?? ""),
  };
}

/** A version 11 w3e of w x h corners, all flat and dry. */
function w3eFile(w, h, ground = 0) {
  const head = Buffer.alloc(41);
  head.write("W3E!", 0, "latin1");
  head.writeUInt32LE(11, 4);
  head.write("L", 8, "latin1");
  head.writeUInt32LE(1, 13);
  head.write("Ldrt", 17, "latin1");
  head.writeUInt32LE(w, 25);
  head.writeUInt32LE(h, 29);
  const body = Buffer.alloc(w * h * 7);
  for (let i = 0; i < w * h; i++) body.writeInt16LE(0x2000 + ground, i * 7);
  return Buffer.concat([head, body]);
}

const entry = (c) => parseSpec({ ...good(), compare: [c] }, "/s").compare[0];

// ---------------------------------------------------------------- 1: lost and unreadable files

test("expect differs: a save that can't be read is ERROR, not the expected difference, and the run exits 2", () => {
  const c = entry({ file: "war3map.w3e", as: "w3e", expect: "differs" });
  const cut = fakeReader({ "war3map.w3e": { bytes: w3eFile(4, 4).subarray(0, 60) } });
  const whole = fakeReader({ "war3map.w3e": { bytes: w3eFile(4, 4) } });
  const f = core.compareEntry(c, cut, whole);
  assert.equal(f.status, "ERROR");
  assert.match(f.diffs[0].text, /World Editor's save: truncated/);
  assert.equal(asExpected(f), false);
  assert.match(formatReport({ name: "s", files: [f] }), /s: UNEXPECTED/);
  assert.equal(core.runOutcome([{ name: "s", files: [f], error: null }]).code, 2);
  // Control: a real difference of heights is DIFFERS, as expected, exit 0.
  const real = core.compareEntry(c, fakeReader({ "war3map.w3e": { bytes: w3eFile(4, 4, 5) } }), whole);
  assert.equal(real.status, "DIFFERS");
  assert.equal(asExpected(real), true);
  const out = core.runOutcome([{ name: "s", files: [real], error: null }]);
  assert.deepEqual([out.ok, out.code], [true, 0]);
});

test("a file that is in the save but didn't unpack as JSON is ERROR, not 'in one save only'", () => {
  for (const as of ["parsed", "unit-heights", "doodad-places", "unit-ids"]) {
    const c = entry({ file: "war3mapUnits.doo", as, expect: "differs" });
    const json = fakeReader({ "war3mapUnits.doo": { json: { units: [], doodads: [] } } });
    const raw = fakeReader({ "war3mapUnits.doo": { raw: true, bytes: Buffer.from([1, 2, 3]) } });
    const f = core.compareEntry(c, json, raw);
    assert.equal(f.status, "ERROR", as);
    assert.match(f.diffs[0].text, /Studio's save: .*no JSON/, as);
    assert.equal(asExpected(f), false, as);
  }
});

test("a file absent from one save is MISSING (exit 1), absent from both too; neither satisfies expect differs", () => {
  const c = entry({ file: "war3map.w3i", as: "parsed", expect: "differs" });
  const f = core.compareEntry(c, fakeReader({ "war3map.w3i": { json: { a: 1 } } }), fakeReader({}));
  assert.equal(f.status, "MISSING");
  assert.equal(asExpected(f), false);
  assert.equal(core.runOutcome([{ name: "s", files: [f], error: null }]).code, 1);
  assert.equal(core.compareEntry(c, fakeReader({}), fakeReader({})).status, "MISSING");
});

// ---------------------------------------------------------------- 2: expectPaths

test("expectPaths: every listed path must differ and nothing else may", () => {
  const we = { players: [{ start: [1, 2], name: "A", allyLow: 2 }], flags: 1 };
  const st = (patch) => ({ players: [{ start: [5, 6], name: "B", allyLow: 2, ...patch }], flags: 1 });
  const expectPaths = ["players[].start", "players[].name"];
  const exact = { expect: "differs", ...compareFile("war3map.w3i", "parsed", { json: we }, { json: st({}) }, 10, 0, [], expectPaths) };
  assert.equal(exact.status, "DIFFERS");
  assert.equal(asExpected(exact), true);
  // Something else differs too: not the expected difference.
  const more = { expect: "differs", ...compareFile("war3map.w3i", "parsed", { json: we }, { json: st({ allyLow: 9 }) }, 10, 0, [], expectPaths) };
  assert.equal(more.status, "DIFFERS");
  assert.deepEqual(more.unexpected, { count: 1, paths: ["players[0].allyLow"] });
  assert.equal(asExpected(more), false);
  assert.match(formatReport({ name: "s", files: [more] }), /outside expectPaths: players\[0\]\.allyLow/);
  // A listed path that doesn't differ: not the expected difference either.
  const less = { expect: "differs", ...compareFile("war3map.w3i", "parsed", { json: we }, { json: st({ name: "A" }) }, 10, 0, [], expectPaths) };
  assert.deepEqual(less.expectMissing, ["players[].name"]);
  assert.equal(asExpected(less), false);
  assert.match(formatReport({ name: "s", files: [less] }), /expected to differ but don't: players\[\]\.name/);
});

test("expectPaths in a spec: with expect differs only, on JSON kinds only; studio-paths-matrix-masks has them", () => {
  assert.deepEqual(entry({ file: "war3map.w3i", as: "parsed", expect: "differs", expectPaths: ["players[].start"] }).expectPaths, ["players[].start"]);
  assert.throws(() => entry({ file: "war3map.w3i", as: "parsed", expectPaths: ["players[].start"] }), /goes with "expect": "differs"/);
  assert.throws(() => entry({ file: "war3map.j", as: "text", expect: "differs", expectPaths: ["x"] }), /no effect on "as": "text"/);
  assert.throws(() => entry({ file: "war3map.w3i", as: "parsed", expect: "differs", expectPaths: [] }), /expectPaths/);
  // The tests run from a copy of the scripts: the spec folder is found from where they run (app/ or the repository).
  let dir = process.cwd();
  while (!existsSync(join(dir, "tests", "we-compare"))) {
    if (dirname(dir) === dir) throw new Error("tests/we-compare not found");
    dir = dirname(dir);
  }
  const specs = core.parseSpecFile(readFileSync(join(dir, "tests", "we-compare", "studio-paths.json"), "utf8"), "/r/tests/we-compare/studio-paths.json", { MAIN: "/m", REPO: "/r" });
  const masks = specs.find((s) => s.name === "studio-paths-matrix-masks").compare.find((c) => c.file === "war3map.w3i");
  assert.ok(masks.expectPaths?.includes("players[].start"));
});

// ---------------------------------------------------------------- 3: --no-we

test("--no-we compares nothing: NOT COMPARED, not ok, exit 3", () => {
  const r = { name: "s", files: [], error: null, notCompared: true };
  const out = core.runOutcome([r]);
  assert.equal(out.ok, false);
  assert.equal(out.code, 3);
  assert.match(formatReport(r), /s: NOT COMPARED/);
  // Control: a compared spec with a match is ok.
  assert.equal(core.runOutcome([{ name: "s", files: [{ ...compareFile("f", "parsed", { json: 1 }, { json: 1 }), expect: "match" }], error: null }]).code, 0);
});

// ---------------------------------------------------------------- 4: options per kind

test("tolerance applies to every JSON kind (unit-heights' z), and is refused where nothing uses it", () => {
  const units = (z) => ({ json: w3e.unitHeights({ units: [{ id: "hfoo", position: [0, 0, z] }] }) });
  assert.equal(compareFile("war3mapUnits.doo", "unit-heights", units(0), units(0.4), 10, 0.5).status, "MATCH");
  assert.equal(compareFile("war3mapUnits.doo", "unit-heights", units(0), units(0.6), 10, 0.5).status, "DIFFERS", "control: beyond it");
  for (const as of ["text", "bytes", "wpm"]) {
    assert.throws(() => entry({ file: "f", as, tolerance: 1 }), /tolerance has no effect/, as);
    assert.throws(() => entry({ file: "f", as, ignore: ["x"] }), /ignore has no effect/, as);
  }
  // "auto" is worked out later: a text file then is ERROR, not a silent exact compare.
  const f = compareFile("war3map.j", "text", { text: "a" }, { text: "a" }, 10, 1);
  assert.equal(f.status, "ERROR");
  assert.equal(compareFile("war3map.j", "text", { text: "a" }, { text: "a" }, 10, 0, ["x"]).status, "ERROR");
  assert.equal(compareFile("war3map.j", "text", { text: "a" }, { text: "a" }).status, "MATCH", "control: without options");
});

test("minimap: the tolerance is for the block colours, the picture's size is compared exactly", () => {
  const view = (width, height) => ({ json: w3e.minimapView({ width, height, rgba: new Uint8Array(width * height * 4).fill(100) }) });
  assert.equal(compareFile("war3mapMap.blp", "minimap", view(32, 32), view(32, 32), 10, 24).status, "MATCH");
  const r = compareFile("war3mapMap.blp", "minimap", view(32, 32), view(32, 16), 10, 24);
  assert.equal(r.status, "DIFFERS");
  assert.ok(r.diffs.some((d) => d.path === "size[1]"));
});

test("ignore: a pattern naming no path is listed (a warning, an error with strictIgnore); metacharacters are themselves", () => {
  const d = diffJson({ a: 1, units: [{ z: 1 }] }, { a: 2, units: [{ z: 1 }] }, 10, 0, ["a", "unit[].z", "units[].z"]);
  assert.deepEqual(d.ignoreUnmatched, ["unit[].z"]);
  const f = { ...compareFile("f", "parsed", { json: { a: 1 } }, { json: { a: 1 } }, 10, 0, ["nope"]), expect: "match" };
  assert.equal(asExpected(f), true, "a warning only");
  assert.equal(asExpected(f, { strictIgnore: true }), false);
  assert.match(formatReport({ name: "s", files: [f] }), /warning: ignore names no path of either file: nope/);
  // Keys with regex characters: "a+b" is that key, not "a", "aab" or "ab".
  assert.equal(diffJson({ "a+b": 1 }, { "a+b": 2 }, 10, 0, ["a+b"]).equal, true);
  assert.equal(diffJson({ aab: 1 }, { aab: 2 }, 10, 0, ["a+b"]).equal, false, "control: another key");
  assert.equal(diffJson({ "x(1)": 1 }, { "x(1)": 2 }, 10, 0, ["x(1)"]).equal, true);
  // A pattern below a field one side lacks still counts as naming a path.
  assert.deepEqual(diffJson({ u: [{ h: { s: 1 } }] }, { u: [] }, 10, 0, ["u[].h.s"]).ignoreUnmatched, []);
});

// ---------------------------------------------------------------- 5: the child's output

test("runLines: the last line without a line break is kept; output is read to its end", async () => {
  const script = "process.stdout.write('x'.repeat(200000) + '\\n'); process.stdout.write(JSON.stringify({ step: '--save', saved: true }));";
  const { code, lines } = await run.runLines(process.execPath, ["-e", script]);
  assert.equal(code, 0);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].length, 200000);
  assert.deepEqual(JSON.parse(lines[1]), { step: "--save", saved: true });
});

test("runLines: a program that can't start rejects instead of hanging", async () => {
  await assert.rejects(run.runLines(join(tmpdir(), "no-such-program-we-compare"), []), /ENOENT/);
});

// ---------------------------------------------------------------- 6: the app's web sources

test("a prebuilt app older than a file of app/src is stale", () => {
  const root = mkdtempSync(join(tmpdir(), "binfresh-app-"));
  try {
    for (const f of ["Cargo.lock", "app/src-tauri/main.rs", "app/src/main.ts", "app/index.html", "app/package-lock.json"]) {
      mkdirSync(join(root, f, ".."), { recursive: true });
      writeFileSync(join(root, f), "");
      utimesSync(join(root, f), 1000, 1000);
    }
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["add", "."], { cwd: root });
    const bin = join(root, "w3proj-studio");
    writeFileSync(bin, "");
    utimesSync(bin, 1500, 1500);
    assert.equal(checkFresh(bin, { root, kind: "app" }), bin, "control: older sources");
    utimesSync(join(root, "app/src/main.ts"), 2000, 2000);
    assert.throws(() => checkFresh(bin, { root, kind: "app" }), /app\/src\/main\.ts/);
    assert.equal(checkFresh(bin, { root, kind: "cli" }), bin, "the CLI doesn't embed the page");
    utimesSync(join(root, "app/src/main.ts"), 1000, 1000);
    utimesSync(join(root, "app/package-lock.json"), 2000, 2000);
    assert.throws(() => checkFresh(bin, { root, kind: "app" }), /package-lock\.json/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- 7: names and the work folder

test("spec names: we-compare's own folders are refused, in any case; two names differing in case collide", () => {
  for (const name of ["studio-app", "we-drive", "Studio-App", "report.json", "WE-DRIVE"]) assert.throws(() => parseSpec({ ...good(), name }, "/s"), /we-compare's own folders/, name);
  assert.equal(parseSpec({ ...good(), name: "studio-apps" }, "/s").name, "studio-apps", "control");
  assert.throws(() => core.parseSpecFile(JSON.stringify([good(), { ...good(), name: "Ramp" }]), "/s/f.json"), /two specs are named/);
});

test("the work folder's lock: a live holder stops a second run, a dead one's lock is taken over, release frees it", async () => {
  const work = mkdtempSync(join(tmpdir(), "we-compare-lock-"));
  try {
    const release = run.lockWork(work);
    assert.equal(readFileSync(join(work, "we-compare.lock"), "utf8"), String(process.pid));
    assert.throws(() => run.lockWork(work), /another we-compare \(pid \d+\) uses/);
    release();
    // A lock left by a process that has ended.
    const child = spawn(process.execPath, ["-e", ""]);
    await new Promise((ok) => child.on("close", ok));
    writeFileSync(join(work, "we-compare.lock"), String(child.pid));
    const again = run.lockWork(work);
    assert.equal(readFileSync(join(work, "we-compare.lock"), "utf8"), String(process.pid));
    again();
  } finally { rmSync(work, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- 8: the empty minimap

test("minimapView refuses an empty picture (two would compare equal)", () => {
  assert.throws(() => w3e.minimapView({ width: 0, height: 0, rgba: new Uint8Array(0) }), /nothing to compare/);
  assert.throws(() => w3e.minimapView({ width: 16, height: 0, rgba: new Uint8Array(0) }), /nothing to compare/);
  assert.deepEqual(w3e.minimapView({ width: 1, height: 1, rgba: new Uint8Array([1, 2, 3, 255]) }), { size: [1, 1], blocks: { "0,0": [1, 2, 3] } }, "control");
});

// ---------------------------------------------------------------- 10: ui actions

test("ui keys get a real code; clicks outside the editor's view and bad actions are refused before the run", () => {
  assert.deepEqual(core.uiKey("d"), { key: "d", code: "KeyD" });
  assert.deepEqual(core.uiKey("6"), { key: "6", code: "Digit6" });
  assert.deepEqual(core.uiKey("Numpad6"), { key: "6", code: "Numpad6" });
  assert.deepEqual(core.uiKey("Escape"), { key: "Escape", code: "Escape" });
  assert.deepEqual(core.uiKey("6", "Numpad6"), { key: "6", code: "Numpad6" });
  const ui = (actions) => parseSpec({ ...good(), studio: { steps: [{ terrain: true }, { ui: actions }] } }, "/s");
  assert.ok(ui([["click", 748, 500], ["drag", 600, 500, 730, 930], ["size", 3], ["key", "d"]]), "control: inside the view; a drag may end past it");
  assert.throws(() => ui([["click", 100, 500]]), /outside the editor's terrain view/);
  assert.throws(() => ui([["drag", 100, 500, 600, 500]]), /starts outside/);
  assert.throws(() => ui([["size", "big"]]), /wants a number/);
  assert.throws(() => ui([["wiggle"]]), /unknown ui action/);
});

// ---------------------------------------------------------------- 11: specs after a failure, numeric options

test("after a World Editor failure the specs behind it are run again, not left without an error or a save", () => {
  const outs = [{ step: "--map" }, { step: "--key", error: "no such window" }];
  const { errors, rerun } = core.weOutcome(3, outs);
  assert.match(errors[0], /World Editor: no such window/);
  assert.deepEqual(rerun, [1, 2]);
  // Control: all saved, nothing to run again.
  const all = core.weOutcome(2, [{ step: "--map" }, { step: "--save", saved: true }, { step: "--map" }, { step: "--save", saved: true }]);
  assert.deepEqual(all, { errors: [null, null], rerun: [] });
  // A spec saved after the failed one isn't run again; one that stopped without a save before any failure is named.
  const mid = core.weOutcome(3, [{ step: "--map" }, { step: "--save", saved: false, dialogs: ["x"] }, { step: "--map" }, { step: "--save", saved: true }]);
  assert.match(mid.errors[0], /the save didn't finish/);
  assert.equal(mid.errors[1], null);
  assert.deepEqual(mid.rerun, [2]);
});

test("--limit takes a positive whole number", () => {
  assert.equal(run.parseArgs(["--limit", "5", "a.json"]).limit, 5);
  for (const v of ["abc", "0", "-2", "1.5"]) assert.throws(() => run.parseArgs(["--limit", v]), /--limit is a positive whole number/, v);
});
