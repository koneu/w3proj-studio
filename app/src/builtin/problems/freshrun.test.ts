// A Problems run asked for while another is going on reads the files as they are after the ask: a fix
// (add to import list, delete file) re-runs the checks, and joining a run that started before the fix
// showed the fixed problem again. The control joins the same way a run may (callers without a change in
// between share one follow-up run).

import assert from "node:assert/strict";
import { test } from "node:test";
import type { W3Api } from "../../extensions/api";
import type { ProblemsService } from "../../extensions/services";
import { activate } from "./index";

/** `listing`: the project's file list is still read (as right after an open) until it resolves. */
function setup(listing?: Promise<void>) {
  const services = new Map<string, unknown>();
  const none = { dispose() {} };
  // The built-in checks find nothing to work with in this stub and fail alone (one failing check stops no other).
  const w3 = {
    workspace: { project: () => ({ root: "/p", name: "p", manifest: {}, default_output: "" }), files: () => [], filesReady: async () => { await listing; }, onDidChange: () => none },
    settings: { get: () => undefined },
    statusBar: { add: () => ({ text: "", tooltip: "", dispose() {} }) },
    services: { provide: (id: string, impl: unknown) => { services.set(id, impl); return none; } },
    mcp: { registerTool: () => none },
    commands: { register: () => none },
    views: { register: () => none, refresh() {}, show: async () => {} },
    window: { showError() {}, showInfo() {} },
  } as unknown as W3Api;
  activate(w3, { extensionId: "w3.problems", extensionPath: null, subscriptions: [] });
  return services.get("w3.problems") as ProblemsService;
}

test("right after an open a run waits for the whole file list before any check runs", async () => {
  let done!: () => void;
  const service = setup(new Promise<void>((r) => { done = r; }));
  let checked = 0;
  service.registerCheck({ id: "t.listed", title: "listed", async run() { checked++; return []; } });
  const run = service.run();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(checked, 0, "no check judges an incomplete list");
  done();
  await run;
  assert.equal(checked, 1);
});

test("a run asked for during another run starts after the ask and sees the change made in between", async () => {
  const service = setup();
  let file = "unfixed";
  const seen: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  service.registerCheck({
    id: "t.fresh", title: "fresh",
    async run() {
      const read = file; // read at the start of the run, as the checks read their files
      seen.push(read);
      if (seen.length === 1) await gate;
      return [{ severity: "warning", message: read }];
    },
  });
  const first = service.run();
  await new Promise((r) => setTimeout(r, 5));
  file = "fixed"; // the fix, while the first run is still going
  const second = service.run();
  const third = service.run(); // shares the second
  release();
  assert.deepEqual((await first).map((p) => p.message), ["unfixed"]);
  assert.deepEqual((await second).map((p) => p.message), ["fixed"]);
  assert.deepEqual((await third).map((p) => p.message), ["fixed"]);
  assert.deepEqual(seen, ["unfixed", "fixed"], "the second and third ask shared one follow-up run");
  assert.deepEqual(service.problems().map((p) => p.message), ["fixed"]);
});
