// The project's [checks] section in w3proj.toml: what it reads, a section that is there but unusable (nothing is
// switched off), and the Problems service not running a disabled check.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { W3Api } from "../../extensions/api";
import type { Problem, ProblemsService } from "../../extensions/services";
import { addDisabled, isDisabled, parseChecksConfig, readChecksConfig } from "./checkconfig";
import { activate } from "./index";

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
  assert.equal(isDisabled({ disable: ["melee/camps"] }, "melee/camps"), true);
  assert.equal(isDisabled({ disable: ["melee/camps"] }, "melee/mines"), false);
  assert.equal(isDisabled({ disable: ["melee"] }, "melee/mines"), true);
  assert.equal(isDisabled({ disable: ["melee"] }, "imports"), false);
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

test("the quick action refuses an unreadable manifest and a project without one, and writes nothing", async () => {
  const bad = '[checks]\ndisable = "mine-a"\n';
  const h = harness({ "w3proj.toml": bad }, ["mine-a"]);
  await assert.rejects(async () => h.cmds.get("w3.problems.disableCheck")!("mine-a"), /\[checks\]/);
  assert.equal(h.files["w3proj.toml"], bad);
  const none = harness({}, ["mine-a"]);
  await assert.rejects(async () => none.cmds.get("w3.problems.disableCheck")!("mine-a"), /no w3proj\.toml/);
  assert.deepEqual(none.files, {}, "no file was created");
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
