// The project's [checks] section in w3proj.toml: what it reads, a section that is there but unusable (nothing is
// switched off), and the Problems service not running a disabled check.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { W3Api } from "../../extensions/api";
import type { Problem, ProblemsService } from "../../extensions/services";
import { MINIMAL_MANIFEST, addDisabled, meleeMode, meleeToolRefusal, setMelee, applySeverity, disabledIds, isDisabled, severityOverride, parseChecksConfig, readChecksConfig } from "./checkconfig";
import { blocksPacking, countProblems, describeCounts } from "../../lib/problemcount";
import { activate } from "./index";
import { readFixture } from "../../lib/testhelpers/testutil";

test("disable lists are read from [checks] only, with comments, single quotes and several lines", () => {
  const toml = `format = 1\ndisable = ["wrong"]\n[map]\nname = "x" # disable\n\n[checks]\n# why\ndisable = [\n  "imports", # slow\n  'melee/camps',\n]\n\n[pack]\noutput = "o"\ndisable = ["also-wrong"]\n`;
  assert.deepEqual(parseChecksConfig(toml).disable, ["imports", "melee/camps"]);
  assert.deepEqual(parseChecksConfig("format = 1\n").disable, [], "control: no section, nothing off");
  assert.deepEqual(parseChecksConfig('[checks]\ndisable = []\n').disable, []);
  assert.deepEqual(parseChecksConfig('[checks]\r\ndisable = ["a"]\r\n').disable, ["a"]);
});

