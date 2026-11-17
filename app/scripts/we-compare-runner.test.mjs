// we-compare's verdicts on recorded and made-up saves: a lost or unreadable file is never "the expected difference",
// expectPaths names what must differ, --no-we is not a pass, options a kind doesn't use are refused, the child's last
// line is read, the work folder is locked. No World Editor and no app: fake readers stand for the unpacked saves.
// New functions are reached through the module objects (core.x, run.x), so on the old code a test fails, not the file.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import * as core from "./we-compare-core.mjs";
import * as w3e from "./we-compare-w3e.mjs";
import * as run from "./we-compare.mjs";
import { checkFresh } from "../../tests/binfresh.mjs";
import { scratchDir } from "../../tests/scratch.mjs";
import { repoPath } from "../src/lib/testhelpers/testutil";

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

// "any": these tests are about the comparison, not about the rule that a "differs" names its paths.
const entry = (c) => parseSpec({ ...good(), compare: [c] }, "/s", {}, "spec", { differsWithoutPaths: "any" }).compare[0];

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
  const specs = core.parseSpecFile(readFileSync(repoPath("tests", "we-compare", "studio-paths.json"), "utf8"), "/r/tests/we-compare/studio-paths.json", { MAIN: "/m", REPO: "/r" }, { differsWithoutPaths: core.readDiffersAllowlist(resolve(repoPath("tests"), "..")) });
  const masks = specs.find((s) => s.name === "studio-paths-matrix-masks").compare.find((c) => c.file === "war3map.w3i");
  assert.ok(masks.expectPaths?.includes("players[].start"));
});

