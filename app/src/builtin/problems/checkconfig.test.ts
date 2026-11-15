// The project's [checks] section in w3proj.toml: what it reads, a section that is there but unusable (nothing is
// switched off), and the Problems service not running a disabled check.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { W3Api } from "../../extensions/api";
import type { Problem, ProblemsService } from "../../extensions/services";
import { isDisabled, parseChecksConfig, readChecksConfig } from "./checkconfig";
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
  const services = new Map<string, unknown>();
  const none = { dispose() {} };
  const w3 = {
    workspace: {
      project: () => ({ root: "/p", name: "p", manifest: {}, default_output: "" }), files: () => [], filesReady: async () => {}, unreadable: () => [],
      resolve: (p: string) => `/p/${p}`,
      readText: async (p: string) => { if (p in files) return files[p]; throw new Error(`no ${p}`); },
      writeText: async () => {}, onDidChange: () => none,
    },
    backend: { invoke: async (c: string, a: { path: string }) => { if (c === "fs_exists") return a.path.slice(3) in files; throw new Error(c); } },
    statusBar: { add: () => ({ text: "", tooltip: "", dispose() {} }) },
    services: { provide: (id: string, impl: unknown) => { services.set(id, impl); return none; } },
    mcp: { registerTool: () => none }, commands: { register: () => none }, views: { register: () => none, refresh() {}, show: async () => {} },
    window: { showError() {}, showInfo() {} }, settings: { get: () => undefined },
    game: { list: async () => [], read: async () => { throw new Error("no"); }, readText: async () => { throw new Error("no"); }, resolve: async () => null, resolveMany: async (p: string[]) => p.map(() => null) },
  } as unknown as W3Api;
  activate(w3, { extensionId: "w3.problems", extensionPath: null, subscriptions: [] });
  const service = services.get("w3.problems") as ProblemsService;
  const ran: string[] = [];
  for (const id of ids) service.registerCheck({ id, title: id, run: async () => { ran.push(id); return [{ severity: "warning", message: `${id} found`, location: id } as Problem]; } });
  return { service, ran };
}

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
