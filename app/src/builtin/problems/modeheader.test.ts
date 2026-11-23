// The Problems view's header names the graphics mode of the last run (a run under another mode says another).

import assert from "node:assert/strict";
import { test } from "node:test";
import type { W3Api } from "../../extensions/api";
import { activate } from "./index";

/** Just enough DOM for the view's `h` helper: every element keeps its text and children. */
class Fake {
  className = ""; style: Record<string, string> = {}; children: (Fake | string)[] = [];
  constructor(public tag: string) {}
  append(...c: (Fake | string)[]) { this.children.push(...c); }
  setAttribute() {}
  addEventListener() {}
  get textContent(): string { return this.children.map((c) => (typeof c === "string" ? c : c.textContent)).join(""); }
  find(cls: string): Fake | null {
    if (this.className.split(" ").includes(cls)) return this;
    for (const c of this.children) if (typeof c !== "string") { const f = c.find(cls); if (f) return f; }
    return null;
  }
}

test("the header shows the graphics mode the last run used, and nothing before a run", async () => {
  const g = globalThis as Record<string, unknown>;
  g.document = { createElement: (t: string) => new Fake(t), createTextNode: (s: string) => s };
  try {
    let mode = "sd";
    let view!: { render(el: unknown): void };
    const none = { dispose() {} };
    const w3 = {
      workspace: { project: () => ({ root: "/p", name: "p", manifest: {}, default_output: "" }), files: () => [], unreadable: () => [], filesReady: async () => {}, onDidChange: () => none },
      settings: { get: (k: string) => (k === "game.graphicsMode" ? mode : undefined) },
      statusBar: { add: () => ({ text: "", tooltip: "", dispose() {} }) },
      services: { provide: () => none },
      mcp: { registerTool: () => none },
      commands: { register: () => none },
      views: { register: (_id: string, v: typeof view) => { view = v; return none; }, refresh() {}, show: async () => {} },
      window: { showError() {}, showInfo() {} },
      backend: { invoke: async () => false },
    } as unknown as W3Api;
    const services = new Map<string, { run(): Promise<unknown> }>();
    (w3.services as { provide: unknown }).provide = (id: string, impl: { run(): Promise<unknown> }) => { services.set(id, impl); return none; };
    activate(w3, { extensionId: "w3.problems", extensionPath: null, subscriptions: [] });
    const draw = () => { const el = new Fake("div"); view.render(el); return el.find("problems-mode")?.textContent ?? null; };
    assert.equal(draw(), null, "no run yet");
    await services.get("w3.problems")!.run();
    assert.equal(draw(), "Graphics mode: sd");
    mode = "hd";
    assert.equal(draw(), "Graphics mode: sd", "the header names the run's mode, not the setting now");
    await services.get("w3.problems")!.run();
    assert.equal(draw(), "Graphics mode: hd");
  } finally { delete g.document; }
});