test("a [checks] section that can't be read is an error, not an empty list", async () => {
  for (const bad of ['[checks]\ndisable = "imports"\n', '[checks]\ndisable = ["a", 3]\n', '[checks]\ndisable = ["a"\n', "[checks]\nnonsense\n"]) {
    assert.throws(() => parseChecksConfig(bad), Error, bad);
    const r = await readChecksConfig(async () => bad, async () => true);
    assert.deepEqual(r.config.disable, []);
    assert.match(r.error ?? "", /w3proj\.toml can't be used for its \[checks\]/, bad);
  }
  const absent = await readChecksConfig(async () => { throw new Error("x"); }, async () => false);
  assert.equal(absent.error, null, "control: no manifest is no error");
});

test("a melee rule is switched off by its own id or by melee", () => {
  assert.equal(isDisabled({ disable: ["melee/camps"], severity: {}, melee: "auto" }, "melee/camps"), true);
  assert.equal(isDisabled({ disable: ["melee/camps"], severity: {}, melee: "auto" }, "melee/mines"), false);
  assert.equal(isDisabled({ disable: ["melee"], severity: {}, melee: "auto" }, "melee/mines"), true);
  assert.equal(isDisabled({ disable: ["melee"], severity: {}, melee: "auto" }, "imports"), false);
});

function harness(files: Record<string, string>, ids: string[]) {
  const cmds = new Map<string, (...a: unknown[]) => unknown>();
  const services = new Map<string, unknown>();
  const none = { dispose() {} };
  const w3 = {
    workspace: {
      project: () => ({ root: "/p", name: "p", manifest: {}, default_output: "" }), files: () => [], filesReady: async () => {}, unreadable: () => [],
      resolve: (p: string) => `/p/${p}`,
      readText: async (p: string) => { if (p in files) return files[p]; throw new Error(`no ${p}`); },
      writeText: async (p: string, t: string) => { files[p] = t; }, onDidChange: () => none,
    },
    backend: { invoke: async (c: string, a: { path: string }) => { if (c === "fs_exists") return a.path.slice(3) in files; throw new Error(c); } },
    statusBar: { add: () => ({ text: "", tooltip: "", dispose() {} }) },
    services: { provide: (id: string, impl: unknown) => { services.set(id, impl); return none; } },
    mcp: { registerTool: () => none }, commands: { register: (id: string, f: (...a: unknown[]) => unknown) => { cmds.set(id, f); return none; } }, views: { register: () => none, refresh() {}, show: async () => {} },
    window: { showError() {}, showInfo() {} }, settings: { get: () => undefined },
    game: { list: async () => [], read: async () => { throw new Error("no"); }, readText: async () => { throw new Error("no"); }, resolve: async () => null, resolveMany: async (p: string[]) => p.map(() => null) },
  } as unknown as W3Api;
  activate(w3, { extensionId: "w3.problems", extensionPath: null, subscriptions: [] });
  const service = services.get("w3.problems") as ProblemsService;
  const ran: string[] = [];
  for (const id of ids) service.registerCheck({ id, title: id, run: async () => { ran.push(id); return [{ severity: "warning", message: `${id} found`, location: id } as Problem]; } });
  return { service, ran, cmds, files };
}

test("addDisabled: creates the section, the key, or extends the list; everything else stays byte for byte", () => {
  assert.equal(addDisabled("format = 1\n", "imports"), 'format = 1\n\n[checks]\ndisable = ["imports"]\n');
  assert.equal(addDisabled("format = 1", "a"), 'format = 1\n\n[checks]\ndisable = ["a"]\n');
  assert.equal(addDisabled("", "a"), '[checks]\ndisable = ["a"]\n');
  assert.equal(addDisabled('[checks]\n# note\n\n[pack]\nx = 1\n', "a"), '[checks]\ndisable = ["a"]\n# note\n\n[pack]\nx = 1\n', "section without disable");
  assert.equal(addDisabled('[checks]\r\n[pack]\r\n', "a"), '[checks]\r\ndisable = ["a"]\r\n[pack]\r\n');
  assert.equal(addDisabled('[checks]\ndisable = []  # none\n', "a"), '[checks]\ndisable = ["a"]  # none\n');
  assert.equal(addDisabled('a = 1\n[checks]\ndisable = ["x"] # why\nb = 2\n', "y"), 'a = 1\n[checks]\ndisable = ["x", "y"] # why\nb = 2\n', "comment on the same line");
  assert.equal(addDisabled('[checks]\ndisable = ["x",]\n', "y"), '[checks]\ndisable = ["x","y", ]\n', "trailing comma");
  const multi = '[checks]\n# top\ndisable = [\n  "imports", # slow\n  \'melee/camps\' # last\n]\n[pack]\n';
  assert.equal(addDisabled(multi, "z"), '[checks]\n# top\ndisable = [\n  "imports", # slow\n  \'melee/camps\', # last\n  "z",\n]\n[pack]\n');
  const trailing = '[checks]\ndisable = [\n  "a",\n]\n';
  assert.equal(addDisabled(trailing, "b"), '[checks]\ndisable = [\n  "a",\n  "b",\n]\n');
  assert.equal(addDisabled('[checks]\ndisable = ["a"]\n', 'we"ird'), '[checks]\ndisable = ["a", "we\\"ird"]\n');
  for (const t of [multi, trailing, 'x = 1\n[checks]\ndisable = ["a", "b"]\n']) assert.deepEqual(parseChecksConfig(addDisabled(t, "n")).disable.at(-1), "n", "the result reads back");
});

test("addDisabled: an id already listed isn't added twice; text the parser refuses throws", () => {
  const t = '[checks]\ndisable = ["a", "b"] # keep\n';
  assert.equal(addDisabled(t, "b"), t);
  assert.notEqual(addDisabled(t, "c"), t, "control: a new id changes the text");
  for (const bad of ['[checks]\ndisable = "imports"\n', '[checks]\ndisable = ["a"\n', "[checks]\nnonsense\n"]) assert.throws(() => addDisabled(bad, "x"), Error, bad);
});

test("the quick action writes the id into w3proj.toml and checks again, so the check is gone", async () => {
  const toml = 'format = 1 # keep\n\n[checks]\ndisable = ["mine-a"] # why\n';
  const h = harness({ "w3proj.toml": toml }, ["mine-a", "mine-b", "mine-c"]);
  assert.deepEqual((await h.service.runChecked()).checks.map((c) => c.id).filter((i) => i.startsWith("mine")), ["mine-b", "mine-c"]);
  await h.cmds.get("w3.problems.disableCheck")!("mine-b");
  assert.equal(h.files["w3proj.toml"], 'format = 1 # keep\n\n[checks]\ndisable = ["mine-a", "mine-b"] # why\n');
  assert.deepEqual(h.service.problems().map((p) => p.location), ["mine-c"], "re-run: the check's findings are gone");
});

test("the quick action refuses an unreadable manifest and writes nothing", async () => {
  const bad = '[checks]\ndisable = "mine-a"\n';
  const h = harness({ "w3proj.toml": bad }, ["mine-a"]);
  await assert.rejects(async () => h.cmds.get("w3.problems.disableCheck")!("mine-a"), /\[checks\]/);
  assert.equal(h.files["w3proj.toml"], bad);
});

test("a project without a w3proj.toml gets a minimal one: the same text the Rust side loads (fixture)", async () => {
  const none = harness({}, ["mine-a", "mine-b"]);
  await none.service.runChecked();
  await none.cmds.get("w3.problems.disableCheck")!("mine-a");
  assert.equal(none.files["w3proj.toml"], 'format = 1\n\n[checks]\ndisable = ["mine-a"]\n');
  assert.deepEqual(parseChecksConfig(none.files["w3proj.toml"]).disable, ["mine-a"]);
  assert.deepEqual(none.service.problems().map((p) => p.location), ["mine-b"], "re-run: the check is gone");
  const fixture = readFixture("manifest-minimal-checks", "w3proj.toml");
  assert.equal(addDisabled(MINIMAL_MANIFEST, "imports"), fixture, "the fixture crates/w3proj loads is what the app writes");
});

test("the service doesn't run a check the project disabled, and says which; the others run", async () => {
  const h = harness({ "w3proj.toml": 'format = 1\n[checks]\ndisable = ["mine-a"]\n' }, ["mine-a", "mine-b"]);
  const r = await h.service.runChecked();
  assert.deepEqual(h.ran, ["mine-b"]);
  assert.deepEqual(r.disabled, ["mine-a"]);
  assert.equal(r.configError, null);
  assert.deepEqual(r.checks.map((c) => c.id).filter((i) => i.startsWith("mine")), ["mine-b"]);
});

test("control: without [checks] every check runs; a broken [checks] runs them all and says why", async () => {
  const a = harness({ "w3proj.toml": "format = 1\n" }, ["mine-a", "mine-b"]);
  assert.deepEqual((await a.service.runChecked()).disabled, []);
  assert.deepEqual(a.ran, ["mine-a", "mine-b"]);
  const b = harness({ "w3proj.toml": '[checks]\ndisable = "mine-a"\n' }, ["mine-a", "mine-b"]);
  const r = await b.service.runChecked();
  assert.deepEqual(b.ran, ["mine-a", "mine-b"]);
  assert.match(r.configError ?? "", /\[checks\]/);
});

test("[checks.severity] sets a check's severity; off acts as disable; melee rules fall back to melee", () => {
  const toml = `format = 1\n[checks]\ndisable = ["a"]\n\n[checks.severity]\n# why\nimports = "warning"  # soft\n"melee/camps" = 'error'\nmelee = "warning"\nslow = "off"\n\n[pack]\nimports = "error"\n`;
  const c = parseChecksConfig(toml);
  assert.deepEqual(c.disable, ["a"], "the disable list still works next to it");
  assert.deepEqual(c.severity, { imports: "warning", "melee/camps": "error", melee: "warning", slow: "off" });
  assert.equal(applySeverity(c, "imports", "error"), "warning");
  assert.equal(applySeverity(c, "other", "error"), "error", "control: no override keeps the severity");
  assert.equal(applySeverity(c, "melee/camps", "warning"), "error", "a rule's own entry wins");
  assert.equal(applySeverity(c, "melee/tech", "error"), "warning", "else the one of melee");
  assert.equal(severityOverride(c, "other"), undefined);
  assert.ok(isDisabled(c, "slow") && isDisabled(c, "a") && !isDisabled(c, "imports"));
  assert.deepEqual(disabledIds(c), ["a", "slow"]);
  assert.deepEqual(parseChecksConfig("format = 1\n").severity, {}, "control");
});

test("a [checks.severity] that can't be read is an error and nothing is overridden", async () => {
  for (const bad of ['[checks.severity]\nimports = "fatal"\n', '[checks.severity]\nimports = 3\n', "[checks.severity]\nnonsense\n", '[checks]\nseverity = { imports = "warning" }\n']) {
    assert.throws(() => parseChecksConfig(bad), Error, bad);
    const r = await readChecksConfig(async () => bad, async () => true);
    assert.deepEqual(r.config.severity, {});
    assert.match(r.error ?? "", /can't be used for its \[checks\]/, bad);
  }
});

test("addDisabled leaves a [checks.severity] table alone", () => {
  const toml = '[checks.severity]\nimports = "warning"\n';
  const out = addDisabled(toml, "x");
  assert.ok(out.startsWith(toml));
  const c = parseChecksConfig(out);
  assert.deepEqual(c.disable, ["x"]);
  assert.deepEqual(c.severity, { imports: "warning" });
  const both = addDisabled('[checks]\ndisable = ["a"]\n[checks.severity]\nimports = "warning"\n', "b");
  assert.deepEqual(parseChecksConfig(both).severity, { imports: "warning" });
  assert.deepEqual(parseChecksConfig(both).disable, ["a", "b"]);
});

test("the Problems service reports a check at the severity the project sets, and off checks aren't run", async () => {
  const toml = 'format = 1\n[checks.severity]\nmine-a = "error"\nmine-b = "off"\n';
  const h = harness({ "w3proj.toml": toml }, ["mine-a", "mine-b", "mine-c"]);
  const r = await h.service.runChecked();
  const sev = (id: string) => r.checks.find((c) => c.id === id)?.problems.map((p) => p.severity);
  assert.deepEqual(sev("mine-a"), ["error"], "raised to error");
  assert.deepEqual(sev("mine-c"), ["warning"], "control: untouched check keeps its severity");
  assert.equal(sev("mine-b"), undefined, "off: not run");
  assert.deepEqual(h.ran.sort(), ["mine-a", "mine-c"]);
  assert.deepEqual(r.disabled, ["mine-b"]);
});

test("[checks.severity] accepts info: parsed, applied over error and warning, and named in the error text", () => {
  const c = parseChecksConfig('format = 1\n[checks.severity]\nimports = "info"\n"melee/camps" = "warning"\n');
  assert.deepEqual(c.severity, { imports: "info", "melee/camps": "warning" });
  assert.equal(applySeverity(c, "imports", "error"), "info");
  assert.equal(applySeverity(c, "imports", "warning"), "info");
  assert.equal(applySeverity(c, "other", "warning"), "warning", "control: no override keeps it");
  assert.ok(!isDisabled(c, "imports"), "info still runs");
  assert.throws(() => parseChecksConfig('[checks.severity]\nimports = "fatal"\n'), /isn't one of error, warning, info, off/);
  assert.throws(() => parseChecksConfig("[checks.severity]\nnonsense\n"), /"error" \| "warning" \| "info" \| "off"/);
});

test("the Problems service keeps an info finding as info", async () => {
  const h = harness({ "w3proj.toml": 'format = 1\n[checks.severity]\nmine-a = "info"\n' }, ["mine-a", "mine-c"]);
  const r = await h.service.runChecked();
  assert.deepEqual(r.checks.find((c) => c.id === "mine-a")?.problems.map((p) => p.severity), ["info"]);
  assert.deepEqual(r.checks.find((c) => c.id === "mine-c")?.problems.map((p) => p.severity), ["warning"], "control");
});

test("info findings are neither errors nor warnings and don't block packing", () => {
  const infos = countProblems([{ severity: "info" }, { severity: "info" }]);
  assert.deepEqual(infos, { errors: 0, warnings: 0, infos: 2 });
  assert.equal(blocksPacking(infos), false);
  assert.equal(blocksPacking(countProblems([{ severity: "info" }, { severity: "warning" }])), false);
  assert.equal(blocksPacking(countProblems([{ severity: "info" }, { severity: "error" }])), true, "control: an error blocks");
  assert.equal(describeCounts(infos), "0 errors, 0 warnings, 2 infos");
  assert.equal(describeCounts(countProblems([{ severity: "warning" }])), "0 errors, 1 warning");
});

test("[checks] melee is read as on, off or auto; absent is auto; anything else is an error", () => {
  for (const m of ["on", "off", "auto"]) assert.equal(parseChecksConfig(`[checks]\nmelee = "${m}" # why\n`).melee, m);
  assert.equal(parseChecksConfig("[checks]\nmelee = 'off'\n").melee, "off", "single quotes");
  assert.equal(parseChecksConfig('[checks]\ndisable = ["a"]\n').melee, "auto", "control: absent");
  assert.equal(parseChecksConfig('melee = "off"\n[pack]\nmelee = "off"\n').melee, "auto", "only [checks] counts");
  for (const bad of ['[checks]\nmelee = true\n', '[checks]\nmelee = "yes"\n', '[checks]\nmelee = on\n']) assert.throws(() => parseChecksConfig(bad), /melee/, bad);
});

test("the melee decision: --melee, then --only=melee, then the manifest; auto looks at the Melee flag", () => {
  const d = (force: "on" | "off" | "auto" | null, asked: boolean, setting: "on" | "off" | "auto") => meleeMode({ force, asked, setting }).mode;
  assert.equal(d(null, false, "auto"), "flag", "today's behaviour");
  assert.equal(d(null, false, "on"), "on");
  assert.equal(d(null, false, "off"), "off");
  assert.equal(d(null, true, "auto"), "on", "--only=melee forces on");
  assert.equal(d(null, true, "off"), "on", "asked by name beats the manifest");
  assert.equal(d("off", true, "on"), "off", "--melee beats everything");
  assert.equal(d("on", false, "off"), "on");
  assert.equal(d("auto", true, "off"), "flag");
});

test("setMelee writes the line in place, creates the section, and auto removes it; the rest stays byte for byte", () => {
  assert.equal(setMelee("format = 1\n", "on"), 'format = 1\n\n[checks]\nmelee = "on"\n');
  assert.equal(setMelee('[checks]\ndisable = ["a"]\n[pack]\nx = 1\n', "off"), '[checks]\ndisable = ["a"]\nmelee = "off"\n[pack]\nx = 1\n');
  assert.equal(setMelee('[checks]\r\nmelee = "on" # keep\r\ndisable = []\r\n', "off"), '[checks]\r\nmelee = "off" # keep\r\ndisable = []\r\n');
  assert.equal(setMelee('[checks]\nmelee = "on"\ndisable = ["a"]\n', "auto"), '[checks]\ndisable = ["a"]\n');
  assert.equal(setMelee("format = 1\n", "auto"), "format = 1\n", "control: nothing to remove");
  for (const v of ["on", "off", "auto"] as const) assert.equal(parseChecksConfig(setMelee('[checks]\nmelee = "off"\n', v)).melee, v, "reads back");
  assert.throws(() => setMelee('[checks]\nmelee = "x"\n', "on"), /melee/);
});

test("the Problems command writes [checks] melee and refuses an unreadable manifest", async () => {
  const h = harness({ "w3proj.toml": 'format = 1\n' }, ["mine-a"]);
  await h.cmds.get("w3.problems.setMelee")!("off");
  assert.equal(h.files["w3proj.toml"], 'format = 1\n\n[checks]\nmelee = "off"\n');
  await h.cmds.get("w3.problems.setMelee")!("auto");
  assert.equal(h.files["w3proj.toml"], "format = 1\n\n[checks]\n");
  await assert.rejects(async () => h.cmds.get("w3.problems.setMelee")!("sometimes"), /isn't on, off or auto/);
  const bad = harness({ "w3proj.toml": '[checks]\nmelee = "x"\n' }, []);
  await assert.rejects(async () => bad.cmds.get("w3.problems.setMelee")!("on"), /\[checks\]/);
  assert.equal(bad.files["w3proj.toml"], '[checks]\nmelee = "x"\n');
});

test("check_melee's gate follows [checks] melee: off refuses naming the setting, on and auto run", async () => {
  const gate = async (toml: string | null) => meleeToolRefusal(await readChecksConfig(async () => toml ?? "", async () => toml !== null));
  assert.match((await gate('[checks]\nmelee = "off"\n')) ?? "", /switched off.*\[checks\] melee = off/);
  assert.equal(await gate('[checks]\nmelee = "on"\n'), null);
  assert.equal(await gate('[checks]\nmelee = "auto"\n'), null);
  assert.equal(await gate(null), null, "no manifest is auto");
  assert.match((await gate('[checks]\nmelee = "maybe"\n')) ?? "", /can't be used/, "unreadable refuses, it isn't taken as auto");
});
