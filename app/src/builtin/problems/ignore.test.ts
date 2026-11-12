// The Problems ignore: which reports a file ignores, the file's text (sorted, stable, read back the same),
// a file that is there but unusable (nothing hidden, never written over), the bonus quest library rule, and
// list_problems counting the ignored reports apart.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { W3Api } from "../../extensions/api";
import type { Problem, ProblemCheck, ProblemsService } from "../../extensions/services";
import { BONUS_QUEST_LIBRARY, IGNORE_FILE, aboutOf, emptyIgnore, isIgnored, parseIgnore, questLibraryOffered, serializeIgnore, withIgnored, withoutIgnored } from "./ignore";
import { activate } from "./index";

test("a report is ignored by its check and subject; another check or subject is not", () => {
  const f = withIgnored(emptyIgnore(), "triggerNoEvents", ["Quest A Update1"]);
  assert.equal(isIgnored(f, "triggerNoEvents", "Quest A Update1"), true);
  assert.equal(isIgnored(f, "triggerNoEvents", "Quest A Update2"), false, "control: another trigger");
  assert.equal(isIgnored(f, "triggerValidate", "Quest A Update1"), false, "control: another check");
});

test("the file is sorted with fixed keys and reads back the same, whatever order it was built in", () => {
  const a = withIgnored(withIgnored(emptyIgnore(), "triggerNoEvents", ["b", "a", "a"]), "imports", ["z"]);
  const b = withIgnored(withIgnored(emptyIgnore(), "imports", ["z"]), "triggerNoEvents", ["a", "b"]);
  const text = serializeIgnore({ ...a, rules: [BONUS_QUEST_LIBRARY, BONUS_QUEST_LIBRARY] });
  assert.equal(serializeIgnore(a), serializeIgnore(b));
  assert.deepEqual(parseIgnore(text), { version: 1, rules: [BONUS_QUEST_LIBRARY], items: [{ check: "imports", about: "z" }, { check: "triggerNoEvents", about: "a" }, { check: "triggerNoEvents", about: "b" }] });
  assert.equal(serializeIgnore(parseIgnore(text)), text);
  assert.ok(text.endsWith("\n"));
});

test("a file that isn't an ignore file is refused with the reason, not read as empty", () => {
  for (const bad of ["{ nope", "[]", "null", JSON.stringify({ version: 2, rules: [], items: [] }), JSON.stringify({ version: 1, rules: [1], items: [] }), JSON.stringify({ version: 1, rules: [], items: [{ check: "a" }] }), JSON.stringify({ version: 1, rules: [] })]) {
    assert.throws(() => parseIgnore(bad), Error, bad);
  }
  assert.deepEqual(parseIgnore(JSON.stringify({ version: 1, rules: [], items: [] })), emptyIgnore());
});

test("the quest library rule ignores the quest triggers and nothing else", () => {
  const f = { ...emptyIgnore(), rules: [BONUS_QUEST_LIBRARY] };
  for (const n of ["Quest ThunderHerb Update1", "Quest SinkFleet Discovered", "Quest Standard Completed", "Quest X Failed", "Quest Y Update"]) assert.equal(isIgnored(f, "triggerNoEvents", n), true, n);
  for (const n of ["Transmissions", "Cinematic Revival", "Quest Giver", "My Quest A Completed", "Quest A Completed now"]) assert.equal(isIgnored(f, "triggerNoEvents", n), false, n);
  assert.equal(isIgnored(f, "triggerValidate", "Quest A Completed"), false, "only that check");
  assert.equal(questLibraryOffered(emptyIgnore(), [{ check: "triggerNoEvents", about: "Quest A Completed" }]), true);
  assert.equal(questLibraryOffered(emptyIgnore(), [{ check: "triggerNoEvents", about: "Transmissions" }]), false, "control: other triggers don't offer it");
  assert.equal(questLibraryOffered(f, [{ check: "triggerNoEvents", about: "Quest A Completed" }]), false, "already on");
});