test("expectLines (text-set): each side's lines only it has must match its patterns, every pattern must be hit", () => {
  const we = "a\nb\nc";
  const expectLines = { studio: ["^call SetSoundDuration"], we: ["^old "] };
  const c = entry({ file: "war3map.j", as: "text-set", expect: "differs", expectLines });
  const side = (t) => fakeReader({ "war3map.j": { text: t } });
  const exact = core.compareEntry(c, side(`${we}\nold x`), side(`c\nb\na\ncall SetSoundDuration(s, 1)`));
  assert.equal(exact.status, "DIFFERS");
  assert.equal(asExpected(exact), true);
  // A line the pattern names, but on the other side: not the expected difference.
  const swapped = core.compareEntry(c, side(`${we}\nold x\ncall SetSoundDuration(s, 1)`), side(we));
  assert.equal(asExpected(swapped), false);
  assert.equal(swapped.unexpected.count, 1);
  assert.match(formatReport({ name: "s", files: [swapped] }), /outside expectLines: WE only: "call SetSoundDuration/);
  assert.deepEqual(swapped.expectMissing, ["Studio /^call SetSoundDuration/"]);
  // Another line differs too: unexpected.
  const more = core.compareEntry(c, side(`${we}\nold x`), side(`${we}\ncall SetSoundDuration(s, 1)\nd`));
  assert.equal(asExpected(more), false);
  assert.deepEqual(more.unexpected.paths, ['Studio only: "d"']);
  // A pattern no line hits (the World Editor's step missed): unexpected.
  const less = core.compareEntry(c, side(we), side(`${we}\ncall SetSoundDuration(s, 1)`));
  assert.equal(less.status, "DIFFERS");
  assert.deepEqual(less.expectMissing, ["WE /^old /"]);
  assert.equal(asExpected(less), false);
  assert.match(formatReport({ name: "s", files: [less] }), /expected to differ but don't: WE \/\^old \//);
  // Nothing differs: not the expected difference.
  assert.equal(asExpected(core.compareEntry(c, side(we), side(we))), false);
  // In a spec: with differs and text-set only; it names what differs, so no allowlist entry is needed.
  const strict = (e) => parseSpec({ ...good(), compare: [e] }, "/s").compare[0];
  assert.deepEqual(strict({ file: "war3map.j", as: "text-set", expect: "differs", expectLines }).expectLines, expectLines);
  assert.throws(() => strict({ file: "war3map.j", as: "text-set", expect: "differs" }), /can't name what differs/, "control: without expectLines it is refused");
  assert.throws(() => strict({ file: "war3map.j", as: "text", expect: "differs", expectLines }), /goes with "as": "text-set"/);
  assert.throws(() => strict({ file: "war3map.j", as: "text-set", expectLines }), /goes with "expect": "differs"/);
  assert.throws(() => strict({ file: "war3map.j", as: "text-set", expect: "differs", expectLines: { we: [] } }), /expectLines is/);
  assert.throws(() => strict({ file: "war3map.j", as: "text-set", expect: "differs", expectLines: { both: ["x"] } }), /expectLines is/);
  assert.throws(() => strict({ file: "war3map.j", as: "text-set", expect: "differs", expectLines: { we: ["("] } }), /not a regular expression/);
  assert.equal(compareFile("war3map.j", "text", { text: "a" }, { text: "b" }, 10, 0, [], [], { we: ["a"] }).status, "ERROR");
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
  await assert.rejects(run.runLines(join(scratchDir("we-compare-noprog-"), "no-such-program"), []), /ENOENT/);
});

// ---------------------------------------------------------------- 6: the app's web sources

test("a prebuilt app older than a file of app/src is stale", () => {
  const root = scratchDir("binfresh-app-");
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
  const work = scratchDir("we-compare-lock-");
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
  assert.deepEqual(all, { errors: [null, null], rerun: [], warnings: [null, null], closes: [null, null] });
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

// ---------------------------------------------------------------- 12: review round of 2026-11-17

test("expect differs on a JSON kind needs expectPaths, unless the spec and file are on the allowlist", () => {
  const spec = (c) => ({ ...good(), compare: [c] });
  const differs = { file: "war3map.w3e", as: "w3e", expect: "differs" };
  assert.throws(() => parseSpec(spec(differs), "/s"), /expects "differs" without "expectPaths"/);
  // "auto" on a file that may be the codecs' JSON counts too; on a script (text) or a pathing map it can't take paths:
  // refused as well (any difference would pass), with the way out named; allowed only through the list.
  assert.throws(() => parseSpec(spec({ file: "war3map.w3i", expect: "differs" }), "/s"), /without "expectPaths"/);
  for (const c of [{ file: "war3map.j", expect: "differs" }, { file: "war3map.wpm", expect: "differs" }, { file: "war3map.lua", as: "text", expect: "differs" }, { file: "war3map.wpm", as: "wpm", expect: "differs" }, { file: "war3map.j", as: "text-set", expect: "differs" }, { file: "war3map.w3i", as: "bytes", expect: "differs" }]) {
    assert.throws(() => parseSpec(spec(c), "/s"), /can't name what differs.*JSON kind.*"lines"/, `${c.file} as ${c.as ?? "auto"}`);
    assert.ok(parseSpec(spec(c), "/s", {}, "spec", { differsWithoutPaths: new Set([`ramp ${c.file}`]) }), `control: ${c.file} on the list`);
    assert.ok(parseSpec(spec({ ...c, expect: "match" }), "/s"), `control: ${c.file} expected to match`);
  }
  // Controls: with its paths, or listed as "name file", it parses; another spec of the list's file does not.
  assert.ok(parseSpec(spec({ ...differs, expectPaths: ["corners[]"] }), "/s"));
  assert.ok(parseSpec(spec(differs), "/s", {}, "spec", { differsWithoutPaths: new Set(["ramp war3map.w3e"]) }));
  assert.throws(() => parseSpec(spec(differs), "/s", {}, "spec", { differsWithoutPaths: new Set(["ramp war3map.wpm", "other war3map.w3e"]) }), /without "expectPaths"/);
});

test("the allowlist of differs without paths only shrinks: every entry exists and still needs it, in its section", () => {
  const root = repoPath("tests", "we-compare");
  const { entries, textEntries } = core.readDiffersAllowlistSections(resolve(root, "..", ".."));
  // Lower these as entries get their paths (or a JSON kind, or "lines" and a match); never raise them.
  assert.ok(entries.size <= 34,`the JSON kinds' list grew to ${entries.size}`);
  assert.ok(textEntries.size <= 3,`the text kinds' list grew to ${textEntries.size}`);
  const needed = { json: new Set(), text: new Set() };
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".json") && p !== core.differsAllowlistPath(resolve(root, "..", ".."))) {
        const raw = JSON.parse(readFileSync(p, "utf8"));
        for (const s of Array.isArray(raw) ? raw : [raw]) for (const c of s.compare) if (typeof c === "object" && c.expect === "differs" && !c.expectPaths && !c.expectLines) needed[core.takesPaths(c.as ?? "auto", c.file) ? "json" : "text"].add(`${s.name} ${c.file}`);
      }
    }
  };
  walk(root);
  assert.ok(needed.json.size > 0, "found the specs");
  for (const [list, need, name] of [[entries, needed.json, "entries"], [textEntries, needed.text, "textEntries"]]) {
    for (const e of list) assert.ok(need.has(e), `${e} is in the allowlist's ${name} but no spec needs it there (gone, or it names what differs now): take it out`);
    for (const e of need) assert.ok(list.has(e), `${e} expects differs without expectPaths and isn't in the allowlist's ${name}`);
  }
});

test("text-exact keeps line endings: CRLF against LF differs, which text doesn't see; it reads the map's bytes", () => {
  const crlf = "a\r\nb\r\n", lf = "a\nb\n";
  assert.equal(compareFile("war3map.j", "text", { text: crlf }, { text: lf }).status, "MATCH", "text: line endings normalised");
  const exact = compareFile("war3map.j", "text-exact", { text: crlf }, { text: lf });
  assert.equal(exact.status, "DIFFERS");
  assert.match(exact.diffs[0].text, /\\r/);
  assert.equal(compareFile("war3map.j", "text-exact", { text: crlf }, { text: crlf }).status, "MATCH", "control");
  // A trailing line break is a line of its own.
  assert.equal(compareFile("war3map.j", "text-exact", { text: "a\r\n" }, { text: "a\r\n\r\n" }).status, "DIFFERS");
  // The map's own bytes, not the unpack's text (which may be normalised); a file only the unpack has is its text.
  const r = { ...fakeReader({ "war3map.j": { text: lf, bytes: Buffer.from(crlf) } }) };
  assert.equal(core.loadSide(r, "war3map.j", "text-exact").text, crlf);
  assert.equal(core.loadSide(r, "war3map.j", "text").text, lf, "control: text reads the unpacked text");
  const wct = { ...fakeReader({ "war3map.wct.txt": { text: crlf } }), listed: () => false };
  assert.equal(core.loadSide(wct, "war3map.wct.txt", "text-exact").text, crlf);
  // The header specs pin their line endings with it.
  const specs = core.parseSpecFile(readFileSync(repoPath("tests", "we-compare", "script-inputs-e.json"), "utf8"), "script-inputs-e.json", { REPO: "/r", MAIN: "/m" });
  for (const n of ["header-newlines", "header-newlines-lua", "header-spaces", "header-spaces-lua", "header-tab-lines"]) {
    assert.ok(specs.find((s) => s.name === n).compare.every((c) => c.as === "text-exact"), n);
  }
});

test("a crash while closing after the spec's save is a warning, the save kept; before the save it is a failure", () => {
  const crash = { step: "--close", closed: true, crashed: true, message: "the World Editor crashed; report dismissed without sending" };
  const saved = core.weOutcome(1, [{ step: "--map" }, { step: "--wait-ready", ready: true }, { step: "--save", saved: true }, crash]);
  assert.deepEqual(saved.errors, [null]);
  assert.match(saved.warnings[0], /crashed while closing, after the save/);
  assert.match(formatReport({ name: "s", files: [], error: null, warnings: saved.warnings }), /warning: World Editor: the World Editor crashed while closing/);
  // Control: a crash before the save (no save line) fails the spec.
  const unsaved = core.weOutcome(1, [{ step: "--map" }, { step: "--key", crashed: true, error: "the World Editor crashed" }]);
  assert.match(unsaved.errors[0], /crashed/);
  // --restart-per-map: the process stopped at the crash, so the specs after it run again (not "no save").
  const per = core.weOutcome(3, [{ step: "--map" }, { step: "--save", saved: true }, crash]);
  assert.deepEqual(per.errors, [null, null, null]);
  assert.deepEqual(per.rerun, [1, 2]);
  // A close that didn't close is still a failure.
  const stuck = core.weOutcome(1, [{ step: "--map" }, { step: "--save", saved: true }, { step: "--close", closed: false, crashed: true, error: "still running" }]);
  assert.match(stuck.errors[0], /still running/);
});

test("Studio's state is put back after a spec: the settings it changes, stubbed w3.window functions, its window globals", () => {
  const spec = parseSpec({ ...good(), input: { new: { name: "N", width: 32, height: 32 }, steps: [{ setting: ["script.generateOnSave", false] }] }, studio: { settings: { "mcp.writeTools": true }, steps: [{ setting: ["terrain.resetFixedHeights", false] }, { setting: ["mcp.writeTools", true] }] } }, "/s");
  assert.deepEqual(core.settingKeys(spec),["mcp.writeTools", "script.generateOnSave", "terrain.resetFixedHeights"]);
  // The page's side, on fakes: the runner's own stub (confirm) is the baseline; the spec's are undone.
  const original = { showWarning() {}, confirm() {} };
  const w3 = { window: { ...original } };
  const runnerConfirm = async () => true;
  w3.window.confirm = runnerConfirm;
  const win = { __compareGroup: 1, __driveEd: null };
  run.isolateSnapshot(win, w3);
  w3.window.showWarning = async () => undefined;
  w3.window.pickFile = async () => "x";
  delete w3.window.showInfo;
  win.__prefs = () => {};
  win.__asked = [];
  win.__driveEd = { ed: 1 };
  const back = run.isolateRestore(win, w3);
  assert.equal(w3.window.showWarning, original.showWarning);
  assert.equal(w3.window.confirm, runnerConfirm, "the runner's own stub stays");
  assert.ok(!("pickFile" in w3.window));
  assert.deepEqual(Object.keys(win).sort(), ["__compareGroup", "__driveEd"]);
  assert.deepEqual(back.sort(), ["w3.window.pickFile", "w3.window.showWarning", "window.__asked", "window.__prefs"]);
  // Control: a spec that changes nothing gets nothing put back.
  run.isolateSnapshot(win, w3);
  assert.deepEqual(run.isolateRestore(win, w3), []);
});

test("a missing input map is that spec's error, naming the generator that makes it", () => {
  const repoDir = resolve(repoPath("tests"), "..");
  assert.match(run.missingInput(join(repoDir, "target", "melee-valid", "melee-valid-tree-256.w3x"), repoDir), /no input map at .*make-melee-valid\.mjs/);
  assert.match(run.missingInput(join(repoDir, "target", "studio-paths", "echo-plain.w3x"), repoDir), /make-studio-paths\.mjs/);
  // Control: a map outside target/ has no generator to name.
  const plain = run.missingInput(join(repoDir, "tests", "nothing.w3x"), repoDir);
  assert.match(plain, /^no input map at /);
  assert.doesNotMatch(plain, /made by/);
});

test("saving for the pack: an editor left unsaved or a failed terrain rebuild stops the spec", async () => {
  const fake = ({ dirtyAfter = [], settle = async () => {} } = {}) => {
    const tabs = [{ path: "map/a.txt", dirty: true }, { path: "map/b.txt", dirty: false }];
    const w3 = { editors: { saveAll: async () => { for (const t of tabs) t.dirty = dirtyAfter.includes(t.path); return 1; } }, commands: { execute: async (id) => { assert.equal(id, "w3.terrain.settle"); return settle(); } } };
    return [w3, { editors: { tabs } }];
  };
  await run.saveForPack(...fake());
  await assert.rejects(run.saveForPack(...fake({ dirtyAfter: ["map/a.txt"] })), /unsaved changes in map\/a\.txt/);
  await assert.rejects(run.saveForPack(...fake({ settle: async () => { throw new Error("derive failed"); } })), /derived files weren't written: derive failed/);
});

test("parsed compares: a World Editor save the codecs don't give back is ERROR for that file", () => {
  assert.deepEqual(core.verifyOutcome("ok   /w/we.w3x — 17 files, 9 via codecs\n"), {});
  assert.deepEqual(core.verifyOutcome("FAIL /w/we.w3x — mismatched: war3map.w3i, war3map.doo\n"), { mismatched: ["war3map.w3i", "war3map.doo"] });
  assert.deepEqual(core.verifyOutcome("FAIL /w/we.w3x — bad header\n"), { error: "bad header" });
  const files = [
    { file: "war3map.w3i", kind: "parsed", status: "MATCH", count: 0, diffs: [] },
    { file: "war3map.w3e", kind: "w3e", status: "MATCH", count: 0, diffs: [] },
    { file: "war3map.doo", kind: "parsed", status: "MATCH", count: 0, diffs: [] },
  ];
  const r = core.applyRoundtrip(files, { mismatched: ["war3map.w3i", "war3map.w3e"] });
  assert.equal(r[0].status, "ERROR");
  assert.match(r[0].diffs[0].text, /doesn't come back the same/);
  assert.equal(r[1].status, "MATCH", "not a parsed compare");
  assert.equal(r[2].status, "MATCH", "control: a file that round-trips");
  assert.equal(core.runOutcome([{ name: "s", files: r, error: null }]).code, 2);
  assert.ok(core.applyRoundtrip(files, { error: "x" }).filter((f) => f.kind === "parsed").every((f) => f.status === "ERROR"));
  assert.deepEqual(core.applyRoundtrip(files, {}), files, "control: nothing to say");
});

test("the work folder's lock: a lock without a pid yet is live for a grace; a lock taken while taking over a stale one is put back", async () => {
  const work = scratchDir("we-compare-lock2-");
  const file = join(work, "we-compare.lock");
  try {
    // Between another run's create and its write: empty and fresh, so not stale.
    writeFileSync(file, "");
    assert.throws(() => run.lockWork(work), /has no pid yet/);
    // Control: an empty lock older than the grace is a run that died between the two: taken over.
    const old = (Date.now() - 60000) / 1000;
    utimesSync(file, old, old);
    run.lockWork(work)();
    // A stale lock of an ended process, and another run that takes the lock just before the rename: its lock stays.
    const child = spawn(process.execPath, ["-e", ""]);
    await new Promise((ok) => child.on("close", ok));
    writeFileSync(file, String(child.pid));
    const other = spawn(process.execPath, ["-e", "setTimeout(() => {}, 20000)"]);
    try {
      const steal = () => { rmSync(file); writeFileSync(file, String(other.pid)); };
      assert.throws(() => run.lockWork(work, process.pid, { beforeRename: steal }), new RegExp(`another we-compare \\(pid ${other.pid}\\) uses`));
      assert.equal(readFileSync(file, "utf8"), String(other.pid), "the other run's lock is where it was");
      assert.deepEqual(readdirSync(work).filter((n) => n.includes("stale")), [], "nothing left behind");
    } finally { other.kill(); }
  } finally { rmSync(work, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- 13: second review round of 2026-11-17 (fix-we-infra)

const textReader = (text) => ({ has: () => true, listed: () => true, text: () => text, bytes: () => Buffer.from(text), unpackedAs: () => "text" });

test("lines that match nothing in a save are ERROR, not two empty texts that match", () => {
  const e = (lines, as = "text-set") => ({ file: "war3map.j", as, expect: "match", tolerance: 0, ignore: [], lines });
  const we = textReader("call A()\ncall SetDestructableVertexColor(x)\n"), none = textReader("call A()\n");
  const both = core.compareEntry(e("SetDestructableVertexColour"), we, we);
  assert.equal(both.status, "ERROR", "a typo matches nothing on either side");
  assert.match(both.diffs[0].text, /matches no line/);
  assert.equal(core.compareEntry(e("SetDestructableVertexColor", "text"), we, none).status, "ERROR", "one side without the lines");
  assert.equal(runOutcomeOf(both).code, 2);
  // Control: lines both saves have match.
  assert.equal(core.compareEntry(e("SetDestructableVertexColor"), we, we).status, "MATCH");
});

const runOutcomeOf = (f) => core.runOutcome([{ name: "s", files: [f], error: null }]);

test("a text kind on a binary file (NUL bytes) is ERROR: its bytes split at LF compare nothing meaningful", () => {
  const bin = { has: () => true, listed: () => true, text: () => "W3E!\0\0\nab", bytes: () => Buffer.from("W3E!\0\0\nab"), unpackedAs: () => "raw" };
  for (const as of ["text", "text-set", "text-exact"]) {
    const r = core.compareEntry({ file: "war3map.w3e", as, expect: "match", tolerance: 0, ignore: [] }, bin, bin);
    assert.equal(r.status, "ERROR", as);
    assert.match(r.diffs[0].text, /binary.*NUL/);
  }
  // Control: the codecs' text of it (war3map.w3e.txt) compares as text.
  assert.equal(core.compareEntry({ file: "war3map.w3e", as: "text", expect: "match", tolerance: 0, ignore: [] }, textReader("w3e 11\n"), textReader("w3e 11\n")).status, "MATCH");
});

test("tolerance per path: the longest matching pattern wins, default for the rest; the number form is unchanged", () => {
  const we = { camera: { x: 100, y: 100 }, doodads: [{ angle: 1, z: 10 }] }, st = { camera: { x: 103, y: 100.5 }, doodads: [{ angle: 1.5, z: 10.5 }] };
  // One number for all hides the angle (0.5) under the camera's 4.
  assert.equal(diffJson(we, st, 10, 4).count, 0);
  const per = diffJson(we, st, 10, { camera: 4, "doodads[].z": 1, default: 0 });
  assert.deepEqual(per.diffs.map((d) => d.path), ["doodads[0].angle"], "only the angle, outside both patterns, differs");
  // The longer pattern wins over a shorter one that also matches.
  assert.deepEqual(diffJson(we, st, 10, { doodads: 1, "doodads[].z": 0 }).diffs.map((d) => d.path), ["camera.x", "camera.y", "doodads[0].z"]);
  assert.equal(diffJson(we, st, 10, { default: 4 }).count, 0, "default alone is the number form");
  // In a spec: checked; refused on kinds without numbers to compare.
  const ok = parseSpec({ ...good(), compare: [{ file: "war3map.w3c", as: "parsed", tolerance: { "cameras[].x": 4, default: 0.01 } }] }, "/s");
  assert.deepEqual(ok.compare[0].tolerance, { "cameras[].x": 4, default: 0.01 });
  for (const bad of [{}, { a: -1 }, { a: "1" }, [1]]) assert.throws(() => parseSpec({ ...good(), compare: [{ file: "a.doo", as: "parsed", tolerance: bad }] }, "/s"), /tolerance/, JSON.stringify(bad));
  assert.throws(() => parseSpec({ ...good(), compare: [{ file: "a.j", as: "text", tolerance: { a: 1 } }] }, "/s"), /no effect/);
  assert.equal(compareFile("f", "text", { text: "a" }, { text: "a" }, 10, { a: 1 }).status, "ERROR", "compareFile refuses it too");
  // The minimap: an object tolerance still only reaches the block colours.
  const mm = (w, c) => ({ json: { width: w, height: 16, blocks: { "0,0": c } } });
  assert.equal(compareFile("m", "minimap", mm(16, [10, 10, 10]), mm(16, [12, 10, 10]), 10, { default: 3 }).status, "MATCH");
  assert.equal(compareFile("m", "minimap", mm(16, [10, 10, 10]), mm(32, [10, 10, 10]), 10, { default: 30 }).status, "DIFFERS", "control: the size is exact");
});

test("checkoutFiles: the files a --type text or an eval names in the checkouts; a missing one is the spec's error, naming its generator", () => {
  const vars = { REPO: "/r", MAIN: "/m" };
  const raw = {
    ...good(),
    we: { steps: [["--type", "${REPO_WE}\\target\\import-modes\\Rabbit.mdx"], "--type ${MAIN_WE}\\tests\\a b.wav", ["--key", "${REPO}/x"]] },
    studio: { steps: [{ eval: "w3.window.pickFiles = async () => ['${REPO}/target/import-modes/Rabbit.mdx', \"${MAIN}/f/beep.wav\"]; x(`${other}`)" }] },
  };
  const s = parseSpec(raw, "/s", vars);
  assert.deepEqual(s.files.sort(), [join("/m", "f", "beep.wav"), join("/m", "tests", "a"), join("/r", "target", "import-modes", "Rabbit.mdx")].sort());
  // Control: a spec naming no checkout file has none.
  assert.deepEqual(parseSpec(good(), "/s", vars).files, []);
  // A missing helper of target/ names the make-*.mjs that writes it, as a missing input map does.
  const repoDir = resolve(repoPath("tests"), "..");
  const msg = run.missingInput(join(repoDir, "target", "import-modes", "Rabbit.mdx"), repoDir, "file");
  assert.match(msg, /^no file at .*Rabbit\.mdx \(made by node tests\/fixtures\/we-specs\/make-import-modes\.mjs/);
});

test("we options: freshEditor, expectCrash and prefs are checked; prefs key the editor group; an unknown we key is refused", () => {
  const s = parseSpec({ ...good(), we: { freshEditor: true, expectCrash: true, prefs: { Misc: { "Enforce Water Limits": "false", "Undo Limit": 0 } } } }, "/s");
  assert.equal(s.we.freshEditor, true);
  assert.equal(s.we.expectCrash, true);
  assert.deepEqual(s.we.prefs, ["Misc/Enforce Water Limits=false", "Misc/Undo Limit=0"]);
  const plain = parseSpec(good(), "/s");
  assert.deepEqual([plain.we.freshEditor, plain.we.expectCrash, plain.we.prefs], [false, false, []]);
  assert.notEqual(core.weGroupKey(s), core.weGroupKey(plain), "other prefs: another we-drive process");
  assert.equal(core.weGroupKey(parseSpec({ ...good(), we: { freshEditor: true } }, "/s")), core.weGroupKey(plain), "control: freshEditor alone stays in the group (its own editor, same process)");
  assert.notEqual(core.weGroupKey(parseSpec({ ...good(), we: { mode: "hd" } }, "/s")), core.weGroupKey(plain));
  for (const [we, re] of [[{ fresh: true }, /unknown we\.fresh/], [{ freshEditor: "yes" }, /freshEditor is true or false/], [{ prefs: { Misc: "x" } }, /we\.prefs/], [{ prefs: { Misc: { "a=b": "1" } } }, /key name/], [{ prefs: { "a/b": { k: "1" } } }, /section name/], [{ prefs: { Misc: { k: "1\n2" } } }, /one line/]]) {
    assert.throws(() => parseSpec({ ...good(), we }, "/s"), re, JSON.stringify(we));
  }
});

test("weDriveSteps: --close after the last spec, after an expectCrash, before a freshEditor, after each with restart", () => {
  const spec = (name, we = {}) => ({ name, we: { steps: [["--key", "d"]], freshEditor: false, expectCrash: false, ...we } });
  const of = { mapOf: (s) => `${s.name}.w3x`, saveOf: (s) => `${s.name}-we.w3x` };
  const closesAfter = (args) => args.flatMap((a, i) => (a === "--close" ? [args[args.lastIndexOf("--save", i) + 1]] : []));
  assert.deepEqual(closesAfter(core.weDriveSteps([spec("a"), spec("b"), spec("c")], of)), ["c-we.w3x"], "control: one editor for all");
  assert.deepEqual(closesAfter(core.weDriveSteps([spec("a"), spec("b", { freshEditor: true }), spec("c")], of)), ["a-we.w3x", "c-we.w3x"]);
  assert.deepEqual(closesAfter(core.weDriveSteps([spec("a", { expectCrash: true }), spec("b")], of)), ["a-we.w3x", "b-we.w3x"]);
  assert.deepEqual(closesAfter(core.weDriveSteps([spec("a"), spec("b")], { ...of, restart: true })), ["a-we.w3x", "b-we.w3x"]);
  assert.deepEqual(core.weDriveSteps([spec("a")], of), ["--map", "a.w3x", "--wait-ready", "--key", "d", "--save", "a-we.w3x", "--close"]);
});

test("an editor of the wrong layout fails every spec with one message and none is run again; closes are reported", () => {
  const layout = "the editor's main window is at 0,0 1200x700, not 4,30 1352x937";
  const r = core.weOutcome(3, [{ step: "--map" }, { step: "--wait-ready", ready: false, layout }]);
  assert.deepEqual(r.rerun, [], "running the others again would meet the same window");
  for (const e of r.errors) assert.equal(e, `World Editor: ${layout}`);
  // Control: a map that wasn't shown for another reason runs the rest again.
  assert.deepEqual(core.weOutcome(3, [{ step: "--map" }, { step: "--wait-ready", ready: false, dialogs: ["Error"] }]).rerun, [1, 2]);
  const ok = core.weOutcome(2, [{ step: "--map" }, { step: "--save", saved: true }, { step: "--close", closed: true, answered: [] }, { step: "--map" }, { step: "--save", saved: true }, { step: "--close", closed: true, crashed: true }]);
  assert.deepEqual(ok.closes, ["clean", "crashed"]);
});

test("expectCrash: the crash on close is required (its absence is the error); seen, it is a note, not a failure", () => {
  assert.match(core.crashExpectation(true, "clean", null, null).error, /expectCrash: the editor closed without a crash/);
  assert.match(core.crashExpectation(true, null, null, null).error, /wasn't seen closing/);
  const seen = core.crashExpectation(true, "crashed", null, "World Editor: the World Editor crashed while closing");
  assert.equal(seen.error, null);
  assert.match(seen.warning, /as we\.expectCrash says/);
  // Controls: an earlier error stays; without expectCrash nothing changes (a crash stays the warning it was).
  assert.equal(core.crashExpectation(true, "clean", "World Editor: the save didn't finish", null).error, "World Editor: the save didn't finish");
  assert.deepEqual(core.crashExpectation(false, "clean", null, null), { error: null, warning: null });
  assert.deepEqual(core.crashExpectation(false, "crashed", null, "w"), { error: null, warning: "w" });
});