test("un-ignoring one report of the rule keeps the others ignored", () => {
  const f = { ...emptyIgnore(), rules: [BONUS_QUEST_LIBRARY] };
  const g = withoutIgnored(f, "triggerNoEvents", "Quest A Update1", ["Quest A Update1", "Quest A Completed"]);
  assert.equal(isIgnored(g, "triggerNoEvents", "Quest A Update1"), false);
  assert.equal(isIgnored(g, "triggerNoEvents", "Quest A Completed"), true);
  assert.deepEqual(g.rules, []);
});

test("without its own subject a report is named by its location and message", () => {
  assert.equal(aboutOf({ message: "m", location: "l", about: "t" }), "t");
  assert.notEqual(aboutOf({ message: "m", location: "l" }), aboutOf({ message: "m", location: "other" }));
});

/** The extension on an in-memory project: one check reporting `problems`, `files` as the project's files. */
function harness(files: Record<string, string>, problems: Problem[]) {
  const services = new Map<string, unknown>();
  const tools = new Map<string, (args: unknown) => Promise<unknown>>();
  const none = { dispose() {} };
  const writes: string[] = [];
  const w3 = {
    workspace: {
      project: () => ({ root: "/p", name: "p", manifest: {}, default_output: "" }),
      files: () => [],
      resolve: (p: string) => `/p/${p}`,
      readText: async (p: string) => { if (p in files) return files[p]; throw new Error(`no ${p}`); },
      writeText: async (p: string, t: string) => { writes.push(p); files[p] = t; },
      onDidChange: () => none,
    },
    backend: { invoke: async (c: string, a: { path: string }) => { if (c === "fs_exists") return a.path.slice(3) in files; throw new Error(c); } },
    statusBar: { add: () => ({ text: "", tooltip: "", dispose() {} }) },
    services: { provide: (id: string, impl: unknown) => { services.set(id, impl); return none; } },
    mcp: { registerTool: (name: string, f: (args: unknown) => Promise<unknown>) => { tools.set(name, f); return none; } },
    commands: { register: () => none },
    views: { register: () => none, refresh() {}, show: async () => {} },
    window: { showError() {}, showInfo() {} },
    settings: { get: () => undefined },
    game: { list: async () => [], read: async () => { throw new Error("no"); }, readText: async () => { throw new Error("no"); }, resolve: async () => null, resolveMany: async (p: string[]) => p.map(() => null) },
  } as unknown as W3Api;
  activate(w3, { extensionId: "w3.problems", extensionPath: null, subscriptions: [] });
  const service = services.get("w3.problems") as ProblemsService;
  const check: ProblemCheck = { id: "mine", title: "Mine", run: async () => problems };
  service.registerCheck(check);
  const mine = (list: Problem[]) => list.filter((p) => problems.some((q) => q.message === p.message));
  return { service, tools, writes, files, mine };
}

const P = (n: string): Problem => ({ severity: "warning", message: `${n} has no events`, location: n, about: n });

test("list_problems leaves ignored reports out and says how many; the service and Build see only the rest", async () => {
  const text = serializeIgnore(withIgnored(emptyIgnore(), "mine", ["Quest A Completed"]));
  const h = harness({ [IGNORE_FILE]: text }, [P("Quest A Completed"), P("Other")]);
  const listed = await h.tools.get("list_problems")!({}) as (Problem & { ignored?: number })[];
  assert.deepEqual(h.mine(listed).map((p) => p.location), ["Other"]);
  assert.equal(listed.find((p) => p.ignored)?.ignored, 1);
  assert.deepEqual(h.mine(await h.service.run()).map((p) => p.location), ["Other"]);
});

test("control: without an ignore file both reports are listed and nothing says ignored", async () => {
  const h = harness({}, [P("Quest A Completed"), P("Other")]);
  const listed = await h.tools.get("list_problems")!({}) as (Problem & { ignored?: number })[];
  assert.deepEqual(h.mine(listed).map((p) => p.location), ["Quest A Completed", "Other"]);
  assert.equal(listed.some((p) => p.ignored), false);
});

test("an ignore file that is there but broken hides nothing and is not written over", async () => {
  const h = harness({ [IGNORE_FILE]: "{ broken" }, [P("Quest A Completed")]);
  const listed = await h.tools.get("list_problems")!({}) as Problem[];
  assert.deepEqual(h.mine(listed).map((p) => p.location), ["Quest A Completed"]);
  assert.deepEqual(h.writes, []);
});
